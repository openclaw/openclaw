import type { CompactNodeTestShard } from "./ci-node-test-plan.mts";

export const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
export const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
export const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
export const TOOLING_CONFIG = "test/vitest/vitest.tooling.config.ts";
export const TOOLING_LARGE_CAPACITY_TEST_FILES = new Set([
  // Generation-retention cases require eight CPUs / 24 GiB; the two-CPU
  // screen also peaked at 6.05 GiB before those gated cases could run.
  "test/scripts/vitest-worker-artifacts.ci.test.ts",
  "test/scripts/write-unified-entry-dts.test.ts",
  "test/scripts/write-plugin-sdk-entry-dts.test.ts",
]);

function canUseSerialTooling16Runner(job: CompactNodeTestShard, runnerBackend?: string) {
  return (
    (runnerBackend ?? "blacksmith") === "blacksmith" &&
    job.runner === EXTRA_LARGE_NODE_TEST_RUNNER &&
    job.planConcurrency === 1 &&
    !job.requiresDist &&
    !job.pretestBuildMode &&
    job.groups.length > 0 &&
    job.groups.every(
      (group) =>
        group.configs.length === 1 &&
        group.configs[0] === TOOLING_CONFIG &&
        [BUNDLED_NODE_TEST_RUNNER, DEFAULT_NODE_TEST_RUNNER].includes(group.runner) &&
        group.minTotalMemoryBytes === undefined &&
        !group.requiresDist &&
        !group.pretestBuildMode &&
        group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2" &&
        group.includePatterns &&
        group.includePatterns.length > 0 &&
        group.includePatterns.every((file) => !TOOLING_LARGE_CAPACITY_TEST_FILES.has(file)),
    )
  );
}

export function resolveCompactNodeTestRunner(
  job: CompactNodeTestShard,
  runnerBackend: string | undefined,
  usesNativeCapacity: boolean,
) {
  if (canUseSerialTooling16Runner(job, runnerBackend)) {
    return "blacksmith-16vcpu-ubuntu-2404";
  }
  // The 4/8 classes both deliver two CPUs. Keep the original placement anchors.
  return usesNativeCapacity && job.runner === BUNDLED_NODE_TEST_RUNNER
    ? DEFAULT_NODE_TEST_RUNNER
    : job.runner;
}
