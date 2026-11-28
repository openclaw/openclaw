import { lstatSync } from "node:fs";
import path from "node:path";
import {
  getChangedPathFacts,
  isTestLineAllocationPath,
  isTestOnlyPath,
} from "./changed-path-facts.mjs";

/**
 * Omit only reviewed, unchanged inputs from the conventional directory fallback.
 * Explicit owners and import consumers are added independently by the caller.
 * @param {string[]} changedPaths
 * @param {(roots: string[]) => string | null} fingerprint
 * @param {{common: string[], commonHash: string, tests: Record<string, string>}} qualification
 * @param {(file: string) => boolean} isIndependentCompanion
 * @param {string} cwd
 */
export function createAdaptiveMarkdownFilter(
  changedPaths,
  fingerprint,
  qualification,
  isIndependentCompanion = () => false,
  cwd = process.cwd(),
) {
  /** @param {string} file */
  const isMarkdownSource = (file) =>
    /^packages\/markdown-core\/src\/[^/]+\.ts$/u.test(file) &&
    !file.includes(".test") &&
    !file.includes(".spec");
  /** @param {string} file */
  const isProductionCompanion = (file) => {
    const facts = getChangedPathFacts(file);
    return (
      ["source", "extension", "package"].includes(facts.surface) &&
      /\.[cm]?[jt]sx?$/u.test(file) &&
      !facts.isChangedLaneTest &&
      !facts.isTestOnly &&
      !isTestOnlyPath(file) &&
      !/(?:^|\/)(?:__fixtures__|fixtures|scripts|test-fixtures|test-utils|test-helpers|test-support|testing)\//u.test(
        file,
      ) &&
      !/\.(?:config|setup|d)\.[cm]?[jt]sx?$/u.test(file) &&
      lstatSync(path.resolve(cwd, file), { throwIfNoEntry: false })?.isFile() === true
    );
  };
  const eligible =
    changedPaths.some(isMarkdownSource) &&
    changedPaths.every(
      (file) =>
        isMarkdownSource(file) ||
        isTestLineAllocationPath(file) ||
        isProductionCompanion(file) ||
        isIndependentCompanion(file),
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
