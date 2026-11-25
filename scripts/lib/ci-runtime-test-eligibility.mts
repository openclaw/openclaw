import { statSync } from "node:fs";
import { resolve } from "node:path";
import {
  resolveAffectedTestsFromImportGraph,
  resolveChangedTestTargetPlan,
} from "../test-projects.test-support.mts";
import { resolvePolicyTestTargets } from "./ci-policy-test-watch.mts";
import { isPrExemptRuntimeTestFile, isReleaseOnlyRuntimeTestFile } from "./ci-test-tier-policy.mts";

export type RuntimeTestSelection = {
  changedPaths?: readonly string[];
  includeReleaseOnlyRuntimeTests?: boolean;
  includePrExemptRuntimeTests?: boolean;
};

const prExemptChangedTargets = new WeakMap<readonly string[], Map<string, ReadonlySet<string>>>();

function resolvePrExemptChangedTargets(changedPaths: readonly string[], cwd: string) {
  let byCwd = prExemptChangedTargets.get(changedPaths);
  const cached = byCwd?.get(cwd);
  if (cached) {
    return cached;
  }
  const paths = [...changedPaths];
  // Explicit source owners cover spawned processes and filename readers;
  // transitive imports cover subjects reached through shared integration fixtures.
  const targets = new Set(
    [
      ...resolvePolicyTestTargets(paths, { cwd }),
      ...resolveChangedTestTargetPlan(paths, {
        broad: false,
        combineSiblingWithImportGraph: true,
        cwd,
        forceFullImportGraph: true,
        includeExtensionImpact: false,
        resolveAliases: true,
        runtimeOnly: true,
      }).targets,
      ...resolveAffectedTestsFromImportGraph(paths, cwd, {
        tooling: true,
        forceFull: true,
        resolveAliases: true,
        runtimeOnly: true,
      }),
    ].filter(isPrExemptRuntimeTestFile),
  );
  if (!byCwd) {
    byCwd = new Map();
    prExemptChangedTargets.set(changedPaths, byCwd);
  }
  byCwd.set(cwd, targets);
  return targets;
}

export function isRuntimeTestFileIncluded(
  file: string,
  options: RuntimeTestSelection,
  cwd = process.cwd(),
): boolean {
  const releaseOnly =
    options.includeReleaseOnlyRuntimeTests === false && isReleaseOnlyRuntimeTestFile(file);
  const prExempt = options.includePrExemptRuntimeTests === false && isPrExemptRuntimeTestFile(file);
  if (!releaseOnly && !prExempt) {
    return true;
  }
  if (statSync(resolve(cwd, file), { throwIfNoEntry: false })?.isFile() !== true) {
    return false;
  }
  const changedPaths = options.changedPaths ?? [];
  if (changedPaths.includes(file)) {
    return true;
  }
  return (
    !releaseOnly &&
    changedPaths.length > 0 &&
    resolvePrExemptChangedTargets(changedPaths, cwd).has(file)
  );
}
