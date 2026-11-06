import { lstatSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Keep the two independent Python skill suites separate on ordinary PRs.
 * Shared, missing and unrecognized inputs keep the complete suite.
 * @param {string[] | null} changedPaths
 * @param {{ cwd?: string, full?: boolean }} [options]
 * @returns {string[]}
 */
export function resolveSkillsPythonTargets(
  changedPaths,
  { cwd = process.cwd(), full = false } = {},
) {
  const paths = changedPaths?.filter((file) => file.startsWith("skills/"));
  if (full || !paths?.length || paths.length !== changedPaths?.length) {
    return ["skills"];
  }
  const owners = new Set();
  for (const file of paths) {
    const match = /^skills\/(model-usage|skill-creator)\/scripts\/[^/]+\.py$/u.exec(file);
    if (!match || !lstatSync(resolve(cwd, file), { throwIfNoEntry: false })?.isFile()) {
      return ["skills"];
    }
    owners.add(`skills/${match[1]}`);
  }
  return [...owners].sort();
}
