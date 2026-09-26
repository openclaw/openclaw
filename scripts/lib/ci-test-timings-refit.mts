import { stripVTControlCharacters } from "node:util";
import { decodeNodeTestGroups } from "./ci-node-test-groups-codec.mts";
import {
  isRuntimePlacementTiming,
  isRuntimePlacementIncludePatterns,
  runtimePlacementTimingIdentity,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "./ci-test-timings-schema.mts";
import { createExtensionTestTimingKey } from "./extension-test-plan.mts";
import { isConstrainedCiCheckHost } from "./local-check-runtime.mts";
import {
  createCompactSplitTimingGeneration,
  parseCompactSplitTimingKey,
} from "./vitest-shard-metadata.mts";

export type CiTimingRun = {
  id: number;
  createdAt: string;
  /** Failed workflows and selected PR plans never prove absent keys disappeared. */
  completeInventory: boolean;
  /** The workflow/job SHA identifies the PR head, while tests run its merge-ref. */
  pullRequestMergeRef?: boolean;
  logs: (
    | { kind: "uiE2e" | "repoE2e"; text: string }
    | { kind: "compact" | "tooling"; text: string; labels: string[] }
  )[];
};

type Samples = Map<string, number[]>;
type WorkerCeilings = Map<string, Set<number | "unspecified" | "ambiguous">>;

type RuntimeTimingGroup = {
  shard_name: string;
  timing_key?: string;
  configs: string[];
  includePatterns?: string[] | null;
  env?: Record<string, string>;
  fallbackMaxWorkers?: number;
  minTotalMemoryBytes?: number;
};

function readRuntimeTimingGroups(text: string): RuntimeTimingGroup[] {
  const encoded = new Set(
    [
      ...text.matchAll(
        /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: (\S+)$/gmu,
      ),
    ].map((match) => match[1]!),
  );
  if (encoded.size > 1) {
    return [];
  }
  try {
    const jsonEnv = (key: string): unknown => {
      const value = readLogEnv(text, key);
      if (value === null) {
        throw new Error(`Ambiguous ${key}`);
      }
      return value ? JSON.parse(value) : undefined;
    };
    // Singleton matrix rows use the same executor without a packed group descriptor.
    const groups: unknown[] =
      encoded.size === 1
        ? decodeNodeTestGroups([...encoded][0]!)
        : [
            {
              shard_name: readLogEnv(text, "OPENCLAW_VITEST_SHARD_NAME"),
              configs: jsonEnv("OPENCLAW_NODE_TEST_CONFIGS_JSON"),
              includePatterns: jsonEnv("OPENCLAW_NODE_TEST_INCLUDE_PATTERNS_JSON"),
              env: jsonEnv("OPENCLAW_NODE_TEST_ENV_JSON") ?? undefined,
            },
          ];
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string");
    const validGroups = groups.filter((group): group is RuntimeTimingGroup => {
      if (typeof group !== "object" || group === null) {
        return false;
      }
      return (
        "shard_name" in group &&
        typeof group.shard_name === "string" &&
        (!("timing_key" in group) || typeof group.timing_key === "string") &&
        "configs" in group &&
        strings(group.configs) &&
        group.configs.length > 0 &&
        (!("includePatterns" in group) ||
          group.includePatterns === null ||
          strings(group.includePatterns)) &&
        (!("fallbackMaxWorkers" in group) ||
          (typeof group.fallbackMaxWorkers === "number" &&
            Number.isSafeInteger(group.fallbackMaxWorkers) &&
            group.fallbackMaxWorkers > 0)) &&
        (!("minTotalMemoryBytes" in group) ||
          (typeof group.minTotalMemoryBytes === "number" &&
            Number.isSafeInteger(group.minTotalMemoryBytes) &&
            group.minTotalMemoryBytes > 0)) &&
        (!("env" in group) ||
          group.env === undefined ||
          (typeof group.env === "object" &&
            group.env !== null &&
            !Array.isArray(group.env) &&
            Object.values(group.env).every((value) => typeof value === "string")))
      );
    });
    return validGroups.length === groups.length ? validGroups : [];
  } catch {
    // Historical/malformed descriptors cannot supply a placement identity.
    return [];
  }
}
const MIN_PRUNE_RUNS = 3;

function median(values: number[]): number {
  const sorted = values.toSorted((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

function recordSample(samples: Samples, key: string, value: number) {
  if (Number.isFinite(value) && value > 0) {
    const values = samples.get(key) ?? [];
    values.push(value);
    samples.set(key, values);
  }
}

function seconds(value: string, unit: string): number {
  return Number(value) / (unit === "ms" ? 1000 : 1);
}

function parseWorkerCeiling(value: unknown): number | null | undefined {
  if (value === undefined || value === "") {
    return undefined;
  }
  if (typeof value !== "string" || !/^[1-9]\d*$/u.test(value)) {
    return null;
  }
  const workers = Number(value);
  return Number.isSafeInteger(workers) ? workers : null;
}

function intersectWorkerCeilings(...values: (number | null | undefined)[]) {
  if (values.includes(null)) {
    return null;
  }
  const ceilings = values.filter((value): value is number => typeof value === "number");
  return ceilings.length > 0 ? Math.min(...ceilings) : undefined;
}

function readLogEnv(text: string, key: string): string | null | undefined {
  const values = new Set(
    [
      ...text.matchAll(
        new RegExp(
          `^\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z\\s+${key}: ([\\[{]\\n[\\s\\S]*?\\n[\\]}]|[^\\n]*)$`,
          "gmu",
        ),
      ),
    ].map((match) => match[1]!.trim()),
  );
  return values.size > 1 ? null : [...values][0];
}

function readJobWorkerCeiling(text: string) {
  const inherited = parseWorkerCeiling(readLogEnv(text, "OPENCLAW_VITEST_MAX_WORKERS"));
  const encoded = readLogEnv(text, "OPENCLAW_NODE_TEST_ENV_JSON");
  if (encoded === null) {
    return null;
  }
  let override: number | null | undefined;
  if (encoded) {
    try {
      const value: unknown = JSON.parse(encoded);
      if (value !== null) {
        override =
          typeof value === "object" && !Array.isArray(value)
            ? parseWorkerCeiling(
                "OPENCLAW_VITEST_MAX_WORKERS" in value
                  ? value.OPENCLAW_VITEST_MAX_WORKERS
                  : undefined,
              )
            : null;
      }
    } catch {
      return null;
    }
  }
  return intersectWorkerCeilings(inherited, override);
}

function readWorkerResources(text: string) {
  const matches = [
    ...text.matchAll(
      /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+\[shard:resources\] logicalCpuCount=(\d+) totalMemoryBytes=(\d+) requested plans=(\d+) admitted plans=(\d+)$/gmu,
    ),
  ];
  if (matches.length !== 1) {
    return undefined;
  }
  const values = matches[0]!.slice(1).map(Number);
  if (
    !values.every((value) => Number.isSafeInteger(value) && value > 0) ||
    values[3]! > values[2]!
  ) {
    return undefined;
  }
  return { logicalCpuCount: values[0]!, totalMemoryBytes: values[1]!, admittedPlans: values[3]! };
}

function readE2eLog(text: string, samples: Samples, overhead?: number[]) {
  const files = new Map<string, number>();
  let hasParallelFiles = false;
  for (const line of text.split("\n")) {
    const file =
      /^\s*(?:\d{4}-\d\d-\d\dT[\d:.]+Z\s+)?✓\s+(?:(\|ui-e2e(?:-(?:bundled|standalone|(?:serial|real-gateway)(?:-standalone)?))?\||ui-e2e(?:-(?:bundled|standalone|(?:serial|real-gateway)(?:-standalone)?))?)\s+)?(\S+\.test\.ts)\s+\((\d+) tests?(?: \| \d+ (?:skipped|todo))*\)\s+([\d.]+)(m?s)(?:\s|$)/u.exec(
        line,
      );
    if (file) {
      files.set(file[2]!, seconds(file[4]!, file[5]!));
      hasParallelFiles ||=
        file[1]?.includes("ui-e2e-bundled") === true ||
        file[1]?.includes("ui-e2e-standalone") === true ||
        file[1]?.includes("ui-e2e-real-gateway") === true;
    }
    const summary = /\bDuration\s+([\d.]+)(m?s)(?:\s|$)/u.exec(line);
    if (summary && files.size > 0) {
      // Commit complete native file times, including suite hooks, once per invocation.
      for (const [name, duration] of files) {
        recordSample(samples, name, duration);
      }
      // V5 prints phase percentages, not absolute times. File durations include
      // suite hooks; historical v4 logs retain their explicit aggregate test time.
      const legacyTests = /\btests\s+([\d.]+)(m?s)(?:[,\s)]|$)/u.exec(line);
      const testsSeconds = legacyTests
        ? seconds(legacyTests[1]!, legacyTests[2]!)
        : [...files.values()].reduce((total, duration) => total + duration, 0);
      const value = (seconds(summary[1]!, summary[2]!) - testsSeconds) / files.size;
      // Vitest sums test time across workers, so wall-minus-tests measures
      // per-file overhead only for serial invocations.
      if (overhead && !hasParallelFiles && Number.isFinite(value)) {
        overhead.push(value);
      }
      files.clear();
      hasParallelFiles = false;
    }
  }
}

function readCompactLog(
  text: string,
  labels: string[],
  samples: { blacksmith: Samples; github: Samples },
  runtimeSamples: { blacksmith: Samples; github: Samples },
  runtimeDescriptors: Map<string, RuntimePlacementTiming>,
  workerCeilings: { blacksmith: WorkerCeilings; github: WorkerCeilings },
  exactInventoryOnly: boolean,
) {
  const profile = labels.some((label) => label.startsWith("blacksmith-")) ? "blacksmith" : "github";
  const starts = new Map<string, number>();
  const ambiguousStarts = new Set<string>();
  const descriptors = readRuntimeTimingGroups(text);
  const runtimeModes = new Map<string, "runtime" | "private-qa">();
  const jobWorkerCeiling = readJobWorkerCeiling(text);
  const resources = readWorkerResources(text);
  const runnerEnvironment = readLogEnv(text, "RUNNER_ENVIRONMENT");
  const frozenTarget = readLogEnv(text, "FROZEN_TARGET");
  const jobExtraArgs = readLogEnv(text, "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON");
  for (const line of text.split("\n")) {
    const readiness =
      /\[shard:([^\]]+)\] \[test\] preparing (runtime|private-qa) runtime before Vitest workers/u.exec(
        line,
      );
    if (readiness) {
      const matches = descriptors.filter((group) => group.shard_name === readiness[1]);
      if (matches.length === 1) {
        const group = matches[0]!;
        const key = group.timing_key ?? group.shard_name;
        if (starts.has(key)) {
          runtimeModes.set(key, readiness[2] === "private-qa" ? "private-qa" : "runtime");
        }
      }
    }
    const event =
      /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))$/u.exec(line);
    if (!event) {
      continue;
    }
    const timestamp = event[1]!;
    const key = event[2]!;
    const action = event[3]!;
    const exitCode = event[4];
    if (action === "begin") {
      if (starts.has(key)) {
        ambiguousStarts.add(key);
      }
      starts.set(key, Date.parse(timestamp));
      runtimeModes.delete(key);
      continue;
    }
    const started = starts.get(key);
    if (exitCode === "0" && started !== undefined && !ambiguousStarts.has(key)) {
      // Preserve the workload as executed. Packed plans may be serial or
      // concurrent, and admission must use the wrapper span it actually ran.
      const matches = descriptors.filter((group) => (group.timing_key ?? group.shard_name) === key);
      const group = matches.length === 1 ? matches[0] : undefined;
      // Runtime subsets inherit the envelope's worker pin, but their files
      // cannot supply a full-envelope runtime placement observation.
      const workerMatches = descriptors.filter(
        (entry) =>
          (entry.timing_key ?? entry.shard_name) === key.replace(/^(?:bun|node-subset):/u, ""),
      );
      const workerGroup = workerMatches.length === 1 ? workerMatches[0] : undefined;
      let workerCeiling = intersectWorkerCeilings(
        jobWorkerCeiling,
        parseWorkerCeiling(workerGroup?.env?.OPENCLAW_VITEST_MAX_WORKERS),
      );
      const fallback = workerGroup?.fallbackMaxWorkers;
      if (
        workerGroup !== undefined &&
        fallback !== undefined &&
        (typeof workerCeiling !== "number" || workerCeiling > fallback)
      ) {
        const eligibleResources =
          resources &&
          !isConstrainedCiCheckHost(resources) &&
          resources.admittedPlans === 1 &&
          resources.totalMemoryBytes >= (workerGroup.minTotalMemoryBytes ?? 0);
        const fallbackApplies =
          (resources && !eligibleResources) ||
          runnerEnvironment === "github-hosted" ||
          frozenTarget === "true";
        const measuredHost =
          eligibleResources && runnerEnvironment === "self-hosted" && frozenTarget === "false";
        workerCeiling = fallbackApplies
          ? intersectWorkerCeilings(workerCeiling, fallback)
          : measuredHost
            ? workerCeiling
            : null;
      }
      const namedWorkers = [...key.matchAll(/#(?:workers|file-parallel)-([1-9]\d*)(?=#|$)/gu)];
      if (
        typeof workerCeiling === "number" &&
        namedWorkers.some((match) => Number(match[1]) !== workerCeiling)
      ) {
        // A successful fallback still carries the requested worker identity.
        workerCeiling = null;
      }
      const splitTiming = parseCompactSplitTimingKey(key);
      const extensionGroup = group?.shard_name.startsWith("changed-extensions-config") === true;
      let exactKey: string | undefined;
      if (
        group &&
        !splitTiming &&
        typeof workerCeiling === "number" &&
        isRuntimePlacementIncludePatterns(group.includePatterns) &&
        (jobExtraArgs === undefined || jobExtraArgs === "[]") &&
        group.env?.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON === undefined
      ) {
        const env = { ...group.env, OPENCLAW_VITEST_MAX_WORKERS: String(workerCeiling) };
        if (extensionGroup && group.configs.length === 1) {
          exactKey = createExtensionTestTimingKey(group.configs[0]!, group.includePatterns, env);
        } else if (workerCeiling === 2 && key.endsWith("#file-parallel-2")) {
          // PR descriptors prove this selected inventory, never an unsplit family total.
          // Eight-worker command placement rewrites the name after its selector is made.
          exactKey = createCompactSplitTimingGeneration({
            configs: group.configs,
            env,
            parentShardName: key,
            stripes: [group.includePatterns],
          }).timingKeys[0];
        }
      }
      const measuredKeys = [
        ...(!extensionGroup && (!exactInventoryOnly || splitTiming) ? [key] : []),
        ...(exactKey ? [exactKey] : []),
      ];
      for (const measuredKey of measuredKeys) {
        const measuredSplit = parseCompactSplitTimingKey(measuredKey);
        for (const identity of [measuredKey, measuredSplit?.parentShardName]) {
          if (identity === undefined) {
            continue;
          }
          const observed = workerCeilings[profile].get(identity) ?? new Set();
          observed.add(workerCeiling === null ? "ambiguous" : (workerCeiling ?? "unspecified"));
          workerCeilings[profile].set(identity, observed);
        }
        // An unsplit PR key does not prove that its full owner inventory ran.
        recordSample(samples[profile], measuredKey, (Date.parse(timestamp) - started) / 1000);
      }
      if (group && workerCeiling !== null) {
        const observation = {
          configs: group.configs,
          env: Object.fromEntries(
            Object.entries({
              ...group.env,
              ...(workerCeiling === undefined
                ? {}
                : { OPENCLAW_VITEST_MAX_WORKERS: String(workerCeiling) }),
            }).toSorted(([a], [b]) => a.localeCompare(b)),
          ),
          includePatterns: group.includePatterns?.toSorted(),
          pretestBuildMode: runtimeModes.get(key),
          seconds: Math.max(1, Math.round((Date.parse(timestamp) - started) / 1000)),
        };
        if (isRuntimePlacementTiming(observation)) {
          const identity = runtimePlacementTimingIdentity(observation);
          runtimeDescriptors.set(identity, observation);
          recordSample(runtimeSamples[profile], identity, (Date.parse(timestamp) - started) / 1000);
        }
      }
    }
    starts.delete(key);
  }
}

function readToolingLog(text: string, samples: Samples) {
  const descriptors = readRuntimeTimingGroups(text);
  const active = new Map<
    string,
    {
      cases: Map<string, number>;
      files: Map<string, number>;
      complete: boolean;
      declaredFiles: Set<string>;
      singletonFile: string | undefined;
      fileSummaryCount: number;
      singletonSummary: boolean;
      durationCount: number;
      durationSeconds: number | undefined;
    }
  >();
  for (const line of text.split("\n")) {
    const event = /\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (event) {
      const matches = descriptors.filter(
        (group) => (group.timing_key ?? group.shard_name) === event[1],
      );
      const descriptor = matches.length === 1 ? matches[0] : undefined;
      if (!descriptor || !/^core-tooling-\d+(?:-hosted-\d+)?$/u.test(descriptor.shard_name)) {
        continue;
      }
      const shard = descriptor.shard_name;
      if (event[2] === "begin") {
        active.set(shard, {
          cases: new Map(),
          files: new Map(),
          complete: false,
          declaredFiles: new Set(descriptor.includePatterns ?? []),
          singletonFile:
            !active.has(shard) &&
            descriptor.configs.length === 1 &&
            descriptor.configs[0] === "test/vitest/vitest.tooling.config.ts" &&
            descriptor.includePatterns?.length === 1
              ? descriptor.includePatterns[0]
              : undefined,
          fileSummaryCount: 0,
          singletonSummary: false,
          durationCount: 0,
          durationSeconds: undefined,
        });
      } else {
        const invocation = active.get(shard);
        if (event[3] === "0" && invocation?.complete) {
          const files = new Map([...invocation.cases, ...invocation.files]);
          const singletonFile = invocation.singletonFile;
          if (
            singletonFile !== undefined &&
            files.size === 1 &&
            files.has(singletonFile) &&
            !invocation.files.has(singletonFile) &&
            invocation.fileSummaryCount === 1 &&
            invocation.singletonSummary &&
            invocation.durationCount === 1 &&
            invocation.durationSeconds !== undefined &&
            Number.isFinite(invocation.durationSeconds) &&
            invocation.durationSeconds > 0
          ) {
            // A complete one-file invocation includes startup and suite hooks;
            // concurrent case sums can overstate its wall. Native file time wins.
            files.set(singletonFile, invocation.durationSeconds);
          }
          for (const [file, duration] of files) {
            // Tooling fixtures print nested reporters. Only this shard's
            // declared inventory can supply measurements for its real files.
            if (invocation.declaredFiles.has(file)) {
              recordSample(samples, file, Math.max(0.001, duration));
            }
          }
        }
        active.delete(shard);
      }
      continue;
    }
    const row = /\[shard:([^\]]+)\]\s+(.*)$/u.exec(line);
    const invocation = row && active.get(row[1]!);
    if (!invocation) {
      continue;
    }
    const file =
      /^✓\s+(?:\|tooling\||tooling)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+\(\d+ tests?(?: \| \d+ (?:skipped|todo))*\)\s+([\d.]+)(m?s)(?:\s|$)/u.exec(
        row[2]!,
      );
    if (file) {
      invocation.files.set(file[1]!, seconds(file[2]!, file[3]!));
    } else {
      const test =
        /^✓\s+(?:\|tooling\||tooling)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)\s+> .+\s([\d.]+)(m?s)$/u.exec(
          row[2]!,
        );
      if (test) {
        invocation.cases.set(
          test[1]!,
          (invocation.cases.get(test[1]!) ?? 0) + seconds(test[2]!, test[3]!),
        );
      }
    }
    // Nested reporters can print their own summaries inside this shard's output.
    // Count those too, but only an unwrapped native header qualifies the wall.
    if (/\bTest Files\b/u.test(row[2]!)) {
      invocation.fileSummaryCount += 1;
      invocation.singletonSummary = /^Test Files\s+1 passed\s+\(1\)\s*$/u.test(row[2]!);
    }
    invocation.durationCount += row[2]!.match(/\bDuration\b/gu)?.length ?? 0;
    const duration = /^Duration\s+([\d.]+)(m?s)(?:\s|$)/u.exec(row[2]!);
    if (duration) {
      invocation.complete = true;
      invocation.durationSeconds = seconds(duration[1]!, duration[2]!);
    }
  }
}

function runtimePlacementSecondsMap(observations: readonly RuntimePlacementTiming[] = []) {
  return Object.fromEntries(
    observations.map((observation) => [
      runtimePlacementTimingIdentity(observation),
      observation.seconds,
    ]),
  );
}

function recordCompleteParentSamples(
  samples: Samples,
  observedParents: Set<string>,
  foldParents: boolean,
) {
  const generations = new Map<
    string,
    { parent: string; expected: number; parts: Map<number, number> }
  >();
  for (const [key, values] of samples) {
    const parsed = parseCompactSplitTimingKey(key);
    if (!parsed) {
      continue;
    }
    observedParents.add(parsed.parentShardName);
    // A selected PR subset can share the reduced full inventory's parent name.
    // Its exact child key is evidence; completeness of that subset is not.
    if (!foldParents || parsed.parentShardName.startsWith("extension-test:")) {
      continue;
    }
    const generation = generations.get(parsed.generationKey) ?? {
      parent: parsed.parentShardName,
      expected: parsed.expectedParts,
      parts: new Map<number, number>(),
    };
    generation.parts.set(parsed.part, median(values));
    generations.set(parsed.generationKey, generation);
  }
  for (const { parent, expected, parts } of generations.values()) {
    if (parts.size !== expected) {
      continue;
    }
    // Inventory-specific child keys expire when files move. Retain the full
    // measured cost at its parent so the next inventory has a measured floor.
    // One run/profile supplies one sample, even after retries or repartitioning.
    const total = [...parts.values()].reduce((sum, duration) => sum + duration, 0);
    const direct = samples.get(parent);
    samples.set(parent, [Math.max(total, direct ? median(direct) : 0)]);
  }
}

function refitMap(
  samples: Samples,
  previous: Record<string, number> = {},
  contributingRuns = 0,
  observedParents?: Set<string>,
  minimumSamples = 2,
  retainReleaseCosts = false,
) {
  const next = Object.fromEntries(
    Object.entries(previous).filter(
      ([key]) =>
        (retainReleaseCosts && key.startsWith("release-full-")) ||
        contributingRuns < MIN_PRUNE_RUNS ||
        samples.has(key) ||
        observedParents?.has(key),
    ),
  );
  for (const [key, values] of samples) {
    const center = median(values);
    const retained = values.filter((value) => value <= center * 2.5);
    if (retained.length >= minimumSamples) {
      const measured = median(retained);
      if (
        previous[key] === undefined ||
        Math.abs(measured - previous[key]) > previous[key] * 0.15
      ) {
        next[key] = Math.max(1, Math.round(measured));
      }
    }
  }
  return Object.fromEntries(
    Object.entries(next).toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

export function refitTestTimings(
  runs: CiTimingRun[],
  previous?: CiTestTimings,
  options: { seedTooling?: boolean } = {},
) {
  const samples = {
    uiE2e: new Map<string, number[]>(),
    repoE2e: new Map<string, number[]>(),
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
    toolingBlacksmith: new Map<string, number[]>(),
    toolingGithub: new Map<string, number[]>(),
  };
  const contributingRuns = {
    uiE2e: new Set<number>(),
    repoE2e: new Set<number>(),
    blacksmith: new Set<number>(),
    github: new Set<number>(),
    toolingBlacksmith: new Set<number>(),
    toolingGithub: new Set<number>(),
  };
  const overhead: number[] = [];
  const observedParents = { blacksmith: new Set<string>(), github: new Set<string>() };
  const runtimeSamples = {
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
  };
  const workerCeilings = {
    blacksmith: new Map<string, Set<number | "unspecified" | "ambiguous">>(),
    github: new Map<string, Set<number | "unspecified" | "ambiguous">>(),
  };
  const runtimeDescriptors = new Map<string, RuntimePlacementTiming>(
    Object.values(previous?.runtimePlacementTimings ?? {})
      .flat()
      .map((observation) => [runtimePlacementTimingIdentity(observation), observation]),
  );
  const uniqueRuns = new Map<number, CiTimingRun>();
  for (const run of runs) {
    const retained = uniqueRuns.get(run.id);
    if (retained) {
      retained.logs.push(...run.logs);
      retained.completeInventory = retained.completeInventory && run.completeInventory;
      retained.pullRequestMergeRef ||= run.pullRequestMergeRef;
    } else {
      uniqueRuns.set(run.id, { ...run, logs: [...run.logs] });
    }
  }
  for (const run of uniqueRuns.values()) {
    const current = {
      uiE2e: new Map<string, number[]>(),
      repoE2e: new Map<string, number[]>(),
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
      toolingBlacksmith: new Map<string, number[]>(),
      toolingGithub: new Map<string, number[]>(),
    };
    const currentRuntime = {
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
    };
    for (const log of run.logs) {
      // `gh run view --log` adds job/step columns outside the timestamped record.
      // A timestamped child line may quote that format; its contents stay nested.
      const text = stripVTControlCharacters(log.text).replace(
        /^(?!\d{4}-\d\d-\d\dT[\d:.]+Z(?:\s|$))[^\t\r\n]+\t[^\t\r\n]+\t(?=\d{4}-\d\d-\d\dT[\d:.]+Z(?:\s|$))/gmu,
        "",
      );
      if (log.kind === "tooling") {
        const profile = log.labels.some((label) => label.startsWith("blacksmith-"))
          ? "toolingBlacksmith"
          : "toolingGithub";
        readToolingLog(text, current[profile]);
      } else if (log.kind === "compact") {
        readCompactLog(
          text,
          log.labels,
          current,
          currentRuntime,
          runtimeDescriptors,
          workerCeilings,
          run.pullRequestMergeRef === true,
        );
        const profile = log.labels.some((label) => label.startsWith("blacksmith-"))
          ? "toolingBlacksmith"
          : "toolingGithub";
        readToolingLog(text, current[profile]);
      } else {
        readE2eLog(text, current[log.kind], log.kind === "uiE2e" ? overhead : undefined);
      }
    }
    for (const profile of ["blacksmith", "github"] as const) {
      recordCompleteParentSamples(
        current[profile],
        observedParents[profile],
        !run.pullRequestMergeRef,
      );
      for (const [identity, values] of currentRuntime[profile]) {
        recordSample(runtimeSamples[profile], identity, median(values));
      }
    }
    // Retries or duplicate reporter lines in one run must not satisfy the two-run minimum.
    for (const profile of [
      "uiE2e",
      "repoE2e",
      "blacksmith",
      "github",
      "toolingBlacksmith",
      "toolingGithub",
    ] as const) {
      // Missing or unparseable profile logs are not evidence that its keys disappeared.
      if (current[profile].size > 0) {
        contributingRuns[profile].add(run.id);
      }
      for (const [key, values] of current[profile]) {
        recordSample(samples[profile], key, median(values));
      }
    }
  }

  const rejectedWorkerKeys = { blacksmith: [] as string[], github: [] as string[] };
  for (const profile of ["blacksmith", "github"] as const) {
    for (const [key, ceilings] of workerCeilings[profile]) {
      if (ceilings.size > 1 || ceilings.has("ambiguous")) {
        // Historical keys can omit inherited job caps. Do not average unlike
        // execution policies or turn rejected evidence into a pruning signal.
        samples[profile].delete(key);
        observedParents[profile].add(key);
        rejectedWorkerKeys[profile].push(key);
      }
    }
    rejectedWorkerKeys[profile].sort();
  }

  const completeInventoryRuns = new Set(
    [...uniqueRuns.values()].filter((run) => run.completeInventory).map((run) => run.id),
  );
  const pruningRunCount = (profile: keyof typeof contributingRuns) =>
    [...contributingRuns[profile]].filter((id) => completeInventoryRuns.has(id)).length;

  const measuredOverhead =
    overhead.length >= 2 ? Math.max(0, Math.min(5, median(overhead))) : undefined;
  const oldOverhead = previous?.uiE2e.perFileOverheadSeconds;
  const keepOverhead =
    measuredOverhead === undefined ||
    (oldOverhead !== undefined && Math.abs(measuredOverhead - oldOverhead) <= oldOverhead * 0.15);
  const runIds = [...new Set(runs.map((run) => run.id))].toSorted((a, b) => a - b);
  const pullRequestRunIds = runs.filter((run) => run.pullRequestMergeRef).map((run) => run.id);
  function refitRuntime(profile: "blacksmith" | "github"): RuntimePlacementTiming[] {
    return Object.entries(
      refitMap(
        runtimeSamples[profile],
        runtimePlacementSecondsMap(previous?.runtimePlacementTimings[profile]),
        pruningRunCount(profile),
      ),
    ).map(([identity, measuredSeconds]) =>
      Object.assign({}, runtimeDescriptors.get(identity)!, { seconds: measuredSeconds }),
    );
  }
  const timings: CiTestTimings = {
    compactGroupSeconds: {
      blacksmith: refitMap(
        samples.blacksmith,
        previous?.compactGroupSeconds.blacksmith,
        pruningRunCount("blacksmith"),
        observedParents.blacksmith,
      ),
      github: refitMap(
        samples.github,
        previous?.compactGroupSeconds.github,
        pruningRunCount("github"),
        observedParents.github,
        2,
        true,
      ),
    },
    repoE2eFileSeconds: refitMap(
      samples.repoE2e,
      previous?.repoE2eFileSeconds,
      pruningRunCount("repoE2e"),
    ),
    runtimePlacementTimings: {
      blacksmith: refitRuntime("blacksmith"),
      github: refitRuntime("github"),
    },
    source: options.seedTooling
      ? `tooling seed from successful pull_request CI merge-ref runs: ${runIds.join(", ")}; retained other timings: ${previous?.source ?? "none"}`
      : `median of successful timing jobs from ${runIds.length} CI and release-check runs: ${runIds.join(", ")}${pullRequestRunIds.length > 0 ? `; pull_request merge-ref runs: ${[...new Set(pullRequestRunIds)].toSorted((a, b) => a - b).join(", ")}` : ""}`,
    // PR plans may select only part of tooling. Absence is not evidence that
    // a file disappeared; preserve unobserved measurements across those windows.
    toolingFileSeconds: {
      blacksmith: refitMap(
        samples.toolingBlacksmith,
        previous?.toolingFileSeconds.blacksmith,
        0,
        undefined,
        options.seedTooling ? 1 : 2,
      ),
      github: refitMap(
        samples.toolingGithub,
        previous?.toolingFileSeconds.github,
        0,
        undefined,
        options.seedTooling ? 1 : 2,
      ),
    },
    uiE2e: {
      fileSeconds: refitMap(samples.uiE2e, previous?.uiE2e.fileSeconds, pruningRunCount("uiE2e")),
      perFileOverheadSeconds: keepOverhead
        ? (oldOverhead ?? 0)
        : Math.round(measuredOverhead * 10) / 10,
    },
    updatedAt:
      runs
        .map((run) => run.createdAt.slice(0, 10))
        .toSorted()
        .at(-1) ??
      previous?.updatedAt ??
      new Date().toISOString().slice(0, 10),
    version: 1,
  };
  const changes: { key: string; old: number | undefined; next: number | undefined }[] = [];
  const comparedMaps: [string, Record<string, number>, Record<string, number> | undefined][] = [
    ...(["blacksmith", "github"] as const).map(
      (profile): [string, Record<string, number>, Record<string, number>] => [
        `runtimePlacementTimings.${profile}`,
        runtimePlacementSecondsMap(timings.runtimePlacementTimings[profile]),
        runtimePlacementSecondsMap(previous?.runtimePlacementTimings[profile]),
      ],
    ),
    [
      "compactGroupSeconds.blacksmith",
      timings.compactGroupSeconds.blacksmith,
      previous?.compactGroupSeconds.blacksmith,
    ],
    [
      "compactGroupSeconds.github",
      timings.compactGroupSeconds.github,
      previous?.compactGroupSeconds.github,
    ],
    ["uiE2e.fileSeconds", timings.uiE2e.fileSeconds, previous?.uiE2e.fileSeconds],
    ["repoE2eFileSeconds", timings.repoE2eFileSeconds, previous?.repoE2eFileSeconds],
    [
      "toolingFileSeconds.blacksmith",
      timings.toolingFileSeconds.blacksmith,
      previous?.toolingFileSeconds.blacksmith,
    ],
    [
      "toolingFileSeconds.github",
      timings.toolingFileSeconds.github,
      previous?.toolingFileSeconds.github,
    ],
    [
      "uiE2e",
      { perFileOverheadSeconds: timings.uiE2e.perFileOverheadSeconds },
      oldOverhead === undefined ? undefined : { perFileOverheadSeconds: oldOverhead },
    ],
  ];
  for (const [prefix, next, old] of comparedMaps) {
    for (const key of new Set([...Object.keys(next), ...Object.keys(old ?? {})])) {
      const value = next[key];
      const oldValue = old?.[key];
      if (value !== oldValue) {
        changes.push({ key: `${prefix}.${key}`, old: oldValue, next: value });
      }
    }
  }
  if (previous && changes.length === 0) {
    timings.source = previous.source;
    timings.updatedAt = previous.updatedAt;
  }
  return {
    timings,
    changes: changes.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)),
    runIds,
    rejectedWorkerKeys,
    contributingRunIds: {
      blacksmith: [...contributingRuns.blacksmith].toSorted((a, b) => a - b),
      github: [...contributingRuns.github].toSorted((a, b) => a - b),
      repoE2e: [...contributingRuns.repoE2e].toSorted((a, b) => a - b),
      uiE2e: [...contributingRuns.uiE2e].toSorted((a, b) => a - b),
      toolingBlacksmith: [...contributingRuns.toolingBlacksmith].toSorted((a, b) => a - b),
      toolingGithub: [...contributingRuns.toolingGithub].toSorted((a, b) => a - b),
    },
  };
}
