import type { CompactNodeTestShard, NodeTestShard } from "./ci-node-test-plan.mts";

export const DEFAULT_NODE_TEST_RUNNER = "blacksmith-8vcpu-ubuntu-2404";
export const BUNDLED_NODE_TEST_RUNNER = "blacksmith-4vcpu-ubuntu-2404";
export const EXTRA_LARGE_NODE_TEST_RUNNER = "blacksmith-32vcpu-ubuntu-2404";
export const TOOLING_CONFIG = "test/vitest/vitest.tooling.config.ts";
const SERIAL_SELECTED_16_CONFIGS = new Set([
  "test/vitest/vitest.cli.config.ts",
  "test/vitest/vitest.gateway-client.config.ts",
  "test/vitest/vitest.gateway-server.config.ts",
  "test/vitest/vitest.agents-embedded-agent.config.ts",
]);
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

export function resolveSelectedNodeTestRunner(
  job: CompactNodeTestShard,
  runnerBackend: string | undefined,
) {
  // Two selected files cannot use the full owner's wider worker allowance.
  // Apply after packing so the capacity cut does not change process placement.
  return ["blacksmith", "hybrid"].includes(runnerBackend ?? "blacksmith") &&
    job.runner === EXTRA_LARGE_NODE_TEST_RUNNER &&
    job.planConcurrency === 1 &&
    !job.requiresDist &&
    !job.pretestBuildMode &&
    job.groups.length > 0 &&
    job.groups.every((group) => {
      const isQualifiedBoardStore =
        job.groups.length === 1 &&
        group.configs[0] === "test/vitest/vitest.gateway-database-workers.config.ts" &&
        group.includePatterns?.length === 1 &&
        group.includePatterns[0] === "src/gateway/board-store.test.ts" &&
        group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2" &&
        group.fallbackMaxWorkers === 2 &&
        group.minTotalMemoryBytes === 28 * 1024 ** 3;
      return (
        group.configs.length === 1 &&
        (isQualifiedBoardStore ||
          SERIAL_SELECTED_16_CONFIGS.has(group.configs[0]!) ||
          (group.configs[0] === "test/vitest/vitest.unit-fast-isolated.config.ts" &&
            group.includePatterns?.length === 1 &&
            group.includePatterns[0] ===
              "src/agents/embedded-agent-runner/run/attempt.llm-boundary.cache-stability.test.ts") ||
          (group.includePatterns?.length === 1 &&
            ((group.configs[0] === "test/vitest/vitest.gateway-core.config.ts" &&
              group.includePatterns[0] === "src/gateway/mcp-app-extension-runtime.test.ts") ||
              (group.configs[0] === "test/vitest/vitest.agents-core.config.ts" &&
                group.includePatterns[0] === "src/agents/cli-runner.helpers.test.ts")))) &&
        [BUNDLED_NODE_TEST_RUNNER, DEFAULT_NODE_TEST_RUNNER].includes(group.runner) &&
        (group.env?.OPENCLAW_VITEST_MAX_WORKERS === "2" ||
          (group.env?.OPENCLAW_VITEST_MAX_WORKERS === undefined &&
            group.fallbackMaxWorkers === 2)) &&
        (group.minTotalMemoryBytes === undefined || isQualifiedBoardStore) &&
        !group.requiresDist &&
        !group.pretestBuildMode &&
        group.includePatterns !== undefined &&
        group.includePatterns.length > 0 &&
        group.includePatterns.length <= 2
      );
    })
    ? "blacksmith-16vcpu-ubuntu-2404"
    : job.runner;
}

const BOAT_NODE_TEST_CAPACITY: Record<string, { runner: string; cpuBudget: number }> = {
  "blacksmith-4vcpu-ubuntu-2404": { runner: "boat", cpuBudget: 2 },
  "blacksmith-8vcpu-ubuntu-2404": { runner: "boat", cpuBudget: 2 },
  "blacksmith-16vcpu-ubuntu-2404": { runner: "boat-large", cpuBudget: 4 },
  "blacksmith-32vcpu-ubuntu-2404": { runner: "boat-xlarge", cpuBudget: 8 },
};

export function resolveBoatNodeTestCapacity(
  runner: string,
  checkName?: string,
  minTotalMemoryBytes = 0,
) {
  // These rows already receive the 16-class physical runner in the workflow.
  const promotedRunner =
    runner === DEFAULT_NODE_TEST_RUNNER &&
    (checkName === "checks-node-compact-large-9" || checkName === "checks-node-compact-large-5")
      ? "blacksmith-16vcpu-ubuntu-2404"
      : runner;
  const capacity = BOAT_NODE_TEST_CAPACITY[promotedRunner];
  if (!capacity) {
    return undefined;
  }
  // Physical memory can grow without widening the logical test concurrency.
  if (minTotalMemoryBytes > 16 * 1024 ** 3) {
    return { ...capacity, runner: "boat-xlarge" };
  }
  if (minTotalMemoryBytes > 8 * 1024 ** 3 && capacity.runner === "boat") {
    return { ...capacity, runner: "boat-large" };
  }
  return capacity;
}

// Map only final jobs: group runners remain logical placement/timing identities.
export function routeBoatNodeTestJobs<
  T extends Pick<NodeTestShard, "runner" | "checkName" | "groups">,
>(jobs: T[]): T[] {
  return jobs.map((job) => {
    const capacity = resolveBoatNodeTestCapacity(
      job.runner,
      job.checkName,
      Math.max(0, ...(job.groups ?? []).map((group) => group.minTotalMemoryBytes ?? 0)),
    );
    return capacity ? { ...job, ...capacity } : job;
  });
}
