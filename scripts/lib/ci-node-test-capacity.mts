import type { CompactNodeTestShard, NodeTestShard } from "./ci-node-test-plan.mts";
import {
  createCompactSplitTimingGeneration,
  parseCompactSplitTimingKey,
} from "./vitest-shard-metadata.mts";

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
const BOAT_PREPARED_COMPILER_TEST_FILES = new Set([
  "test/scripts/run-vitest-bounded.test.ts",
  "test/scripts/run-vitest-state-cleanup.test.ts",
  "test/scripts/vitest-worker-artifacts.test.ts",
  "test/scripts/test-projects-empty-native.test.ts",
]);

export function resolveBoatNodeTestCapacity(
  runner: string,
  checkName?: string,
  minTotalMemoryBytes = 0,
  files: readonly string[] = [],
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
  // Prepared compiler fixtures build the application graph before their tests.
  if (
    capacity.runner === "boat" &&
    (minTotalMemoryBytes > 8 * 1024 ** 3 ||
      files.some((file) => BOAT_PREPARED_COMPILER_TEST_FILES.has(file)))
  ) {
    return { ...capacity, runner: "boat-large" };
  }
  return capacity;
}

const BOAT_HOSTED_PREPARED_WORKSPACE = "src/node-host/node-worker-prepared-workspace.test.ts";

function splitBoatHostedWorkspace<
  T extends Pick<NodeTestShard, "configs" | "includePatterns" | "env" | "timing_key"> & {
    targets?: string[];
  },
>(plan: T, shardName: string): { retained?: T; hosted: T } | undefined {
  const files = plan.includePatterns ?? plan.targets;
  const field = plan.includePatterns ? "includePatterns" : "targets";
  if (!files?.includes(BOAT_HOSTED_PREPARED_WORKSPACE)) {
    return undefined;
  }
  const retained = files.filter((file) => file !== BOAT_HOSTED_PREPARED_WORKSPACE);
  if (retained.length === 0) {
    return { hosted: plan };
  }
  const hosted = [BOAT_HOSTED_PREPARED_WORKSPACE];
  const { timingKeys } = createCompactSplitTimingGeneration({
    configs: plan.configs,
    env: plan.env,
    parentShardName:
      parseCompactSplitTimingKey(plan.timing_key ?? "")?.parentShardName ?? shardName,
    stripes: [retained, hosted],
  });
  return {
    retained: { ...plan, [field]: retained, timing_key: timingKeys[0]! },
    hosted: { ...plan, [field]: hosted, timing_key: timingKeys[1]! },
  };
}

// Map only final jobs: group runners remain logical placement/timing identities.
export function routeBoatNodeTestJobs<
  T extends Omit<NodeTestShard, "configs"> & { configs?: string[]; targets?: string[] },
>(jobs: T[], jobCap?: number): T[] {
  const routed = jobs.flatMap((job): T[] => {
    const capacity = resolveBoatNodeTestCapacity(
      job.runner,
      job.checkName,
      Math.max(0, ...(job.groups ?? []).map((group) => group.minTotalMemoryBytes ?? 0)),
      [
        ...(job.includePatterns ?? []),
        ...(job.groups ?? []).flatMap((group) => group.includePatterns ?? []),
      ],
    );
    const physical = capacity ? { ...job, ...capacity } : job;
    const hosted = (subset: T): T => ({
      ...subset,
      checkName: `${job.checkName}-prepared-workspace-hosted`,
      shardName: `${job.shardName}-prepared-workspace-hosted`,
      runner: "ubuntu-24.04",
      planConcurrency: 1,
      env: {
        ...job.env,
        OPENCLAW_VITEST_MAX_WORKERS: String(
          Math.min(2, Number(job.env?.OPENCLAW_VITEST_MAX_WORKERS ?? 2)),
        ),
      },
      // No measured cost exists for the extracted hosted allocation. Retained
      // Boat rows keep their conservative parent estimate, as RunsOn extraction does.
      predictedSeconds: undefined,
      predictedTestSeconds: undefined,
    });
    if (job.groups) {
      const hostedGroups: NonNullable<T["groups"]> = [];
      const retained = job.groups.flatMap((group) => {
        const split = splitBoatHostedWorkspace(group, group.shard_name);
        if (!split) {
          return [group];
        }
        hostedGroups.push(split.hosted);
        return split.retained ? [split.retained] : [];
      });
      return hostedGroups.length === 0
        ? [physical]
        : [
            ...(retained.length ? [{ ...physical, groups: retained }] : []),
            hosted({ ...physical, groups: hostedGroups }),
          ];
    }
    const split =
      job.configs && splitBoatHostedWorkspace({ ...physical, configs: job.configs }, job.shardName);
    return split ? [...(split.retained ? [split.retained] : []), hosted(split.hosted)] : [physical];
  });
  if (jobCap !== undefined && routed.length > jobCap) {
    throw new Error(`Boat node test plan exceeds ${jobCap} jobs (${routed.length} planned)`);
  }
  return routed;
}
