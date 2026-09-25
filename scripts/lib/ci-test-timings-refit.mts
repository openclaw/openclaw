import { stripVTControlCharacters } from "node:util";
import { decodeNodeTestGroups } from "./ci-node-test-groups-codec.mts";
import {
  isRuntimePlacementTiming,
  runtimePlacementTimingIdentity,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "./ci-test-timings-schema.mts";
import {
  compactGroupMembershipTimingKey,
  parseCompactSplitTimingKey,
} from "./vitest-shard-metadata.mts";

export type CiTimingRun = {
  id: number;
  createdAt: string;
  /** Failed workflows supply positive samples, never evidence that absent keys disappeared. */
  completeInventory: boolean;
  logs: (
    | { kind: "uiE2e" | "repoE2e"; text: string }
    | {
        kind: "compact" | "compactPullRequest" | "tooling";
        text: string;
        labels: string[];
        completeJob?: boolean;
      }
  )[];
};

type Samples = Map<string, number[]>;

type RuntimeTimingGroup = {
  shard_name: string;
  timing_key?: string;
  configs: string[];
  includePatterns: string[];
  env?: Record<string, string>;
};

function readRuntimeTimingGroups(text: string): RuntimeTimingGroup[] {
  const encoded = new Set(
    [
      ...text.matchAll(
        /\d{4}-\d\d-\d\dT[\d:.]+Z\s+OPENCLAW_NODE_TEST_GROUPS_GZIP_BASE64: (\S+)$/gmu,
      ),
    ].map((match) => match[1]!),
  );
  if (encoded.size !== 1) {
    return [];
  }
  try {
    const groups = decodeNodeTestGroups([...encoded][0]!);
    const strings = (value: unknown): value is string[] =>
      Array.isArray(value) && value.every((entry) => typeof entry === "string");
    return groups.filter((group): group is RuntimeTimingGroup => {
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
        "includePatterns" in group &&
        strings(group.includePatterns) &&
        group.includePatterns.length > 0 &&
        (!("env" in group) ||
          (typeof group.env === "object" &&
            group.env !== null &&
            !Array.isArray(group.env) &&
            Object.values(group.env).every((value) => typeof value === "string")))
      );
    });
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
  samples: { blacksmith: Samples; github: Samples; githubPullRequest: Samples },
  runtimeSamples: { blacksmith: Samples; github: Samples },
  runtimeDescriptors: Map<string, RuntimePlacementTiming>,
  pullRequest = false,
  completeJob = false,
) {
  const profile = labels.some((label) => label.startsWith("blacksmith-"))
    ? "blacksmith"
    : pullRequest
      ? "githubPullRequest"
      : "github";
  const aggregate = profile === "githubPullRequest";
  const policies = new Set(
    [
      ...text.matchAll(
        /(?:^|\n)\d{4}-\d\d-\d\dT[\d:.]+Z\s+OPENCLAW_CI_TEST_RUNTIME_POLICY: (\S+)\s*(?=\n|$)/gu,
      ),
    ].map((match) => match[1]),
  );
  const policy = policies.size === 0 ? "node" : policies.size === 1 ? [...policies][0] : undefined;
  if (aggregate && !["node", "bun-compatible", "dual"].includes(policy ?? "")) {
    return;
  }
  const starts = new Map<string, number>();
  const descriptors = readRuntimeTimingGroups(text);
  const runtimeModes = new Map<string, "runtime" | "private-qa">();
  const recordSpan = (key: string, elapsed: number) => {
    recordSample(samples[profile], key, elapsed);
    const matches = descriptors.filter((group) => (group.timing_key ?? group.shard_name) === key);
    if (matches.length !== 1) {
      return;
    }
    const group = matches[0]!;
    if (profile === "githubPullRequest") {
      const membershipKey = compactGroupMembershipTimingKey(group);
      if (membershipKey) {
        recordSample(samples[profile], membershipKey, elapsed);
      }
    }
    const observation = {
      configs: group.configs,
      env: Object.fromEntries(
        Object.entries(group.env ?? {}).toSorted(([a], [b]) => a.localeCompare(b)),
      ),
      includePatterns: group.includePatterns.toSorted(),
      pretestBuildMode: runtimeModes.get(key),
      seconds: Math.max(1, Math.round(elapsed)),
    };
    if (profile !== "githubPullRequest" && isRuntimePlacementTiming(observation)) {
      const identity = runtimePlacementTimingIdentity(observation);
      runtimeDescriptors.set(identity, observation);
      recordSample(runtimeSamples[profile], identity, elapsed);
    }
  };
  const logicalKey = (key: string) => key.replace(/^(?:node-subset|bun):/u, "");
  const spans = new Map<string, Map<string, number[]>>();
  const failed = new Set<string>();
  const skippedNode = new Set<string>();
  for (const line of text.split("\n")) {
    const skipped =
      /\[shard:node-subset:([^\]]+)\] skipped \(native shard has no Node-only files\)/u.exec(line);
    if (aggregate && skipped) {
      const matches = descriptors.filter((group) => group.shard_name === skipped[1]);
      if (
        matches.length === 1 &&
        matches[0]!.configs.length === 1 &&
        matches[0]!.configs[0] === "ui/vitest.config.ts"
      ) {
        skippedNode.add(matches[0]!.timing_key ?? matches[0]!.shard_name);
      }
    }
    const readiness =
      /\[shard:([^\]]+)\] \[test\] preparing (runtime|private-qa) runtime before Vitest workers/u.exec(
        line,
      );
    if (readiness) {
      const name = aggregate ? logicalKey(readiness[1]!) : readiness[1]!;
      const matches = descriptors.filter((group) => group.shard_name === name);
      if (matches.length === 1) {
        const group = matches[0]!;
        const key = group.timing_key ?? group.shard_name;
        if (aggregate || starts.has(key)) {
          runtimeModes.set(key, readiness[2] === "private-qa" ? "private-qa" : "runtime");
        }
      }
    }
    const event =
      /(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+.*?\[shard:([^\]]+)\] (begin|end \(exit (\d+)\))/u.exec(line);
    if (!event) {
      continue;
    }
    const timestamp = Date.parse(event[1]!);
    const key = event[2]!;
    const owner = logicalKey(key);
    if (event[3] === "begin") {
      if (aggregate && starts.has(key)) {
        failed.add(owner);
      }
      if (!aggregate) {
        runtimeModes.delete(key);
      }
      starts.set(key, timestamp);
      continue;
    }
    const started = starts.get(key);
    if (!aggregate) {
      if (event[4] === "0" && started !== undefined) {
        recordSpan(key, (timestamp - started) / 1000);
      }
      starts.delete(key);
      continue;
    }
    if (event[4] !== "0" || started === undefined) {
      failed.add(owner);
    } else {
      const parts = spans.get(owner) ?? new Map<string, number[]>();
      const values = parts.get(key) ?? [];
      values.push((timestamp - started) / 1000);
      parts.set(key, values);
      spans.set(owner, parts);
    }
    starts.delete(key);
  }
  if (!aggregate) {
    return;
  }
  for (const key of starts.keys()) {
    failed.add(logicalKey(key));
  }
  for (const [key, parts] of spans) {
    if (failed.has(key)) {
      continue;
    }
    if (policy === "dual" && !completeJob && !parts.has(`bun:${key}`)) {
      continue;
    }
    const mixed = parts.has(`bun:${key}`) || parts.has(`node-subset:${key}`);
    // Both ordinary runtime children settle even after one fails. A successful
    // whole job also proves pure-Bun and UI's Bun-first/empty-Node envelopes.
    if (
      mixed &&
      !completeJob &&
      !(
        parts.has(`bun:${key}`) &&
        (parts.has(`node-subset:${key}`) || parts.has(key) || skippedNode.has(key))
      )
    ) {
      continue;
    }
    const elapsed = [...parts.values()].reduce((total, values) => total + median(values), 0);
    recordSpan(key, elapsed);
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
          declaredFiles: new Set(descriptor.includePatterns),
          singletonFile:
            !active.has(shard) &&
            descriptor.configs.length === 1 &&
            descriptor.configs[0] === "test/vitest/vitest.tooling.config.ts" &&
            descriptor.includePatterns.length === 1
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

function recordCompleteParentSamples(samples: Samples, observedParents: Set<string>) {
  const generations = new Map<
    string,
    { parent: string; expected: number; parts: Map<number, number> }
  >();
  for (const [key, values] of samples) {
    const parsed = parseCompactSplitTimingKey(key);
    if (!parsed || parsed.parentShardName.endsWith("#membership")) {
      continue;
    }
    observedParents.add(parsed.parentShardName);
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
  onlyIncrease = false,
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
      const measured = Math.max(onlyIncrease ? (previous[key] ?? 0) : 0, median(retained));
      if (
        previous[key] === undefined ||
        (onlyIncrease && measured > previous[key]) ||
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
  options: { seedTooling?: boolean; seedPullRequest?: boolean } = {},
) {
  const samples = {
    uiE2e: new Map<string, number[]>(),
    repoE2e: new Map<string, number[]>(),
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
    githubPullRequest: new Map<string, number[]>(),
    toolingBlacksmith: new Map<string, number[]>(),
    toolingGithub: new Map<string, number[]>(),
  };
  const contributingRuns = {
    uiE2e: new Set<number>(),
    repoE2e: new Set<number>(),
    blacksmith: new Set<number>(),
    github: new Set<number>(),
    githubPullRequest: new Set<number>(),
    toolingBlacksmith: new Set<number>(),
    toolingGithub: new Set<number>(),
  };
  const overhead: number[] = [];
  const observedParents = {
    blacksmith: new Set<string>(),
    github: new Set<string>(),
    githubPullRequest: new Set<string>(),
  };
  const runtimeSamples = {
    blacksmith: new Map<string, number[]>(),
    github: new Map<string, number[]>(),
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
      githubPullRequest: new Map<string, number[]>(),
      toolingBlacksmith: new Map<string, number[]>(),
      toolingGithub: new Map<string, number[]>(),
    };
    const currentRuntime = {
      blacksmith: new Map<string, number[]>(),
      github: new Map<string, number[]>(),
    };
    for (const log of run.logs) {
      const text = stripVTControlCharacters(log.text);
      if (log.kind === "tooling") {
        const profile = log.labels.some((label) => label.startsWith("blacksmith-"))
          ? "toolingBlacksmith"
          : "toolingGithub";
        readToolingLog(text, current[profile]);
      } else if (log.kind === "compact" || log.kind === "compactPullRequest") {
        readCompactLog(
          text,
          log.labels,
          current,
          currentRuntime,
          runtimeDescriptors,
          log.kind === "compactPullRequest",
          log.completeJob === true,
        );
      } else {
        readE2eLog(text, current[log.kind], log.kind === "uiE2e" ? overhead : undefined);
      }
    }
    for (const profile of ["blacksmith", "github"] as const) {
      recordCompleteParentSamples(current[profile], observedParents[profile]);
      for (const [identity, values] of currentRuntime[profile]) {
        recordSample(runtimeSamples[profile], identity, median(values));
      }
    }
    recordCompleteParentSamples(current.githubPullRequest, observedParents.githubPullRequest);
    // Retries or duplicate reporter lines in one run must not satisfy the two-run minimum.
    for (const profile of [
      "uiE2e",
      "repoE2e",
      "blacksmith",
      "github",
      "githubPullRequest",
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
      ...(previous?.compactGroupSeconds.githubPullRequest || contributingRuns.githubPullRequest.size
        ? {
            githubPullRequest: refitMap(
              samples.githubPullRequest,
              previous?.compactGroupSeconds.githubPullRequest,
              // Successful PRs can omit whole families through changed-path selection.
              0,
              observedParents.githubPullRequest,
              options.seedPullRequest ? 1 : 2,
              false,
              options.seedPullRequest === true,
            ),
          }
        : {}),
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
    source: options.seedPullRequest
      ? `hosted PR qualification seed from complete descriptor spans: ${runIds.join(", ")}; retained other timings: ${previous?.source ?? "none"}`
      : options.seedTooling
        ? `tooling seed from successful pull_request CI merge-ref runs: ${runIds.join(", ")}; retained other timings: ${previous?.source ?? "none"}`
        : `median of successful timing jobs from ${runIds.length} CI and release-check runs: ${runIds.join(", ")}`,
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
    [
      "compactGroupSeconds.githubPullRequest",
      timings.compactGroupSeconds.githubPullRequest ?? {},
      previous?.compactGroupSeconds.githubPullRequest,
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
    contributingRunIds: {
      blacksmith: [...contributingRuns.blacksmith].toSorted((a, b) => a - b),
      github: [...contributingRuns.github].toSorted((a, b) => a - b),
      githubPullRequest: [...contributingRuns.githubPullRequest].toSorted((a, b) => a - b),
      repoE2e: [...contributingRuns.repoE2e].toSorted((a, b) => a - b),
      uiE2e: [...contributingRuns.uiE2e].toSorted((a, b) => a - b),
      toolingBlacksmith: [...contributingRuns.toolingBlacksmith].toSorted((a, b) => a - b),
      toolingGithub: [...contributingRuns.toolingGithub].toSorted((a, b) => a - b),
    },
  };
}
