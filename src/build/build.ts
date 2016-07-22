/**
 * @license
 * Copyright (c) 2016 The Polymer Project Authors. All rights reserved.
 * This code may only be used under the BSD style license found at http://polymer.github.io/LICENSE.txt
 * The complete set of authors may be found at http://polymer.github.io/AUTHORS.txt
 * The complete set of contributors may be found at http://polymer.github.io/CONTRIBUTORS.txt
 * Code distributed by Google as part of the polymer project is also
 * subject to an additional IP rights grant found at http://polymer.github.io/PATENTS.txt
 */

import clone = require('clone');
import * as fs from 'fs';
import * as gulp from 'gulp';
import * as gulpif from 'gulp-if';
import * as gutil from 'gulp-util';
import mergeStream = require('merge-stream');
import * as path from 'path';
import {PassThrough, Readable} from 'stream';
import * as logging from 'plylog';
import {PolymerProject, forkStream} from 'polymer-build';

const uglify = require('gulp-uglify');
const cssSlam = require('css-slam').gulp;
const htmlmin = require('gulp-html-minifier');

import {ProjectConfig} from '../project-config';
import {PrefetchTransform} from './prefetch';
import {waitFor} from './streams';
import {generateServiceWorker, parsePreCacheConfig, SWConfig} from './sw-precache';

let logger = logging.getLogger('cli.build.build');

export interface BuildOptions {
  sources?: string[];
  includeDependencies?: string[];
  swPrecacheConfig?: string;
  insertDependencyLinks?: boolean;
  // TODO(fks) 07-21-2016: Fully complete these with available options
  html?: {
    collapseWhitespace?: boolean;
    removeComments?: boolean;
  };
  css?: {
    stripWhitespace?: boolean;
  };
  js?: {
    minify?: boolean;
  };
}

export function build(options?: BuildOptions, config?: ProjectConfig): Promise<any> {
  return new Promise<any>((buildResolve, _) => {
    let polymerProject = new PolymerProject({
      root: config.root,
      shell: config.shell,
      entrypoint: config.entrypoint,
      fragments: config.fragments,
      sourceGlobs: options.sources,
      includeDependencies: options.includeDependencies,
    });

    if (options.insertDependencyLinks) {
      logger.debug(`Additional dependency links will be inserted into application`);
    }

    // mix in optimization options from build command
    // TODO: let this be set by the user
    let optimizeOptions = {
      html: Object.assign({removeComments: true}, options.html),
      css: Object.assign({stripWhitespace: true}, options.css),
      js: Object.assign({minify: true}, options.js),
    };

    logger.info(`Building application...`);

    logger.debug(`Reading source files...`);
    let sourcesStream = polymerProject.sources()
      .pipe(polymerProject.splitHtml())
      .pipe(gulpif(/\.js$/, uglify(optimizeOptions.js)))
      .pipe(gulpif(/\.css$/, cssSlam(optimizeOptions.css)))
      .pipe(gulpif(/\.html$/, htmlmin(optimizeOptions.html)))
      .pipe(polymerProject.rejoinHtml());

    logger.debug(`Reading dependencies...`);
    let depsStream = polymerProject.dependencies()
      .pipe(polymerProject.splitHtml())
      .pipe(polymerProject.rejoinHtml());

    let buildStream = mergeStream(sourcesStream, depsStream)
      .once('data', () => { logger.debug('Analyzing build dependencies...'); })
      .pipe(polymerProject.analyze);

    let serviceWorkerName = 'service-worker.js';

    let unbundledPhase = forkStream(buildStream)
      .once('data', () => { logger.info('Generating build/unbundled...'); })
      .pipe(
        gulpif(
          options.insertDependencyLinks,
          new PrefetchTransform(polymerProject.root, polymerProject.entrypoint,
            polymerProject.shell, polymerProject.fragments,
            polymerProject.analyze)
        )
      )
      .pipe(gulp.dest('build/unbundled'));

    let bundledPhase = forkStream(buildStream)
      .once('data', () => { logger.info('Generating build/bundled...'); })
      .pipe(polymerProject.bundle)
      .pipe(gulp.dest('build/bundled'));

    let swPrecacheConfig = path.resolve(polymerProject.root, options.swPrecacheConfig || 'sw-precache-config.js');

    return Promise.all([
      parsePreCacheConfig(swPrecacheConfig),
      waitFor(unbundledPhase),
      waitFor(bundledPhase),
    ]).then((results) => {
      let swConfig: SWConfig = results[0];

      if (swConfig) {
        logger.debug(`Service worker config found`, swConfig);
      } else {
        logger.debug(`No service worker configuration found at ${swPrecacheConfig}, continuing with defaults`);
      }

      logger.info(`Generating service workers...`);
      return Promise.all([
        polymerProject.addServiceWorker('build/unbundled', {
          swConfig: swConfig,
        }),
        polymerProject.addServiceWorker('build/bundled', {
          swConfig: swConfig,
          bundled: true,
        })
      ]);
    })
    .then(() => {
      logger.info('Build complete!');
      buildResolve();
    });

  });
}
