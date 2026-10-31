/** @param {string} source */
export function bundledModuleRegions(source) {
  // Stable releases use regions. Rolldown 1.2.15 uses qualified module-ID labels;
  // recognize one qualified token, not arbitrary plain line comments.
  return source.matchAll(/^\/\/(?:#region | (?=\S+\/\S+$))(.+)$/gm);
}

/**
 * @param {string} source
 * @param {string} owner
 */
export function findBundledModuleRegion(source, owner) {
  const regions = [...bundledModuleRegions(source)];
  const index = regions.findIndex((region) => region[1] === owner);
  const region = regions[index];
  if (!region) {
    return undefined;
  }
  const next = regions[index + 1]?.index ?? source.length;
  const closing = source.indexOf("\n//#endregion", region.index + region[0].length);
  return {
    start: region.index,
    end: closing >= 0 && closing < next ? closing + 1 : next,
    label: region[0],
  };
}
