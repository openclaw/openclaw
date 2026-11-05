/**
 * Omit only reviewed, unchanged inputs from the conventional directory fallback.
 * Explicit owners and import consumers are added independently by the caller.
 * @param {string[]} changedPaths
 * @param {(roots: string[]) => string | null} fingerprint
 * @param {{common: string[], commonHash: string, tests: Record<string, string>}} qualification
 */
export function createAdaptiveMarkdownFilter(changedPaths, fingerprint, qualification) {
  const eligible =
    changedPaths.length > 0 &&
    changedPaths.every(
      (file) => /^packages\/markdown-core\/src\/[^/]+\.ts$/u.test(file) && !file.includes(".test"),
    );
  const commonUnchanged =
    eligible && fingerprint(qualification.common) === qualification.commonHash;
  /** @param {string[]} owners */
  return (owners) =>
    commonUnchanged
      ? owners.filter((file) => {
          const hash = qualification.tests[file];
          return !hash || fingerprint([file]) !== hash;
        })
      : owners;
}
