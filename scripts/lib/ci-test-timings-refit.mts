import { stripVTControlCharacters } from "node:util";
import { decodeNodeTestGroups } from "./ci-node-test-groups-codec.mts";
import type { NodeTestShardGroup } from "./ci-node-test-plan.mts";
import {
  NATIVE_SOLO_TIMING_PROFILE,
  createNativeSoloTimingKey,
  isRuntimePlacementTiming,
  isRuntimePlacementIncludePatterns,
  runtimePlacementTimingIdentity,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "./ci-test-timings-schema.mts";
import {
  canOverlapTelegramSingletonProcesses,
  createExtensionTestTimingKey,
  splitExtensionTestProcessTargets,
} from "./extension-test-plan.mts";
import { isConstrainedCiCheckHost } from "./local-check-runtime.mts";
import { isRecord } from "./record-shared.mjs";
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
    | { kind: "compact" | "tooling" | "release-packed"; text: string; labels: string[] }
  )[];
};

type Samples = Map<string, number[]>;
type WorkerCeilings = Map<string, Set<number | "unspecified" | "ambiguous">>;

type RuntimeTimingGroup = Omit<
  NodeTestShardGroup,
  "runner" | "requiresDist" | "pretestBuildMode" | "includePatterns"
> & {
  includePatterns?: string[] | null;
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
  return {
    logicalCpuCount: values[0]!,
    totalMemoryBytes: values[1]!,
    requestedPlans: values[2]!,
    admittedPlans: values[3]!,
  };
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

function readSingletonVitestInvocations(
  lines: readonly string[],
  config: string,
  files: readonly string[],
): Map<string, number> | undefined {
  const declared = new Set(files);
  const measured = new Map<string, number>();
  let active:
    | {
        started: number;
        files: Set<string>;
        runs: number;
        summaries: number;
        durations: number;
        duration?: number;
      }
    | undefined;
  let verified = false;
  let passed = false;
  const finish = (ended: number) => {
    if (!active) {
      return false;
    }
    const [file] = active.files;
    const elapsed = (ended - active.started) / 1000;
    if (
      active.files.size !== 1 ||
      file === undefined ||
      !declared.has(file) ||
      measured.has(file) ||
      active.runs !== 1 ||
      active.summaries !== 1 ||
      active.durations !== 1 ||
      active.duration === undefined ||
      !Number.isFinite(active.duration) ||
      !Number.isFinite(elapsed) ||
      active.duration > elapsed ||
      elapsed <= 0
    ) {
      return false;
    }
    measured.set(file, elapsed);
    active = undefined;
    return true;
  };
  for (const line of lines) {
    const record = /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\[shard:[^\]]+\]\s+(.*)$/u.exec(line);
    if (!record) {
      continue;
    }
    const timestamp = Date.parse(record[1]!);
    if (!Number.isFinite(timestamp)) {
      return undefined;
    }
    const body = record[2]!.trim();
    const start = /^\[test\] starting (\S+)$/u.exec(body);
    if (start) {
      if (verified || start[1] !== config || (active && !finish(timestamp))) {
        return undefined;
      }
      active = { started: timestamp, files: new Set(), runs: 0, summaries: 0, durations: 0 };
      continue;
    }
    if (body === "[vitest-workers] verifying completed generation before cleanup") {
      if (verified || !finish(timestamp)) {
        return undefined;
      }
      verified = true;
      continue;
    }
    const completion = /^\[test\] passed (\d+) Vitest shards? in [\d.]+s$/u.exec(body);
    if (completion) {
      if (!verified || passed || Number(completion[1]) !== files.length) {
        return undefined;
      }
      passed = true;
      continue;
    }
    if (/^RUN\s+v\S+/u.test(body)) {
      if (!active) {
        return undefined;
      }
      active.runs += 1;
    }
    const file =
      /^✓\s+(?:\|[^|]+\||\S+)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)(?:\s+>|\s+\(\d+ tests?)/u.exec(
        body,
      );
    if (file && active) {
      active.files.add(file[1]!);
    }
    if (/^Test Files\b/u.test(body)) {
      if (!active || !/^Test Files\s+1 passed\s+\(1\)$/u.test(body)) {
        return undefined;
      }
      active.summaries += 1;
    }
    if (/^Duration\b/u.test(body)) {
      const duration = /^Duration\s+([\d.]+)(m?s)(?:\s|$)/u.exec(body);
      if (!active || !duration) {
        return undefined;
      }
      active.durations += 1;
      active.duration = seconds(duration[1]!, duration[2]!);
    }
  }
  return verified && passed && measured.size === declared.size ? measured : undefined;
}

function hasNativeSoloJobEnvironment(text: string): boolean {
  const encoded = readLogEnv(text, "OPENCLAW_NODE_TEST_ENV_JSON");
  if (encoded === null) {
    return false;
  }
  try {
    const env: unknown = encoded ? JSON.parse(encoded) : {};
    if (env === null) {
      return true;
    }
    if (
      typeof env !== "object" ||
      Array.isArray(env) ||
      Object.entries(env).some(
        ([key, value]) => key !== "OPENCLAW_VITEST_MAX_WORKERS" || value !== "8",
      )
    ) {
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readPackedReleaseLog(text: string, labels: string[], samples: Samples) {
  const resources = readWorkerResources(text);
  const descriptors = readRuntimeTimingGroups(text);
  const jobWorkers = readJobWorkerCeiling(text);
  if (
    !labels.includes("ubuntu-24.04") ||
    labels.some((label) => label === "self-hosted" || /^(?:blacksmith-|runson)/u.test(label)) ||
    readLogEnv(text, "OPENCLAW_CI_TEST_RUNTIME_POLICY") !== "dual" ||
    resources?.requestedPlans !== 1 ||
    resources.admittedPlans !== 1 ||
    descriptors.length < 2 ||
    descriptors.some((group) => {
      const workers = intersectWorkerCeilings(
        jobWorkers,
        parseWorkerCeiling(group.env?.OPENCLAW_VITEST_MAX_WORKERS),
      );
      return !group.timing_key?.startsWith("release-full-") || workers !== 2;
    })
  ) {
    return;
  }
  const receipts = [
    ...text.matchAll(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\[shard:completion\] (.+)$/gmu),
  ];
  if (receipts.length !== 1) {
    return;
  }
  let completion: unknown;
  try {
    completion = JSON.parse(receipts[0]![2]!);
  } catch {
    return;
  }
  if (
    !isRecord(completion) ||
    completion.version !== 1 ||
    completion.planned !== descriptors.length ||
    completion.completed !== descriptors.length ||
    completion.failedInvocations !== 0 ||
    typeof completion.invocations !== "number" ||
    !Number.isSafeInteger(completion.invocations)
  ) {
    return;
  }
  const groups = new Map<string, { start?: number; end: number; node: boolean }>(
    descriptors.map((group) => [group.timing_key!, { end: 0, node: false }]),
  );
  if (groups.size !== descriptors.length) {
    return;
  }
  let active: { key: string; start: number } | undefined;
  let currentGroup: string | undefined;
  let invocations = 0;
  let lastTimestamp = 0;
  for (const event of text.matchAll(
    /^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))$/gmu,
  )) {
    const timestamp = Date.parse(event[1]!);
    const key = event[2]!;
    const owner = key.replace(/^(?:bun|bun-native):/u, "");
    const group = groups.get(owner);
    if (!group || !Number.isFinite(timestamp) || timestamp < lastTimestamp) {
      return;
    }
    lastTimestamp = timestamp;
    if (event[3] === "begin") {
      if (active || (group.start !== undefined && currentGroup !== owner)) {
        return;
      }
      if (key === owner) {
        // The runtime selection owner starts dual policy with one full Node run.
        if (group.node) {
          return;
        }
        group.node = true;
      } else if (!group.node) {
        return;
      }
      currentGroup = owner;
      group.start ??= timestamp;
      active = { key, start: timestamp };
    } else {
      if (active?.key !== key || event[4] !== "0" || timestamp <= active.start) {
        return;
      }
      group.end = timestamp;
      invocations += 1;
      active = undefined;
    }
  }
  if (
    active ||
    invocations !== completion.invocations ||
    !(Date.parse(receipts[0]![1]!) >= lastTimestamp) ||
    [...groups.values()].some(
      (group) => !group.node || group.start === undefined || group.end <= group.start,
    )
  ) {
    return;
  }
  // The completion receipt accounts for every invocation. Include all selected
  // Bun runs and the gaps between runtimes in one complete serial group wall.
  for (const [key, group] of groups) {
    recordSample(samples, key, (group.end - group.start!) / 1000);
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
  const singletonLogs = new Map<string, { key: string; lines: string[] }>();
  const jobWorkerCeiling = readJobWorkerCeiling(text);
  const resources = readWorkerResources(text);
  const runnerEnvironment = readLogEnv(text, "RUNNER_ENVIRONMENT");
  const frozenTarget = readLogEnv(text, "FROZEN_TARGET");
  const jobExtraArgs = readLogEnv(text, "OPENCLAW_NODE_TEST_VITEST_ARGS_JSON");
  const nativeSoloHost =
    labels.length === 1 &&
    labels[0] === NATIVE_SOLO_TIMING_PROFILE.runner &&
    descriptors.length === 1 &&
    Boolean(readLogEnv(text, "OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64")) &&
    resources?.logicalCpuCount === NATIVE_SOLO_TIMING_PROFILE.logicalCpuCount &&
    resources.totalMemoryBytes >= NATIVE_SOLO_TIMING_PROFILE.minTotalMemoryBytes &&
    resources.totalMemoryBytes <= NATIVE_SOLO_TIMING_PROFILE.maxTotalMemoryBytes &&
    resources.requestedPlans === 1 &&
    resources.admittedPlans === 1 &&
    jobWorkerCeiling === NATIVE_SOLO_TIMING_PROFILE.maxWorkers &&
    runnerEnvironment === "self-hosted" &&
    frozenTarget === "false" &&
    hasNativeSoloJobEnvironment(text);
  for (const line of text.split("\n")) {
    const output = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+\[shard:([^\]]+)\]/u.exec(line);
    if (output) {
      singletonLogs.get(output[1]!)?.lines.push(line);
    }
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
      const matches = descriptors.filter((group) => (group.timing_key ?? group.shard_name) === key);
      const descriptor = matches.length === 1 ? matches[0] : undefined;
      if (descriptor && nativeSoloHost && createNativeSoloTimingKey(descriptor)) {
        singletonLogs.set(descriptor.shard_name, { key, lines: [] });
      }
      if (
        descriptor?.shard_name.startsWith("changed-extensions-config") &&
        descriptor.configs.length === 1 &&
        isRuntimePlacementIncludePatterns(descriptor.includePatterns)
      ) {
        const processes = splitExtensionTestProcessTargets(
          descriptor.configs[0]!,
          descriptor.includePatterns,
        );
        if (
          processes.length === descriptor.includePatterns.length &&
          processes.every((files) => files.length === 1)
        ) {
          singletonLogs.set(descriptor.shard_name, { key, lines: [] });
        }
      }
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
      const splitTiming = parseCompactSplitTimingKey(key);
      const requiresWorkerCeiling =
        namedWorkers.length > 0 || (exactInventoryOnly && splitTiming !== undefined);
      if (
        (requiresWorkerCeiling && typeof workerCeiling !== "number") ||
        (typeof workerCeiling === "number" &&
          namedWorkers.some((match) => Number(match[1]) !== workerCeiling))
      ) {
        // A fallback or incomplete receipt cannot refresh the requested worker identity.
        workerCeiling = null;
      }
      const extensionGroup = group?.shard_name.startsWith("changed-extensions-config") === true;
      const selectedFiles = group?.includePatterns;
      const hasExactSelection =
        isRuntimePlacementIncludePatterns(selectedFiles) &&
        (jobExtraArgs === undefined || jobExtraArgs === "[]") &&
        group?.env?.OPENCLAW_NODE_TEST_VITEST_ARGS_JSON === undefined;
      let matchesSplitSelection = false;
      if (group && splitTiming && hasExactSelection) {
        const selectedKey = createCompactSplitTimingGeneration({
          configs: group.configs,
          env: group.env,
          parentShardName: key,
          stripes: [selectedFiles],
        }).timingKeys[0]!;
        matchesSplitSelection = key.endsWith(
          selectedKey.slice(selectedKey.lastIndexOf("#include-")),
        );
      }
      const singletonLog = group && singletonLogs.get(group.shard_name);
      const parallelReceipts = (singletonLog?.lines ?? []).flatMap((outputLine) => {
        const receipt = /\[shard:[^\]]+\] \[test\] inner parallelism ([1-9]\d*)$/u.exec(outputLine);
        return receipt ? [Number(receipt[1])] : [];
      });
      const requestedParallel = group?.env?.OPENCLAW_TEST_PROJECTS_PARALLEL;
      const innerParallelism =
        extensionGroup && (requestedParallel === "2" || parallelReceipts.length > 0)
          ? parallelReceipts.length === 1 &&
            (parallelReceipts[0] === 1 || parallelReceipts[0] === 2)
            ? parallelReceipts[0]
            : undefined
          : 1;
      const parallelQualified =
        innerParallelism !== 2 ||
        (workerCeiling === 2 &&
          group?.configs.length === 1 &&
          !runtimeModes.has(key) &&
          canOverlapTelegramSingletonProcesses(group.configs[0]!, selectedFiles));
      const sampledEnv: Record<string, string> = {
        ...group?.env,
        ...(typeof workerCeiling === "number"
          ? { OPENCLAW_VITEST_MAX_WORKERS: String(workerCeiling) }
          : {}),
      };
      if (extensionGroup) {
        delete sampledEnv.OPENCLAW_TEST_PROJECTS_PARALLEL;
        if (innerParallelism === 2) {
          sampledEnv.OPENCLAW_TEST_PROJECTS_PARALLEL = "2";
        }
      }
      let exactKey: string | undefined;
      if (group && !splitTiming && typeof workerCeiling === "number" && hasExactSelection) {
        const env = sampledEnv;
        if (
          extensionGroup &&
          group.configs.length === 1 &&
          innerParallelism !== undefined &&
          parallelQualified
        ) {
          exactKey = createExtensionTestTimingKey(group.configs[0]!, selectedFiles, env);
        } else if (workerCeiling === 2 && key.endsWith("#file-parallel-2")) {
          // PR descriptors prove this selected inventory, never an unsplit family total.
          // Eight-worker command placement rewrites the name after its selector is made.
          exactKey = createCompactSplitTimingGeneration({
            configs: group.configs,
            env,
            parentShardName: key,
            stripes: [selectedFiles],
          }).timingKeys[0];
        }
      }
      if (
        extensionGroup &&
        exactKey &&
        group &&
        singletonLog?.key === key &&
        innerParallelism === 1 &&
        !runtimeModes.has(key)
      ) {
        const invocations = readSingletonVitestInvocations(
          singletonLog.lines,
          group.configs[0]!,
          group.includePatterns!,
        );
        if (invocations) {
          const total = [...invocations.values()].reduce((sum, value) => sum + value, 0);
          const overhead = (Date.parse(timestamp) - started) / 1000 - total;
          if (overhead >= 0) {
            const env = sampledEnv;
            for (const [file, duration] of invocations) {
              recordSample(
                samples[profile],
                createExtensionTestTimingKey(
                  group.configs[0]!,
                  [file],
                  env,
                  "singleton-invocation",
                )!,
                duration,
              );
            }
            recordSample(
              samples[profile],
              createExtensionTestTimingKey(group.configs[0]!, [], env, "wrapper-overhead")!,
              overhead,
            );
          }
        }
      }
      const nativeSoloKey =
        nativeSoloHost &&
        group &&
        hasExactSelection &&
        workerCeiling === NATIVE_SOLO_TIMING_PROFILE.maxWorkers &&
        !runtimeModes.has(key) &&
        singletonLog?.key === key &&
        readSingletonVitestInvocations(singletonLog.lines, group.configs[0]!, selectedFiles)
          ? createNativeSoloTimingKey(group)
          : undefined;
      const measuredKeys = [
        ...(nativeSoloKey ? [nativeSoloKey] : []),
        ...(!extensionGroup && (!exactInventoryOnly || matchesSplitSelection) ? [key] : []),
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
      if (
        group &&
        workerCeiling !== null &&
        (!extensionGroup || (innerParallelism !== undefined && parallelQualified))
      ) {
        const observation = {
          configs: group.configs,
          env: Object.fromEntries(
            Object.entries(sampledEnv).toSorted(([a], [b]) => a.localeCompare(b)),
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
    for (const [shard, log] of singletonLogs) {
      if (log.key === key) {
        singletonLogs.delete(shard);
      }
    }
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
      if (log.kind === "release-packed") {
        readPackedReleaseLog(text, log.labels, current.github);
      } else if (log.kind === "tooling") {
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
        if (run.pullRequestMergeRef) {
          const profile = log.labels.some((label) => label.startsWith("blacksmith-"))
            ? "toolingBlacksmith"
            : "toolingGithub";
          readToolingLog(text, current[profile]);
        }
      } else {
        readE2eLog(text, current[log.kind], log.kind === "uiE2e" ? overhead : undefined);
      }
    }
    for (const profile of ["blacksmith", "github"] as const) {
      recordCompleteParentSamples(
        current[profile],
        observedParents[profile],
        !run.pullRequestMergeRef && !run.logs.some((log) => log.kind === "release-packed"),
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
    [...uniqueRuns.values()]
      .filter(
        (run) => run.completeInventory && !run.logs.some((log) => log.kind === "release-packed"),
      )
      .map((run) => run.id),
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
