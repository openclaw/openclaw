// Committed CI measurements are advisory weights, never a test inventory.
import fs from "node:fs";
import {
  ciTestTimingsSchema,
  isRuntimePlacementIncludePatterns,
  type CiTestTimings,
  type RuntimePlacementTiming,
} from "./ci-test-timings-schema.mts";

const emptyUiTimings = { fileSeconds: {}, perFileOverheadSeconds: 0 };
const emptyGroupTimings: Readonly<Record<string, number>> = {};
const emptyRuntimeTimings: readonly RuntimePlacementTiming[] = [];
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

export function readCompactGroupTimings(
  profile: "blacksmith" | "github",
): Readonly<Record<string, number>> {
  return readTestTimings()?.compactGroupSeconds[profile] ?? emptyGroupTimings;
}

export function readRepoE2eFileTimings(): Readonly<Record<string, number>> {
  return readTestTimings()?.repoE2eFileSeconds ?? emptyGroupTimings;
}

export function readRuntimePlacementTimings(
  profile: "blacksmith" | "github",
): readonly RuntimePlacementTiming[] {
  return readTestTimings()?.runtimePlacementTimings[profile] ?? emptyRuntimeTimings;
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
