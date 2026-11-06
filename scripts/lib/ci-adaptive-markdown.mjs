import { isTestLineAllocationPath } from "./changed-path-facts.mjs";

/**
 * Omit only reviewed, unchanged inputs from the conventional directory fallback.
 * Explicit owners and import consumers are added independently by the caller.
 * @param {string[]} changedPaths
 * @param {(roots: string[]) => string | null} fingerprint
 * @param {{common: string[], commonHash: string, tests: Record<string, string>}} qualification
 * @param {(file: string) => boolean} isIndependentCompanion
 */
export function createAdaptiveMarkdownFilter(
  changedPaths,
  fingerprint,
  qualification,
  isIndependentCompanion = () => false,
) {
  /** @param {string} file */
  const isMarkdownSource = (file) =>
    /^packages\/markdown-core\/src\/[^/]+\.ts$/u.test(file) &&
    !file.includes(".test") &&
    !file.includes(".spec");
  const eligible =
    changedPaths.some(isMarkdownSource) &&
    changedPaths.every(
      (file) =>
        isMarkdownSource(file) || isTestLineAllocationPath(file) || isIndependentCompanion(file),
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
