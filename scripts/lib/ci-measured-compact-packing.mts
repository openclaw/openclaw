import { createHash } from "node:crypto";
import { measuredParallelGroupSeconds } from "./ci-measured-parallel-timings.mts";
import { measuredSerialGroupSeconds } from "./ci-measured-serial-timings.mts";
import type { CompactNodeTestShard, NodeTestShardGroup } from "./ci-node-test-plan.mts";
import { mergeVitestPretestBuildModes } from "./vitest-build-prerequisites.mts";
import { VITEST_PRETEST_BUILD_SECONDS } from "./vitest-shard-metadata.mts";

// Native no-build rows reached 103s outside tests, plus up to 6s between children.
export const COMPACT_JOB_OVERHEAD_SECONDS = 110;
const MAX_PACKED_JOB_SECONDS = 720;

// Complete serial BS8/two-worker child observations from 35702479645,
// 35702772380, 35707408465 and native Testbox run 35722202780.
// Failed children are not successful wall samples.
const TOOLING_WALLS: Record<string, { fingerprint: string; seconds: number }> = {
  "core-tooling-1": {
    fingerprint: "cc58959ec5a174f28b70f4d5da588926b0a5304826dc91e0be424211ff9f63fe",
    seconds: 193,
  },
  "core-tooling-2": {
    fingerprint: "b9abf19c69cc96ef8c3a5d067d99a9166418a505678d5b7afb33c625c2aa1e91",
    seconds: 123,
  },
  "core-tooling-3": {
    fingerprint: "011e6f71982b1963c86b542ab81c6d6f7eedd0f728ca5bdb530857024b05a7b4",
    seconds: 161,
  },
  "core-tooling-4": {
    fingerprint: "bf341b52dd5e5ec871a4d74d00e56c9140e79297044e1e8cc423d262769d5ad2",
    seconds: 88,
  },
  "core-tooling-5": {
    fingerprint: "474e29d440551fc73c2ad678c0fe470d8abeba4845ae3549d16954a96851e756",
    seconds: 218,
  },
  "core-tooling-6-hosted-1": {
    fingerprint: "373b9786c112b6c04404ad91dfb9fdcfd4937bc13d98a479a89e60ec64e2f193",
    seconds: 147,
  },
  "core-tooling-7-hosted-1": {
    fingerprint: "4467f572a71b2e57c331390f6f6ae264f318c7819cd1d9e0a43f4b7ab6a6c0f1",
    seconds: 276,
  },
  "core-tooling-12-hosted-1": {
    fingerprint: "890d8fe7c947c68c4527d77211309fe5121f8be0962e067163e9da534a68ac28",
    seconds: 141,
  },
  "core-tooling-13-hosted-2": {
    fingerprint: "78e44fe31b1d3804d8a2fff1088a73713e3950b404987df826c63b4712fe717b",
    seconds: 351,
  },
  "core-tooling-12-hosted-2": {
    fingerprint: "c88b8bb3e584135e5e7c00472eeaf048f7aee028cde2db8d43907ff8736281a9",
    seconds: 149,
  },
  "core-tooling-13-hosted-1": {
    fingerprint: "9d67f308be60ae19e07eed77ae295950ca7b63def537f73d11d99ac854c58067",
    seconds: 102,
  },
};

type SerialTailPair = {
  config: string;
  children: Array<{
    fingerprint: string;
    seconds: number;
    pretest?: { mode: NonNullable<NodeTestShardGroup["pretestBuildMode"]>; seconds: number };
  }>;
};

const SERIAL_TAIL_PAIRS: SerialTailPair[] = [
  {
    config: "test/vitest/vitest.cli-process.config.ts",
    children: [
      {
        fingerprint: "87825138f6f00ec44cf80bb03fb5035a5cfeb2bf77ce0a63562d8df8e266d108",
        seconds: 498,
      },
      {
        fingerprint: "33425ecc4656211a0e2d108078497b0c71810484426e6f671a1f1c6d0e5d07ce",
        seconds: 643,
      },
    ],
  },
  {
    config: "test/vitest/vitest.tooling.config.ts",
    children: [
      {
        fingerprint: "4be0076eea5e784cb981767b8c59a1b8120c22f0b432495d9a7c1ca09ba66c74",
        seconds: 55,
        pretest: { mode: "runtime", seconds: 120 },
      },
      {
        fingerprint: "e81aadf38a0bef63298b8443123136c79f96ae4f1f669e61d0c4e858aadf6ecb",
        seconds: 406,
      },
    ],
  },

  {
    config: "test/vitest/vitest.tooling.config.ts",
    children: [
      {
        fingerprint: "ac3b33e1ddb668d8ef271d960b06d087e3711069b3ecabab2e5aa536f4d8ac93",
        seconds: 328,
      },
      {
        fingerprint: "85d073a801fa873b7196f05434888aef0aceb5eff3d4bf7632645b4a32adbc15",
        seconds: 638,
      },
    ],
  },
];

function serialTwoWorkerJob(
  job: CompactNodeTestShard,
  runner: string,
  allowBuild = false,
): boolean {
  return (
    job.runner === runner &&
    job.planConcurrency === 1 &&
    !job.requiresDist &&
    (!job.pretestBuildMode || allowBuild) &&
    Object.entries(job.env ?? {}).every(
      ([key, value]) => key === "OPENCLAW_VITEST_MAX_WORKERS" && value === "2",
    ) &&
    job.groups.every(
      (group) =>
        !group.requiresDist &&
        (!group.pretestBuildMode || allowBuild) &&
        group.fallbackMaxWorkers === undefined &&
        group.minTotalMemoryBytes === undefined,
    )
  );
}

function executedGroupFingerprint(group: NodeTestShardGroup): string {
  // Parent timing generations can change when a sibling changes. Only the
  // executed child contract owns this observation; preserve selector order.
  return createHash("sha256")
    .update(
      JSON.stringify({
        configs: group.configs,
        env: Object.fromEntries(
          Object.entries(group.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
        includePatterns: group.includePatterns,
        shard_name: group.shard_name,
        ...(group.pretestBuildMode ? { pretestBuildMode: group.pretestBuildMode } : {}),
      }),
    )
    .digest("hex");
}

function toolingWall(group: NodeTestShardGroup): number | undefined {
  const observation = TOOLING_WALLS[group.shard_name];
  if (!observation || !group.includePatterns?.length) {
    return undefined;
  }
  return executedGroupFingerprint(group) === observation.fingerprint
    ? observation.seconds
    : undefined;
}

function isNumberedToolingGroup(group: NodeTestShardGroup): boolean {
  return (
    /^core-tooling-\d+(?:-hosted-\d+)?$/u.test(group.shard_name) &&
    group.configs.length === 1 &&
    group.configs[0] === "test/vitest/vitest.tooling.config.ts" &&
    Boolean(group.includePatterns?.length) &&
    Object.entries(group.env ?? {}).every(
      ([key, value]) => key === "OPENCLAW_VITEST_MAX_WORKERS" && value === "2",
    )
  );
}

function executedCompactGroupFingerprint(
  job: CompactNodeTestShard,
  group: NodeTestShardGroup,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        runner: job.runner,
        env: Object.fromEntries(
          Object.entries(job.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
        group: {
          fingerprint: executedGroupFingerprint(group),
          fallbackMaxWorkers: group.fallbackMaxWorkers,
          minTotalMemoryBytes: group.minTotalMemoryBytes,
        },
      }),
    )
    .digest("hex");
}

export function getMeasuredCompactGroupSeconds(
  job: CompactNodeTestShard,
  group: NodeTestShardGroup,
  compactMode: "push" | "pull-request",
): number | undefined {
  const timings =
    job.planConcurrency === 1
      ? measuredSerialGroupSeconds
      : job.planConcurrency === 2
        ? measuredParallelGroupSeconds
        : undefined;
  return timings?.[compactMode][executedCompactGroupFingerprint(job, group)];
}

function packMeasuredSerialJobs(
  jobs: CompactNodeTestShard[],
  options: {
    runner: string;
    largeRunner?: string;
    compactMode?: "push" | "pull-request";
    estimateSerialGroup?: (group: NodeTestShardGroup) => number;
  },
): CompactNodeTestShard[] {
  const compactMode = options.compactMode;
  if (!compactMode) {
    return jobs;
  }
  const maxJobSeconds = compactMode === "push" ? 720 : 600;
  type PricedGroup = { group: NodeTestShardGroup; seconds: number };
  const pools = new Map<
    string,
    {
      jobs: CompactNodeTestShard[];
      groups: PricedGroup[];
      env?: Record<string, string>;
      overBudget: boolean;
    }
  >();
  const predictions = new Map<CompactNodeTestShard, number>();
  for (const job of jobs) {
    if (
      job.planConcurrency !== 1 ||
      job.requiresDist ||
      job.pretestBuildMode ||
      ![options.runner, options.largeRunner].includes(job.runner) ||
      job.groups.some((group) => group.requiresDist || group.pretestBuildMode)
    ) {
      continue;
    }
    const transferWorkerCap =
      job.env?.OPENCLAW_VITEST_MAX_WORKERS === "2" && Object.keys(job.env).length === 1;
    const priced = job.groups.flatMap((group) => {
      const nativeSeconds = getMeasuredCompactGroupSeconds(job, group, compactMode);
      const canonicalSeconds =
        job.runner === options.largeRunner ? options.estimateSerialGroup?.(group) : undefined;
      // New files reshuffle complete stripes. Retain the canonical estimator
      // with pricing headroom instead of requiring an old selector generation.
      const seconds =
        nativeSeconds ??
        (canonicalSeconds === undefined ? undefined : Math.ceil(canonicalSeconds * 1.25) + 2);
      return seconds === undefined
        ? []
        : [
            {
              group: transferWorkerCap
                ? {
                    ...group,
                    env: {
                      ...group.env,
                      OPENCLAW_VITEST_MAX_WORKERS: String(
                        Math.min(2, Number(group.env?.OPENCLAW_VITEST_MAX_WORKERS ?? 2)),
                      ),
                    },
                  }
                : group,
              seconds,
            },
          ];
    });
    if (priced.length !== job.groups.length) {
      continue;
    }
    const predictedSeconds = priced.reduce(
      (seconds, group) => seconds + group.seconds,
      COMPACT_JOB_OVERHEAD_SECONDS,
    );
    predictions.set(job, predictedSeconds);
    if (priced.some(({ seconds }) => seconds + COMPACT_JOB_OVERHEAD_SECONDS > maxJobSeconds)) {
      continue;
    }
    // A two-worker row can share a default-capacity host after each child
    // carries that same ceiling. Other environment overrides stay separate.
    const env = transferWorkerCap ? undefined : job.env;
    const key = JSON.stringify([job.runner, env]);
    const pool = pools.get(key) ?? { jobs: [], groups: [], env, overBudget: false };
    pool.jobs.push(job);
    pool.groups.push(...priced);
    pool.overBudget ||= predictedSeconds > maxJobSeconds;
    pools.set(key, pool);
  }
  const replacements = new Map<CompactNodeTestShard, CompactNodeTestShard>();
  const retired = new Set<CompactNodeTestShard>();
  for (const pool of pools.values()) {
    const bins: Array<{ groups: NodeTestShardGroup[]; seconds: number }> = [];
    for (const { group, seconds } of pool.groups.toSorted(
      (a, b) => b.seconds - a.seconds || a.group.shard_name.localeCompare(b.group.shard_name),
    )) {
      const bin = bins.find(
        (candidate) => candidate.seconds + seconds + COMPACT_JOB_OVERHEAD_SECONDS <= maxJobSeconds,
      );
      if (bin) {
        bin.groups.push(group);
        bin.seconds += seconds;
      } else {
        bins.push({ groups: [group], seconds });
      }
    }
    if (bins.length > pool.jobs.length || (bins.length === pool.jobs.length && !pool.overBudget)) {
      continue;
    }
    // Mixed whole-config and selected-file rows keep the shortest existing
    // deadline. Packing must never extend a child's execution allowance.
    const timeoutMinutes = pool.jobs.every((job) => job.timeoutMinutes === undefined)
      ? undefined
      : Math.min(...pool.jobs.map((job) => job.timeoutMinutes ?? 60));
    pool.jobs.forEach((job, index) => {
      const bin = bins[index];
      if (!bin) {
        retired.add(job);
      } else {
        replacements.set(job, {
          ...job,
          groups: bin.groups,
          env: pool.env,
          timeoutMinutes,
          predictedSeconds: bin.seconds + COMPACT_JOB_OVERHEAD_SECONDS,
        });
      }
    });
  }
  return jobs
    .filter((job) => !retired.has(job))
    .map((job) => {
      const replacement = replacements.get(job);
      if (replacement) {
        return replacement;
      }
      const predictedSeconds = predictions.get(job);
      return predictedSeconds === undefined ? job : Object.assign({}, job, { predictedSeconds });
    });
}

/** Reuse measured serial placement without replacing the general capacity-pricing owner. */
export function rebalanceMeasuredHybridJobs(
  jobs: CompactNodeTestShard[],
  options: {
    runner: string;
    largeRunner?: string;
    compactMode?: "push" | "pull-request";
    estimateSerialGroup?: (group: NodeTestShardGroup) => number;
    estimateGroup: (group: NodeTestShardGroup) => { seconds: number; complete: boolean };
    canShare: (groups: NodeTestShardGroup[]) => boolean;
  },
): CompactNodeTestShard[] {
  const maxPackedJobSeconds = options.compactMode === "pull-request" ? 600 : MAX_PACKED_JOB_SECONDS;
  const finish = (result: CompactNodeTestShard[]) => packMeasuredSerialJobs(result, options);
  const split = jobs.flatMap((job) => {
    if (
      job.groups.length < 2 ||
      !serialTwoWorkerJob(job, options.runner, true) ||
      job.pretestBuildMode !==
        mergeVitestPretestBuildModes(job.groups.map((group) => group.pretestBuildMode))
    ) {
      return [job];
    }
    const observations = job.groups.map(
      (group) =>
        SERIAL_TAIL_PAIRS.flatMap((pair) =>
          pair.children.filter(
            (child) =>
              executedGroupFingerprint(group) === child.fingerprint &&
              group.pretestBuildMode === child.pretest?.mode &&
              group.configs.length === 1 &&
              group.configs[0] === pair.config &&
              Object.entries(group.env ?? {}).every(
                ([name, value]) => name === "OPENCLAW_VITEST_MAX_WORKERS" && value === "2",
              ),
          ),
        )[0],
    );
    const pair = SERIAL_TAIL_PAIRS.find(
      ({ children }) =>
        children.length === job.groups.length &&
        children.every((child) => observations.includes(child)),
    );
    const tooling = job.groups.every(isNumberedToolingGroup);
    const nativeSeconds = job.groups.map(
      (group, index) => observations[index]?.seconds ?? (tooling ? toolingWall(group) : undefined),
    );
    const seconds = job.groups.map((group, index) =>
      Math.max(nativeSeconds[index] ?? 0, tooling ? options.estimateGroup(group).seconds : 0),
    );
    const buildSeconds = job.groups.map((group, index) =>
      group.pretestBuildMode
        ? Math.max(
            VITEST_PRETEST_BUILD_SECONDS[group.pretestBuildMode],
            observations[index]?.pretest?.seconds ?? 0,
          )
        : 0,
    );
    const completeWall =
      Math.max(
        job.predictedSeconds ?? 0,
        (nativeSeconds.every((value) => value !== undefined)
          ? nativeSeconds.reduce<number>((sum, value) => sum + value!, 0)
          : seconds.reduce((sum, value) => sum + value, 0)) + Math.max(...buildSeconds),
      ) + COMPACT_JOB_OVERHEAD_SECONDS;
    // Complete child walls identify existing tails more directly than summed
    // file estimates. Packing still retains the higher canonical price below.
    if (!pair && (!tooling || completeWall <= maxPackedJobSeconds)) {
      return [job];
    }
    return job.groups.map((group, index) => ({
      ...job,
      checkName:
        index === 0 ? job.checkName : `${job.checkName}-tail${index === 1 ? "" : `-${index + 1}`}`,
      shardName:
        index === 0 ? job.shardName : `${job.shardName}-tail${index === 1 ? "" : `-${index + 1}`}`,
      groups: [group],
      pretestBuildMode: group.pretestBuildMode,
      predictedSeconds: Math.max(
        job.predictedSeconds ?? 0,
        seconds[index]! + buildSeconds[index]! + COMPACT_JOB_OVERHEAD_SECONDS,
      ),
    }));
  });

  const originalJobs = new Set(jobs);
  const measured = split.flatMap((job) => {
    if (
      !originalJobs.has(job) ||
      !serialTwoWorkerJob(job, options.runner) ||
      !job.groups.every(isNumberedToolingGroup)
    ) {
      return [];
    }
    const prices = job.groups.map((group) => {
      const estimate = options.estimateGroup(group);
      const observed = toolingWall(group);
      return {
        seconds: Math.max(estimate.seconds, observed ?? 0),
        complete: estimate.complete || observed !== undefined,
      };
    });
    return [
      {
        job,
        complete: prices.every((price) => price.complete),
        seconds: Math.max(
          job.predictedSeconds ?? 0,
          prices.reduce((sum, price) => sum + price.seconds, 0),
        ),
      },
    ];
  });
  const priced = new Map(
    measured.map(({ job, seconds }) => [
      job,
      {
        ...job,
        predictedSeconds: Math.ceil(seconds + COMPACT_JOB_OVERHEAD_SECONDS),
      },
    ]),
  );
  const candidates = measured
    .filter(
      ({ seconds, complete }) =>
        complete && seconds + COMPACT_JOB_OVERHEAD_SECONDS <= maxPackedJobSeconds,
    )
    .toSorted((a, b) => b.seconds - a.seconds || a.job.checkName.localeCompare(b.job.checkName));
  if (candidates.length < 2) {
    return finish(split.map((job) => priced.get(job) ?? job));
  }
  const names = candidates.flatMap(({ job }) => job.groups.map((group) => group.shard_name));
  if (new Set(names).size !== names.length) {
    return finish(split.map((job) => priced.get(job) ?? job));
  }

  const workBudget = maxPackedJobSeconds - COMPACT_JOB_OVERHEAD_SECONDS;
  const minimumJobs = Math.ceil(
    candidates.reduce((sum, entry) => sum + entry.seconds, 0) / workBudget,
  );
  for (let count = minimumJobs; count < candidates.length; count += 1) {
    const bins: Array<{ jobs: CompactNodeTestShard[]; seconds: number }> = Array.from(
      { length: count },
      () => ({ jobs: [], seconds: 0 }),
    );
    const fitted = candidates.every(({ job, seconds }) => {
      const bin = bins
        .filter(
          (candidate) =>
            candidate.seconds + seconds <= workBudget &&
            (candidate.jobs.length === 0 ||
              candidate.jobs[0]!.timeoutMinutes === job.timeoutMinutes) &&
            options.canShare([...candidate.jobs.flatMap((entry) => entry.groups), ...job.groups]),
        )
        .toSorted((a, b) => a.seconds - b.seconds)[0];
      if (!bin) {
        return false;
      }
      bin.jobs.push(job);
      bin.seconds += seconds;
      return true;
    });
    if (!fitted) {
      continue;
    }
    const retired = new Set(candidates.map(({ job }) => job));
    const packed = bins
      .filter((bin) => bin.jobs.length > 0)
      .map(({ jobs: originals, seconds }) =>
        Object.assign({}, originals[0]!, {
          groups: originals.flatMap((job) => job.groups),
          env: { ...originals[0]!.env, OPENCLAW_VITEST_MAX_WORKERS: "2" },
          predictedSeconds: Math.ceil(seconds + COMPACT_JOB_OVERHEAD_SECONDS),
        }),
      );
    return finish([
      ...split.filter((job) => !retired.has(job)).map((job) => priced.get(job) ?? job),
      ...packed,
    ]);
  }
  return finish(split.map((job) => priced.get(job) ?? job));
}
