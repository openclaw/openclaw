export type RuntimePlacementTiming = {
  configs: string[];
  env: Record<string, string>;
  includePatterns: string[];
  pretestBuildMode: "runtime" | "private-qa";
  seconds: number;
};

export function runtimePlacementTimingIdentity(
  group: Omit<RuntimePlacementTiming, "seconds">,
): string {
  return JSON.stringify({
    configs: group.configs,
    env: Object.entries(group.env).toSorted(([a], [b]) => a.localeCompare(b)),
    includePatterns: group.includePatterns.toSorted(),
    pretestBuildMode: group.pretestBuildMode,
  });
}

export type CiTestTimings = {
  compactGroupSeconds: {
    blacksmith: Record<string, number>;
    github: Record<string, number>;
    githubPullRequest?: Record<string, number>;
  };
  runtimePlacementTimings: {
    blacksmith: RuntimePlacementTiming[];
    github: RuntimePlacementTiming[];
  };
  repoE2eFileSeconds: Record<string, number>;
  source: string;
  toolingFileSeconds: { blacksmith: Record<string, number>; github: Record<string, number> };
  uiE2e: { fileSeconds: Record<string, number>; perFileOverheadSeconds: number };
  updatedAt: string;
  version: 1;
};

// PR preflight imports this closure before installing dependencies; even
// workspace coercion helpers are unavailable to its bare Node process.
function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSecondsMap(value: unknown): value is Record<string, number> {
  return (
    isRecord(value) &&
    Object.entries(value).every(
      ([key, seconds]) =>
        key.length > 0 &&
        typeof seconds === "number" &&
        Number.isSafeInteger(seconds) &&
        seconds > 0,
    )
  );
}

function isNonemptyStrings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0)
  );
}

export function isRuntimePlacementIncludePatterns(value: unknown): value is string[] {
  return (
    isNonemptyStrings(value) &&
    // Match explicit test-target syntax without importing the test-project planner.
    value.every(
      (file) => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(file) && !/[*?[\]{}]|[@+!]\(/u.test(file),
    ) &&
    new Set(value).size === value.length
  );
}

export function isRuntimePlacementTiming(value: unknown): value is RuntimePlacementTiming {
  return (
    isRecord(value) &&
    hasExactKeys(value, ["configs", "env", "includePatterns", "pretestBuildMode", "seconds"]) &&
    isNonemptyStrings(value.configs) &&
    isRecord(value.env) &&
    Object.entries(value.env).every(
      ([key, entry]) => key.length > 0 && typeof entry === "string",
    ) &&
    isRuntimePlacementIncludePatterns(value.includePatterns) &&
    (value.pretestBuildMode === "runtime" || value.pretestBuildMode === "private-qa") &&
    typeof value.seconds === "number" &&
    Number.isSafeInteger(value.seconds) &&
    value.seconds > 0
  );
}

function isRuntimePlacementTimings(value: unknown): value is RuntimePlacementTiming[] {
  return (
    Array.isArray(value) &&
    value.every(isRuntimePlacementTiming) &&
    new Set(value.map(runtimePlacementTimingIdentity)).size === value.length
  );
}

function isCiTestTimings(value: unknown): value is CiTestTimings {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "compactGroupSeconds",
      "runtimePlacementTimings",
      "repoE2eFileSeconds",
      "source",
      "toolingFileSeconds",
      "uiE2e",
      "updatedAt",
      "version",
    ])
  ) {
    return false;
  }
  const {
    compactGroupSeconds,
    runtimePlacementTimings,
    repoE2eFileSeconds,
    source,
    toolingFileSeconds,
    uiE2e,
    updatedAt,
    version,
  } = value;
  return (
    version === 1 &&
    typeof source === "string" &&
    source.length > 0 &&
    typeof updatedAt === "string" &&
    /^\d{4}-\d{2}-\d{2}$/u.test(updatedAt) &&
    Number.isFinite(Date.parse(updatedAt)) &&
    // Date parsing normalizes impossible days; round-trip to reject them.
    new Date(updatedAt).toISOString().slice(0, 10) === updatedAt &&
    isRecord(uiE2e) &&
    hasExactKeys(uiE2e, ["fileSeconds", "perFileOverheadSeconds"]) &&
    typeof uiE2e.perFileOverheadSeconds === "number" &&
    Number.isFinite(uiE2e.perFileOverheadSeconds) &&
    uiE2e.perFileOverheadSeconds >= 0 &&
    uiE2e.perFileOverheadSeconds <= 5 &&
    isSecondsMap(uiE2e.fileSeconds) &&
    isSecondsMap(repoE2eFileSeconds) &&
    isRecord(toolingFileSeconds) &&
    hasExactKeys(toolingFileSeconds, ["blacksmith", "github"]) &&
    isSecondsMap(toolingFileSeconds.blacksmith) &&
    isSecondsMap(toolingFileSeconds.github) &&
    isRecord(compactGroupSeconds) &&
    hasExactKeys(compactGroupSeconds, [
      "blacksmith",
      "github",
      ...(Object.hasOwn(compactGroupSeconds, "githubPullRequest") ? ["githubPullRequest"] : []),
    ]) &&
    isSecondsMap(compactGroupSeconds.blacksmith) &&
    isSecondsMap(compactGroupSeconds.github) &&
    (!Object.hasOwn(compactGroupSeconds, "githubPullRequest") ||
      isSecondsMap(compactGroupSeconds.githubPullRequest)) &&
    isRecord(runtimePlacementTimings) &&
    hasExactKeys(runtimePlacementTimings, ["blacksmith", "github"]) &&
    isRuntimePlacementTimings(runtimePlacementTimings.blacksmith) &&
    isRuntimePlacementTimings(runtimePlacementTimings.github)
  );
}

export const ciTestTimingsSchema = {
  parse(value: unknown): CiTestTimings {
    if (!isCiTestTimings(value)) {
      throw new TypeError("Invalid CI test timings");
    }
    return value;
  },
};
