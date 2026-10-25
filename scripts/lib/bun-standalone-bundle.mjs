/**
 * Bundle from the staging root so Bun's chunk identities use relocatable paths.
 * The dedicated builder keeps this cwd for consumers of relative metafile inputs.
 * @template {{root: string}} Options
 * @template Result
 * @param {Options} options
 * @param {(options: Options) => Promise<Result>} build
 * @returns {Promise<Result>}
 */
export function bundleStandaloneModules(options, build) {
  process.chdir(options.root);
  return build(options);
}
