// Committed CI measurements are advisory weights, never a test inventory.
import fs from "node:fs";
import {
  ciTestTimingsSchema,
  isRuntimePlacementIncludePatterns,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "./ci-test-timings-schema.mts";
import { parseCompactSplitTimingKey } from "./vitest-shard-metadata.mts";

const emptyUiTimings = { fileSeconds: {}, perFileOverheadSeconds: 0 };
const emptyGroupTimings: Readonly<Record<string, number>> = {};
const emptyRuntimeTimings: readonly RuntimePlacementTiming[] = [];
const runtimeSecondsCache = new WeakMap<object, Map<string, Readonly<Record<string, number>>>>();
const runtimePlacementCache = new WeakMap<object, Map<string, readonly RuntimePlacementTiming[]>>();
let cachedTimings: CiTestTimings | null | undefined;
let cachedReadFileSync: typeof fs.readFileSync | undefined;

function readTestTimings(): CiTestTimings | null {
  if (process.env.OPENCLAW_CI_TEST_TIMINGS === "0") {
    return null;
  }
  // Builtin export synchronization can replace the reader in a long-lived process.
  // Cache one parse per reader so a replacement cannot inherit stale bytes.
  if (cachedTimings === undefined || cachedReadFileSync !== fs.readFileSync) {
    cachedReadFileSync = fs.readFileSync;
    try {
      // Every independent shard must read the same checkout bytes, not a
      // restored cache or downloaded artifact that may differ between jobs.
      cachedTimings = ciTestTimingsSchema.parse(
        JSON.parse(
          fs.readFileSync(new URL("../../config/ci-test-timings.json", import.meta.url), "utf8"),
        ),
      );
    } catch {
      cachedTimings = null;
    }
  }
  return cachedTimings;
}

export function readUiE2eFileTimings(): {
  readonly fileSeconds: Readonly<Record<string, number>>;
  readonly perFileOverheadSeconds: number;
} {
  return readTestTimings()?.uiE2e ?? emptyUiTimings;
}

function selectedTimingPrefix(): string {
  const policy = process.env.OPENCLAW_CI_TEST_RUNTIME_POLICY;
  return policy === "bun-all" || policy === "dual-all" ? `${policy}:` : "";
}

function runtimeSeconds(
  timings: Readonly<Record<string, number>>,
): Readonly<Record<string, number>> {
  const prefix = selectedTimingPrefix();
  const cached =
    runtimeSecondsCache.get(timings) ?? new Map<string, Readonly<Record<string, number>>>();
  if (cached.has(prefix)) {
    return cached.get(prefix)!;
  }
  const entries = Object.entries(timings);
  // Cold policies retain historical scheduling estimates until matching runtime
  // samples arrive. These are never promoted to qualified runtime observations.
  const selected = Object.fromEntries([
    ...entries.filter(([key]) => !/^(?:bun-all|bun-native|node-subset|dual-all|bun):/u.test(key)),
    ...entries
      .filter(([key]) => prefix && key.startsWith(prefix))
      .map(([key, seconds]) => [key.slice(prefix.length), seconds]),
  ]);
  cached.set(prefix, selected);
  runtimeSecondsCache.set(timings, cached);
  return selected;
}

export function readToolingFileTimings(
  profile: "blacksmith" | "github",
): Readonly<Record<string, number>> {
  return runtimeSeconds(readTestTimings()?.toolingFileSeconds[profile] ?? emptyGroupTimings);
}

export function readCompactGroupTimings(
  profile: "blacksmith" | "github",
): Readonly<Record<string, number>> {
  return runtimeSeconds(readTestTimings()?.compactGroupSeconds[profile] ?? emptyGroupTimings);
}

export function readRepoE2eFileTimings(): Readonly<Record<string, number>> {
  return readTestTimings()?.repoE2eFileSeconds ?? emptyGroupTimings;
}

export function readRuntimePlacementTimings(
  profile: "blacksmith" | "github",
): readonly RuntimePlacementTiming[] {
  const runtime = selectedTimingPrefix().slice(0, -1);
  const observations = readTestTimings()?.runtimePlacementTimings[profile] ?? emptyRuntimeTimings;
  const cached =
    runtimePlacementCache.get(observations) ?? new Map<string, readonly RuntimePlacementTiming[]>();
  if (cached.has(runtime)) {
    return cached.get(runtime)!;
  }
  const selected = observations.flatMap((observation) => {
    const { OPENCLAW_CI_TEST_RUNTIME_POLICY: measuredRuntime = "", ...env } = observation.env;
    return measuredRuntime === runtime ? [{ ...observation, env }] : [];
  });
  cached.set(runtime, selected);
  runtimePlacementCache.set(observations, cached);
  return selected;
}

export function resolveRuntimePlacementSeconds(
  group: {
    configs: readonly string[];
    env?: Readonly<Record<string, string>>;
    includePatterns?: readonly string[];
    pretestBuildMode?: "runtime" | "private-qa";
  },
  observations: readonly RuntimePlacementTiming[],
): number | undefined {
  if (!group.pretestBuildMode || !isRuntimePlacementIncludePatterns(group.includePatterns)) {
    return undefined;
  }
  const files = new Set(group.includePatterns);
  const env = group.env ?? {};
  let contained: number | undefined;
  for (const observation of observations) {
    if (
      observation.pretestBuildMode !== group.pretestBuildMode ||
      observation.configs.length !== group.configs.length ||
      !observation.configs.every((config, index) => config === group.configs[index]) ||
      Object.keys(observation.env).length !== Object.keys(env).length ||
      !Object.entries(observation.env).every(([key, value]) => env[key] === value) ||
      !observation.includePatterns.every((file) => files.has(file))
    ) {
      continue;
    }
    // A newer exact measurement can be faster than an older contained workload.
    if (observation.includePatterns.length === files.size) {
      return observation.seconds;
    }
    contained = Math.max(contained ?? 0, observation.seconds);
  }
  return contained;
}

export function readCompleteSplitGenerationSeconds(
  timings: Readonly<Record<string, number>>,
  selectorKey: string,
): number | undefined {
  const generations = new Map<string, { expected: number; parts: Map<number, number> }>();
  const prefix = `${selectorKey}#generation-`;
  for (const [key, seconds] of Object.entries(timings)) {
    if (!key.startsWith(prefix)) {
      continue;
    }
    const parsed = parseCompactSplitTimingKey(key);
    if (!parsed || parsed.selectorKey !== selectorKey) {
      continue;
    }
    const current = generations.get(parsed.generationKey) ?? {
      expected: parsed.expectedParts,
      parts: new Map(),
    };
    current.parts.set(parsed.part, seconds);
    generations.set(parsed.generationKey, current);
  }
  const completeTotals = [...generations.values()]
    .filter(({ expected, parts }) => parts.size === expected)
    .map(({ parts }) => [...parts.values()].reduce((total, seconds) => total + seconds, 0));
  return completeTotals.length > 0 ? Math.max(...completeTotals) : undefined;
}
