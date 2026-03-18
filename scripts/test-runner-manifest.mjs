import fs from "node:fs";
import path from "node:path";

export const behaviorManifestPath = "test/fixtures/test-parallel.behavior.json";
export const unitTimingManifestPath = "test/fixtures/test-timings.unit.json";

const defaultTimingManifest = {
  config: "vitest.unit.config.ts",
  defaultDurationMs: 250,
  files: {},
};

const readJson = (filePath, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
};

const normalizeRepoPath = (value) => value.split(path.sep).join("/");

const normalizeManifestEntries = (entries) =>
  entries
    .map((entry) =>
      typeof entry === "string"
        ? { file: normalizeRepoPath(entry), reason: "" }
        : {
            file: normalizeRepoPath(String(entry?.file ?? "")),
            reason: typeof entry?.reason === "string" ? entry.reason : "",
          },
    )
    .filter((entry) => entry.file.length > 0);

export function loadTestRunnerBehavior() {
  const raw = readJson(behaviorManifestPath, {});
  const unit = raw.unit ?? {};
  return {
    unit: {
      isolated: normalizeManifestEntries(unit.isolated ?? []),
      singletonIsolated: normalizeManifestEntries(unit.singletonIsolated ?? []),
      threadSingleton: normalizeManifestEntries(unit.threadSingleton ?? []),
      vmForkSingleton: normalizeManifestEntries(unit.vmForkSingleton ?? []),
    },
  };
}

export function loadUnitTimingManifest() {
  const raw = readJson(unitTimingManifestPath, defaultTimingManifest);
  const defaultDurationMs =
    Number.isFinite(raw.defaultDurationMs) && raw.defaultDurationMs > 0
      ? raw.defaultDurationMs
      : defaultTimingManifest.defaultDurationMs;
  const files = Object.fromEntries(
    Object.entries(raw.files ?? {})
      .map(([file, value]) => {
        const normalizedFile = normalizeRepoPath(file);
        const durationMs =
          Number.isFinite(value?.durationMs) && value.durationMs >= 0 ? value.durationMs : null;
        const testCount =
          Number.isFinite(value?.testCount) && value.testCount >= 0 ? value.testCount : null;
        if (!durationMs) {
          return [normalizedFile, null];
        }
        return [
          normalizedFile,
          {
            durationMs,
            ...(testCount !== null ? { testCount } : {}),
          },
        ];
      })
      .filter(([, value]) => value !== null),
  );

  return {
    config:
      typeof raw.config === "string" && raw.config ? raw.config : defaultTimingManifest.config,
    generatedAt: typeof raw.generatedAt === "string" ? raw.generatedAt : "",
    defaultDurationMs,
    files,
  };
}

export function selectTimedHeavyFiles({
  candidates,
  limit,
  minDurationMs,
  exclude = new Set(),
  timings,
}) {
  return candidates
    .filter((file) => !exclude.has(file))
    .map((file) => ({
      file,
      durationMs: timings.files[file]?.durationMs ?? timings.defaultDurationMs,
      known: Boolean(timings.files[file]),
    }))
    .filter((entry) => entry.known && entry.durationMs >= minDurationMs)
    .toSorted((a, b) => b.durationMs - a.durationMs)
    .slice(0, limit)
    .map((entry) => entry.file);
}

export function packFilesByDuration(files, bucketCount, estimateDurationMs) {
  const normalizedBucketCount = Math.max(0, Math.floor(bucketCount));
  if (normalizedBucketCount <= 0 || files.length === 0) {
    return [];
  }

  const buckets = Array.from({ length: Math.min(normalizedBucketCount, files.length) }, () => ({
    totalMs: 0,
    files: [],
  }));

  const sortedFiles = [...files].toSorted((left, right) => {
    return estimateDurationMs(right) - estimateDurationMs(left);
  });

  for (const file of sortedFiles) {
    const bucket = buckets.reduce((lightest, current) =>
      current.totalMs < lightest.totalMs ? current : lightest,
    );
    bucket.files.push(file);
    bucket.totalMs += estimateDurationMs(file);
  }

  return buckets.map((bucket) => bucket.files).filter((bucket) => bucket.length > 0);
}
