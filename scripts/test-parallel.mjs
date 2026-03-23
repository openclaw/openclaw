import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { channelTestPrefixes } from "../vitest.channel-paths.mjs";
import { isUnitConfigTestFile } from "../vitest.unit-paths.mjs";
import {
  getProcessTreeRecords,
  parseCompletedTestFileLines,
  sampleProcessTreeRssKb,
} from "./test-parallel-memory.mjs";
import {
  appendCapturedOutput,
  hasFatalTestRunOutput,
  resolveTestRunExitCode,
} from "./test-parallel-utils.mjs";
import {
  dedupeFilesPreserveOrder,
  loadUnitMemoryHotspotManifest,
  loadTestRunnerBehavior,
  loadUnitTimingManifest,
  selectUnitHeavyFileGroups,
  packFilesByDuration,
} from "./test-runner-manifest.mjs";

// On Windows, `.cmd` launchers can fail with `spawn EINVAL` when invoked without a shell
// (especially under GitHub Actions + Git Bash). Use `shell: true` and let the shell resolve pnpm.
const pnpm = "pnpm";
const behaviorManifest = loadTestRunnerBehavior();
const existingFiles = (entries) =>
  entries.map((entry) => entry.file).filter((file) => fs.existsSync(file));
let tempArtifactDir = null;
const ensureTempArtifactDir = () => {
  if (tempArtifactDir === null) {
    tempArtifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-test-parallel-"));
  }
  return tempArtifactDir;
};
const writeTempJsonArtifact = (name, value) => {
  const filePath = path.join(ensureTempArtifactDir(), `${name}.json`);
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf8");
  return filePath;
};
const cleanupTempArtifacts = () => {
  if (tempArtifactDir === null) {
    return;
  }
  fs.rmSync(tempArtifactDir, { recursive: true, force: true });
  tempArtifactDir = null;
};
const existingUnitConfigFiles = (entries) => existingFiles(entries).filter(isUnitConfigTestFile);
const baseThreadPinnedFiles = existingFiles(behaviorManifest.base?.threadPinned ?? []);
const extensionForkIsolatedFiles = existingFiles(behaviorManifest.extensions?.isolated ?? []);
const unitForkIsolatedFiles = existingUnitConfigFiles(behaviorManifest.unit.isolated);
const unitThreadPinnedFiles = existingUnitConfigFiles(behaviorManifest.unit.threadPinned);
const unitBehaviorOverrideSet = new Set([...unitForkIsolatedFiles, ...unitThreadPinnedFiles]);
const channelSingletonFiles = [];

const children = new Set();
const isCI = process.env.CI === "true" || process.env.GITHUB_ACTIONS === "true";
const isMacOS = process.platform === "darwin" || process.env.RUNNER_OS === "macOS";
const isWindows = process.platform === "win32" || process.env.RUNNER_OS === "Windows";
const isWindowsCi = isCI && isWindows;
const hostCpuCount = os.cpus().length;
const hostMemoryGiB = Math.floor(os.totalmem() / 1024 ** 3);
// Keep aggressive local defaults for high-memory workstations (Mac Studio class).
const highMemLocalHost = !isCI && hostMemoryGiB >= 96;
const lowMemLocalHost = !isCI && hostMemoryGiB < 64;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "", 10);
const rawTestProfile = process.env.OPENCLAW_TEST_PROFILE?.trim().toLowerCase();
const testProfile =
  rawTestProfile === "low" ||
  rawTestProfile === "macmini" ||
  rawTestProfile === "max" ||
  rawTestProfile === "normal" ||
  rawTestProfile === "serial"
    ? rawTestProfile
    : "normal";
const isMacMiniProfile = testProfile === "macmini";
// Vitest executes Node tests through Vite's SSR/module-runner pipeline, so the
// shared unit lane still retains transformed ESM/module state even when the
// tests themselves are not "server rendering" a website. We previously kept
// forks as the default after VM-pool regressions on constrained hosts. On
// 2026-03-22, a direct full-unit threads run finished 1109/1110 green; the sole
// correctness exception stayed on the manifest fork lane, so the wrapper now
// defaults unit runs to threads while preserving explicit fork escapes.
const forceIsolation =
  process.env.OPENCLAW_TEST_ISOLATE === "1" || process.env.OPENCLAW_TEST_ISOLATE === "true";
const disableIsolation =
  !forceIsolation &&
  process.env.OPENCLAW_TEST_NO_ISOLATE !== "0" &&
  process.env.OPENCLAW_TEST_NO_ISOLATE !== "false";
const includeGatewaySuite = process.env.OPENCLAW_TEST_INCLUDE_GATEWAY === "1";
const includeExtensionsSuite = process.env.OPENCLAW_TEST_INCLUDE_EXTENSIONS === "1";
const skipDefaultRuns = process.env.OPENCLAW_TEST_SKIP_DEFAULT === "1";
const parsePoolOverride = (value, fallback) => {
  if (value === "threads" || value === "forks") {
    return value;
  }
  return fallback;
};
// Even on low-memory hosts, keep the isolated lane split so files like
// git-commit.test.ts still get the worker/process isolation they require.
const shouldSplitUnitRuns = testProfile !== "serial";
let runs = [];
const shardOverride = Number.parseInt(process.env.OPENCLAW_TEST_SHARDS ?? "", 10);
const configuredShardCount =
  Number.isFinite(shardOverride) && shardOverride > 1 ? shardOverride : null;
const shardCount = configuredShardCount ?? (isWindowsCi ? 2 : 1);
const shardIndexOverride = (() => {
  const parsed = Number.parseInt(process.env.OPENCLAW_TEST_SHARD_INDEX ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
})();
const OPTION_TAKES_VALUE = new Set([
  "-t",
  "-c",
  "-r",
  "--testNamePattern",
  "--config",
  "--root",
  "--dir",
  "--reporter",
  "--outputFile",
  "--pool",
  "--execArgv",
  "--vmMemoryLimit",
  "--maxWorkers",
  "--environment",
  "--shard",
  "--changed",
  "--sequence",
  "--inspect",
  "--inspectBrk",
  "--testTimeout",
  "--hookTimeout",
  "--bail",
  "--retry",
  "--diff",
  "--exclude",
  "--project",
  "--slowTestThreshold",
  "--teardownTimeout",
  "--attachmentsDir",
  "--mode",
  "--api",
  "--browser",
  "--maxConcurrency",
  "--mergeReports",
  "--configLoader",
  "--experimental",
]);
const SINGLE_RUN_ONLY_FLAGS = new Set(["--coverage", "--outputFile", "--mergeReports"]);

if (shardIndexOverride !== null && shardCount <= 1) {
  console.error(
    `[test-parallel] OPENCLAW_TEST_SHARD_INDEX=${String(
      shardIndexOverride,
    )} requires OPENCLAW_TEST_SHARDS>1.`,
  );
  process.exit(2);
}

if (shardIndexOverride !== null && shardIndexOverride > shardCount) {
  console.error(
    `[test-parallel] OPENCLAW_TEST_SHARD_INDEX=${String(
      shardIndexOverride,
    )} exceeds OPENCLAW_TEST_SHARDS=${String(shardCount)}.`,
  );
  process.exit(2);
}
const windowsCiArgs = isWindowsCi ? ["--dangerouslyIgnoreUnhandledErrors"] : [];
const silentArgs =
  process.env.OPENCLAW_TEST_SHOW_PASSED_LOGS === "1" ? [] : ["--silent=passed-only"];
const rawPassthroughArgs = process.argv.slice(2);
const passthroughArgs =
  rawPassthroughArgs[0] === "--" ? rawPassthroughArgs.slice(1) : rawPassthroughArgs;
const parsePassthroughArgs = (args) => {
  const fileFilters = [];
  const optionArgs = [];
  let consumeNextAsOptionValue = false;

  for (const arg of args) {
    if (consumeNextAsOptionValue) {
      optionArgs.push(arg);
      consumeNextAsOptionValue = false;
      continue;
    }
    if (arg === "--") {
      optionArgs.push(arg);
      continue;
    }
    if (arg.startsWith("-")) {
      optionArgs.push(arg);
      consumeNextAsOptionValue = !arg.includes("=") && OPTION_TAKES_VALUE.has(arg);
      continue;
    }
    fileFilters.push(arg);
  }

  return { fileFilters, optionArgs };
};
const { fileFilters: passthroughFileFilters, optionArgs: passthroughOptionArgs } =
  parsePassthroughArgs(passthroughArgs);
const passthroughMetadataFlags = new Set(["-h", "--help", "--listTags", "--clearCache"]);
const passthroughMetadataOnly =
  passthroughArgs.length > 0 &&
  passthroughFileFilters.length === 0 &&
  passthroughOptionArgs.every((arg) => {
    if (!arg.startsWith("-")) {
      return false;
    }
    const [flag] = arg.split("=", 1);
    return passthroughMetadataFlags.has(flag);
  });
const countExplicitEntryFilters = (entryArgs) => {
  const { fileFilters } = parsePassthroughArgs(entryArgs.slice(2));
  return fileFilters.length > 0 ? fileFilters.length : null;
};
const getExplicitEntryFilters = (entryArgs) => parsePassthroughArgs(entryArgs.slice(2)).fileFilters;
const passthroughRequiresSingleRun = passthroughOptionArgs.some((arg) => {
  if (!arg.startsWith("-")) {
    return false;
  }
  const [flag] = arg.split("=", 1);
  return SINGLE_RUN_ONLY_FLAGS.has(flag);
});
const baseConfigPrefixes = ["src/agents/", "src/auto-reply/", "src/commands/", "test/", "ui/"];
const normalizeRepoPath = (value) => value.split(path.sep).join("/");
const walkTestFiles = (rootDir) => {
  if (!fs.existsSync(rootDir)) {
    return [];
  }
  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTestFiles(fullPath));
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    if (
      fullPath.endsWith(".test.ts") ||
      fullPath.endsWith(".live.test.ts") ||
      fullPath.endsWith(".e2e.test.ts")
    ) {
      files.push(normalizeRepoPath(fullPath));
    }
  }
  return files;
};
const allKnownTestFiles = [
  ...new Set([
    ...walkTestFiles("src"),
    ...walkTestFiles("extensions"),
    ...walkTestFiles("test"),
    ...walkTestFiles(path.join("ui", "src", "ui")),
  ]),
];
const defaultUnitPool = parsePoolOverride(process.env.OPENCLAW_TEST_UNIT_DEFAULT_POOL, "threads");
const isTargetedIsolatedUnitFile = (fileFilter) =>
  unitForkIsolatedFiles.includes(fileFilter) || unitMemoryIsolatedFiles.includes(fileFilter);
const inferTarget = (fileFilter) => {
  const isolated =
    isTargetedIsolatedUnitFile(fileFilter) || extensionForkIsolatedFiles.includes(fileFilter);
  if (isUnitConfigTestFile(fileFilter)) {
    return { owner: "unit", isolated };
  }
  if (fileFilter.endsWith(".live.test.ts")) {
    return { owner: "live", isolated };
  }
  if (fileFilter.endsWith(".e2e.test.ts")) {
    return { owner: "e2e", isolated };
  }
  if (channelTestPrefixes.some((prefix) => fileFilter.startsWith(prefix))) {
    return { owner: "channels", isolated };
  }
  if (fileFilter.startsWith("extensions/")) {
    return { owner: "extensions", isolated };
  }
  if (fileFilter.startsWith("src/gateway/")) {
    return { owner: "gateway", isolated };
  }
  if (baseConfigPrefixes.some((prefix) => fileFilter.startsWith(prefix))) {
    return { owner: "base", isolated };
  }
  if (fileFilter.startsWith("src/")) {
    return { owner: "unit", isolated };
  }
  return { owner: "base", isolated };
};
const unitTimingManifest = loadUnitTimingManifest();
const unitMemoryHotspotManifest = loadUnitMemoryHotspotManifest();
const parseEnvNumber = (name, fallback) => {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};
const allKnownUnitFiles = allKnownTestFiles.filter((file) => {
  return isUnitConfigTestFile(file);
});
const defaultHeavyUnitFileLimit =
  testProfile === "serial"
    ? 0
    : isMacMiniProfile
      ? 90
      : testProfile === "low"
        ? 36
        : highMemLocalHost
          ? 80
          : 60;
const defaultHeavyUnitLaneCount =
  testProfile === "serial"
    ? 0
    : isMacMiniProfile
      ? 6
      : testProfile === "low"
        ? 4
        : highMemLocalHost
          ? 5
          : 4;
const heavyUnitFileLimit = parseEnvNumber(
  "OPENCLAW_TEST_HEAVY_UNIT_FILE_LIMIT",
  defaultHeavyUnitFileLimit,
);
const heavyUnitLaneCount = parseEnvNumber(
  "OPENCLAW_TEST_HEAVY_UNIT_LANES",
  defaultHeavyUnitLaneCount,
);
const heavyUnitMinDurationMs = parseEnvNumber("OPENCLAW_TEST_HEAVY_UNIT_MIN_MS", 1200);
const defaultMemoryHeavyUnitFileLimit =
  testProfile === "serial" ? 0 : isCI ? 64 : testProfile === "low" ? 8 : 16;
const memoryHeavyUnitFileLimit = parseEnvNumber(
  "OPENCLAW_TEST_MEMORY_HEAVY_UNIT_FILE_LIMIT",
  defaultMemoryHeavyUnitFileLimit,
);
const memoryHeavyUnitMinDeltaKb = parseEnvNumber(
  "OPENCLAW_TEST_MEMORY_HEAVY_UNIT_MIN_KB",
  unitMemoryHotspotManifest.defaultMinDeltaKb,
);
const { memoryHeavyFiles: memoryHeavyUnitFiles, timedHeavyFiles: timedHeavyUnitFiles } =
  shouldSplitUnitRuns
    ? selectUnitHeavyFileGroups({
        candidates: allKnownUnitFiles,
        behaviorOverrides: unitBehaviorOverrideSet,
        timedLimit: heavyUnitFileLimit,
        timedMinDurationMs: heavyUnitMinDurationMs,
        memoryLimit: memoryHeavyUnitFileLimit,
        memoryMinDeltaKb: memoryHeavyUnitMinDeltaKb,
        timings: unitTimingManifest,
        hotspots: unitMemoryHotspotManifest,
      })
    : {
        memoryHeavyFiles: [],
        timedHeavyFiles: [],
      };
const unitMemoryIsolatedFiles = dedupeFilesPreserveOrder(
  memoryHeavyUnitFiles,
  unitBehaviorOverrideSet,
);
const unitSchedulingOverrideSet = new Set([...unitBehaviorOverrideSet, ...memoryHeavyUnitFiles]);
const unitFastExcludedFiles = [
  ...new Set([...unitSchedulingOverrideSet, ...timedHeavyUnitFiles, ...channelSingletonFiles]),
];
const estimateUnitDurationMs = (file) =>
  unitTimingManifest.files[file]?.durationMs ?? unitTimingManifest.defaultDurationMs;
const splitFilesByDurationBudget = (files, targetDurationMs, estimateDurationMs) => {
  if (!Number.isFinite(targetDurationMs) || targetDurationMs <= 0 || files.length <= 1) {
    return [files];
  }

  const batches = [];
  let currentBatch = [];
  let currentDurationMs = 0;

  for (const file of files) {
    const durationMs = estimateDurationMs(file);
    if (currentBatch.length > 0 && currentDurationMs + durationMs > targetDurationMs) {
      batches.push(currentBatch);
      currentBatch = [];
      currentDurationMs = 0;
    }
    currentBatch.push(file);
    currentDurationMs += durationMs;
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};
const unitFastExcludedFileSet = new Set(unitFastExcludedFiles);
const unitFastCandidateFiles = allKnownUnitFiles.filter(
  (file) => !unitFastExcludedFileSet.has(file),
);
const extensionForkIsolatedFileSet = new Set(extensionForkIsolatedFiles);
const extensionSharedCandidateFiles = allKnownTestFiles.filter(
  (file) => file.startsWith("extensions/") && !extensionForkIsolatedFileSet.has(file),
);
const extensionIsolatedEntries = extensionForkIsolatedFiles.map((file) => ({
  name: `extensions-${path.basename(file, ".test.ts")}-isolated`,
  args: ["vitest", "run", "--config", "vitest.extensions.config.ts", "--pool=forks", file],
}));
const defaultUnitFastLaneCount = isCI && !isWindows ? 3 : 1;
const unitFastLaneCount = Math.max(
  1,
  parseEnvNumber("OPENCLAW_TEST_UNIT_FAST_LANES", defaultUnitFastLaneCount),
);
const defaultUnitFastBatchTargetMs = isCI && !isWindows ? 45_000 : 0;
const unitFastBatchTargetMs = parseEnvNumber(
  "OPENCLAW_TEST_UNIT_FAST_BATCH_TARGET_MS",
  defaultUnitFastBatchTargetMs,
);
// Heap snapshots on current main show long-lived unit-fast workers retaining
// transformed Vitest/Vite module graphs rather than app objects. Multiple
// bounded unit-fast lanes only help if we also recycle them serially instead
// of keeping several transform-heavy workers resident at the same time.
const unitFastBuckets =
  unitFastLaneCount > 1
    ? packFilesByDuration(unitFastCandidateFiles, unitFastLaneCount, estimateUnitDurationMs)
    : [unitFastCandidateFiles];
const unitFastEntries = unitFastBuckets.flatMap((files, index) => {
  const laneName = unitFastBuckets.length === 1 ? "unit-fast" : `unit-fast-${String(index + 1)}`;
  const recycledBatches = splitFilesByDurationBudget(
    files,
    unitFastBatchTargetMs,
    estimateUnitDurationMs,
  );
  return recycledBatches
    .filter((batch) => batch.length > 0)
    .map((batch, batchIndex) => ({
      name: recycledBatches.length === 1 ? laneName : `${laneName}-batch-${String(batchIndex + 1)}`,
      serialPhase: "unit-fast",
      env: {
        OPENCLAW_VITEST_INCLUDE_FILE: writeTempJsonArtifact(
          `vitest-unit-fast-include-${String(index + 1)}-${String(batchIndex + 1)}`,
          batch,
        ),
      },
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.unit.config.ts",
        `--pool=${defaultUnitPool}`,
        ...(disableIsolation ? ["--isolate=false"] : []),
      ],
    }));
});
const heavyUnitBuckets = packFilesByDuration(
  timedHeavyUnitFiles,
  heavyUnitLaneCount,
  estimateUnitDurationMs,
);
const unitHeavyEntries = heavyUnitBuckets.map((files, index) => ({
  name: `unit-heavy-${String(index + 1)}`,
  args: ["vitest", "run", "--config", "vitest.unit.config.ts", "--pool=forks", ...files],
}));
const unitThreadEntries =
  unitThreadPinnedFiles.length > 0
    ? [
        {
          name: "unit-threads",
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=threads",
            ...unitThreadPinnedFiles,
          ],
        },
      ]
    : [];
const unitIsolatedEntries = unitForkIsolatedFiles.map((file) => ({
  name: `unit-${path.basename(file, ".test.ts")}-isolated`,
  args: ["vitest", "run", "--config", "vitest.unit.config.ts", "--pool=forks", file],
}));
const baseRuns = [
  ...(skipDefaultRuns
    ? []
    : shouldSplitUnitRuns
      ? [
          ...unitFastEntries,
          ...unitIsolatedEntries,
          ...unitHeavyEntries,
          ...unitMemoryIsolatedFiles.map((file) => ({
            name: `unit-${path.basename(file, ".test.ts")}-memory-isolated`,
            args: ["vitest", "run", "--config", "vitest.unit.config.ts", "--pool=forks", file],
          })),
          ...unitThreadEntries,
          ...channelSingletonFiles.map((file) => ({
            name: `${path.basename(file, ".test.ts")}-channels-isolated`,
            args: ["vitest", "run", "--config", "vitest.channels.config.ts", "--pool=forks", file],
          })),
        ]
      : [
          {
            name: "unit",
            args: [
              "vitest",
              "run",
              "--config",
              "vitest.unit.config.ts",
              "--pool=forks",
              ...(disableIsolation ? ["--isolate=false"] : []),
            ],
          },
        ]),
  ...(includeExtensionsSuite
    ? [
        ...extensionIsolatedEntries,
        {
          name: "extensions",
          env:
            extensionSharedCandidateFiles.length > 0
              ? {
                  OPENCLAW_VITEST_INCLUDE_FILE: writeTempJsonArtifact(
                    "vitest-extensions-include",
                    extensionSharedCandidateFiles,
                  ),
                }
              : undefined,
          args: ["vitest", "run", "--config", "vitest.extensions.config.ts"],
        },
      ]
    : []),
  ...(includeGatewaySuite
    ? [
        {
          name: "gateway",
          args: ["vitest", "run", "--config", "vitest.gateway.config.ts", "--pool=forks"],
        },
      ]
    : []),
];
runs = baseRuns;
const formatEntrySummary = (entry) => {
  const explicitFilters = countExplicitEntryFilters(entry.args) ?? 0;
  return `${entry.name} filters=${String(explicitFilters || "all")} maxWorkers=${String(
    maxWorkersForRun(entry.name) ?? "default",
  )}`;
};
const resolveFilterMatches = (fileFilter) => {
  const normalizedFilter = normalizeRepoPath(fileFilter);
  if (fs.existsSync(fileFilter)) {
    const stats = fs.statSync(fileFilter);
    if (stats.isFile()) {
      return [normalizedFilter];
    }
    if (stats.isDirectory()) {
      const prefix = normalizedFilter.endsWith("/") ? normalizedFilter : `${normalizedFilter}/`;
      return allKnownTestFiles.filter((file) => file.startsWith(prefix));
    }
  }
  if (/[*?[\]{}]/.test(normalizedFilter)) {
    return allKnownTestFiles.filter((file) => path.matchesGlob(file, normalizedFilter));
  }
  return allKnownTestFiles.filter((file) => file.includes(normalizedFilter));
};
const isThreadPinnedUnitFile = (fileFilter) => unitThreadPinnedFiles.includes(fileFilter);
const isBaseThreadPinnedFile = (fileFilter) => baseThreadPinnedFiles.includes(fileFilter);
const createTargetedEntry = (owner, isolated, filters) => {
  const name = isolated ? `${owner}-isolated` : owner;
  const forceForks = isolated;
  if (owner === "unit") {
    return {
      name,
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.unit.config.ts",
        `--pool=${forceForks ? "forks" : defaultUnitPool}`,
        ...(disableIsolation ? ["--isolate=false"] : []),
        ...filters,
      ],
    };
  }
  if (owner === "unit-threads") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.unit.config.ts", "--pool=threads", ...filters],
    };
  }
  if (owner === "base-threads") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.config.ts", "--pool=threads", ...filters],
    };
  }
  if (owner === "extensions") {
    return {
      name,
      args: [
        "vitest",
        "run",
        "--config",
        "vitest.extensions.config.ts",
        ...(forceForks ? ["--pool=forks"] : []),
        ...filters,
      ],
    };
  }
  if (owner === "gateway") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.gateway.config.ts", "--pool=forks", ...filters],
    };
  }
  if (owner === "channels") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.channels.config.ts", ...filters],
    };
  }
  if (owner === "live") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.live.config.ts", ...filters],
    };
  }
  if (owner === "e2e") {
    return {
      name,
      args: ["vitest", "run", "--config", "vitest.e2e.config.ts", ...filters],
    };
  }
  return {
    name,
    args: [
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      ...(forceForks ? ["--pool=forks"] : []),
      ...filters,
    ],
  };
};
const formatPerFileEntryName = (owner, file) => {
  const baseName = path
    .basename(file)
    .replace(/\.live\.test\.ts$/u, "")
    .replace(/\.e2e\.test\.ts$/u, "")
    .replace(/\.test\.ts$/u, "");
  return `${owner}-${baseName}`;
};
const createPerFileTargetedEntry = (file) => {
  const target = inferTarget(file);
  const owner = isThreadPinnedUnitFile(file)
    ? "unit-threads"
    : isBaseThreadPinnedFile(file)
      ? "base-threads"
      : target.owner;
  return {
    ...createTargetedEntry(owner, target.isolated, [file]),
    name: `${formatPerFileEntryName(owner, file)}${target.isolated ? "-isolated" : ""}`,
  };
};
const targetedEntries = (() => {
  if (passthroughFileFilters.length === 0) {
    return [];
  }
  const groups = passthroughFileFilters.reduce((acc, fileFilter) => {
    const matchedFiles = resolveFilterMatches(fileFilter);
    if (matchedFiles.length === 0) {
      const normalizedFile = normalizeRepoPath(fileFilter);
      const target = inferTarget(normalizedFile);
      const owner = isThreadPinnedUnitFile(normalizedFile)
        ? "unit-threads"
        : isBaseThreadPinnedFile(normalizedFile)
          ? "base-threads"
          : target.owner;
      const key = `${owner}:${target.isolated ? "isolated" : "default"}`;
      const files = acc.get(key) ?? [];
      files.push(normalizedFile);
      acc.set(key, files);
      return acc;
    }
    for (const matchedFile of matchedFiles) {
      const target = inferTarget(matchedFile);
      const owner = isThreadPinnedUnitFile(matchedFile)
        ? "unit-threads"
        : isBaseThreadPinnedFile(matchedFile)
          ? "base-threads"
          : target.owner;
      const key = `${owner}:${target.isolated ? "isolated" : "default"}`;
      const files = acc.get(key) ?? [];
      files.push(matchedFile);
      acc.set(key, files);
    }
    return acc;
  }, new Map());
  return Array.from(groups, ([key, filters]) => {
    const [owner, mode] = key.split(":");
    const uniqueFilters = [...new Set(filters)];
    if (mode === "isolated") {
      return uniqueFilters.map((file) => createPerFileTargetedEntry(file));
    }
    return [createTargetedEntry(owner, false, uniqueFilters)];
  }).flat();
})();
// Node 25 local runs still show cross-process worker shutdown contention even
// after moving the known heavy files into singleton lanes.
const topLevelParallelEnabled =
  testProfile !== "low" &&
  testProfile !== "serial" &&
  !(!isCI && nodeMajor >= 25) &&
  !isMacMiniProfile;
const defaultTopLevelParallelLimit = disableIsolation
  ? isCI
    ? isWindows
      ? 2
      : 4
    : highMemLocalHost
      ? Math.min(16, hostCpuCount)
      : lowMemLocalHost
        ? Math.min(8, hostCpuCount)
        : Math.min(12, hostCpuCount)
  : testProfile === "serial"
    ? 1
    : testProfile === "low"
      ? lowMemLocalHost
        ? 2
        : 3
      : testProfile === "max"
        ? 5
        : highMemLocalHost
          ? 4
          : lowMemLocalHost
            ? 2
            : 3;
const topLevelParallelLimit = Math.max(
  1,
  parseEnvNumber("OPENCLAW_TEST_TOP_LEVEL_CONCURRENCY", defaultTopLevelParallelLimit),
);
const overrideWorkers = Number.parseInt(process.env.OPENCLAW_TEST_WORKERS ?? "", 10);
const resolvedOverride =
  Number.isFinite(overrideWorkers) && overrideWorkers > 0 ? overrideWorkers : null;
const parallelGatewayEnabled =
  !isMacMiniProfile &&
  (process.env.OPENCLAW_TEST_PARALLEL_GATEWAY === "1" || (!isCI && highMemLocalHost));
// Keep gateway serial by default except when explicitly requested or on high-memory local hosts.
const keepGatewaySerial =
  isWindowsCi ||
  process.env.OPENCLAW_TEST_SERIAL_GATEWAY === "1" ||
  testProfile === "serial" ||
  !parallelGatewayEnabled;
const parallelRuns = keepGatewaySerial ? runs.filter((entry) => entry.name !== "gateway") : runs;
const serialRuns = keepGatewaySerial ? runs.filter((entry) => entry.name === "gateway") : [];
const serialPrefixRuns = parallelRuns.filter((entry) => entry.serialPhase);
const deferredParallelRuns = parallelRuns.filter((entry) => !entry.serialPhase);
const baseLocalWorkers = Math.max(4, Math.min(16, hostCpuCount));
const loadAwareDisabledRaw = process.env.OPENCLAW_TEST_LOAD_AWARE?.trim().toLowerCase();
const loadAwareDisabled = loadAwareDisabledRaw === "0" || loadAwareDisabledRaw === "false";
const loadRatio =
  !isCI && !loadAwareDisabled && process.platform !== "win32" && hostCpuCount > 0
    ? os.loadavg()[0] / hostCpuCount
    : 0;
// Keep the fast-path unchanged on normal load; only throttle under extreme host pressure.
const extremeLoadScale = loadRatio >= 1.1 ? 0.75 : loadRatio >= 1 ? 0.85 : 1;
const localWorkers = Math.max(4, Math.min(16, Math.floor(baseLocalWorkers * extremeLoadScale)));
const defaultWorkerBudget =
  testProfile === "low"
    ? {
        unit: 2,
        unitIsolated: 1,
        extensions: 4,
        gateway: 1,
      }
    : isMacMiniProfile
      ? {
          unit: 3,
          unitIsolated: 1,
          extensions: 1,
          gateway: 1,
        }
      : testProfile === "serial"
        ? {
            unit: 1,
            unitIsolated: 1,
            extensions: 1,
            gateway: 1,
          }
        : testProfile === "max"
          ? {
              unit: localWorkers,
              unitIsolated: Math.min(4, localWorkers),
              extensions: Math.max(1, Math.min(6, Math.floor(localWorkers / 2))),
              gateway: Math.max(1, Math.min(2, Math.floor(localWorkers / 4))),
            }
          : highMemLocalHost
            ? {
                // After peeling measured hotspots into dedicated lanes, the shared
                // unit-fast lane shuts down more reliably with a slightly smaller
                // worker fan-out than the old "max it out" local default.
                unit: Math.max(4, Math.min(10, Math.floor((localWorkers * 5) / 8))),
                unitIsolated: Math.max(1, Math.min(2, Math.floor(localWorkers / 6) || 1)),
                extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
                gateway: Math.max(2, Math.min(6, Math.floor(localWorkers / 2))),
              }
            : lowMemLocalHost
              ? {
                  // Sub-64 GiB local hosts are prone to OOM with large vmFork runs.
                  unit: 2,
                  unitIsolated: 1,
                  extensions: 4,
                  gateway: 1,
                }
              : {
                  // 64-95 GiB local hosts: conservative split with some parallel headroom.
                  unit: Math.max(2, Math.min(8, Math.floor(localWorkers / 2))),
                  unitIsolated: 1,
                  extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
                  gateway: 1,
                };

// Keep worker counts predictable for local runs; trim macOS CI workers to avoid worker crashes/OOM.
// In CI on linux/windows, prefer Vitest defaults to avoid cross-test interference from lower worker counts.
const maxWorkersForRun = (name) => {
  if (resolvedOverride) {
    return resolvedOverride;
  }
  if (isCI && !isMacOS) {
    return null;
  }
  if (isCI && isMacOS) {
    return 1;
  }
  if (name.endsWith("-threads")) {
    return 1;
  }
  if (name.endsWith("-isolated")) {
    return 1;
  }
  if (name.startsWith("unit-heavy-")) {
    return defaultWorkerBudget.unitIsolated;
  }
  if (name === "extensions") {
    return defaultWorkerBudget.extensions;
  }
  if (name === "gateway") {
    return defaultWorkerBudget.gateway;
  }
  return defaultWorkerBudget.unit;
};

const WARNING_SUPPRESSION_FLAGS = [
  "--disable-warning=ExperimentalWarning",
  "--disable-warning=DEP0040",
  "--disable-warning=DEP0060",
  "--disable-warning=MaxListenersExceededWarning",
];

const DEFAULT_CI_MAX_OLD_SPACE_SIZE_MB = 4096;
const maxOldSpaceSizeMb = (() => {
  // CI can hit Node heap limits (especially on large suites). Allow override, default to 4GB.
  const raw = process.env.OPENCLAW_TEST_MAX_OLD_SPACE_SIZE_MB ?? "";
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }
  if (isCI && !isWindows) {
    return DEFAULT_CI_MAX_OLD_SPACE_SIZE_MB;
  }
  return null;
})();
const formatElapsedMs = (elapsedMs) =>
  elapsedMs >= 1000 ? `${(elapsedMs / 1000).toFixed(1)}s` : `${Math.round(elapsedMs)}ms`;
const formatMemoryKb = (rssKb) =>
  rssKb >= 1024 ** 2
    ? `${(rssKb / 1024 ** 2).toFixed(2)}GiB`
    : rssKb >= 1024
      ? `${(rssKb / 1024).toFixed(1)}MiB`
      : `${rssKb}KiB`;
const formatMemoryDeltaKb = (rssKb) =>
  `${rssKb >= 0 ? "+" : "-"}${formatMemoryKb(Math.abs(rssKb))}`;
const rawMemoryTrace = process.env.OPENCLAW_TEST_MEMORY_TRACE?.trim().toLowerCase();
const memoryTraceEnabled =
  process.platform !== "win32" &&
  (rawMemoryTrace === "1" ||
    rawMemoryTrace === "true" ||
    (rawMemoryTrace !== "0" && rawMemoryTrace !== "false" && isCI));
const memoryTracePollMs = Math.max(250, parseEnvNumber("OPENCLAW_TEST_MEMORY_TRACE_POLL_MS", 1000));
const memoryTraceTopCount = Math.max(1, parseEnvNumber("OPENCLAW_TEST_MEMORY_TRACE_TOP_COUNT", 6));
const heapSnapshotIntervalMs = Math.max(
  0,
  parseEnvNumber("OPENCLAW_TEST_HEAPSNAPSHOT_INTERVAL_MS", 0),
);
const heapSnapshotMinIntervalMs = 5000;
const heapSnapshotEnabled =
  process.platform !== "win32" && heapSnapshotIntervalMs >= heapSnapshotMinIntervalMs;
const heapSnapshotSignal = process.env.OPENCLAW_TEST_HEAPSNAPSHOT_SIGNAL?.trim() || "SIGUSR2";
const heapSnapshotBaseDir = heapSnapshotEnabled
  ? path.resolve(
      process.env.OPENCLAW_TEST_HEAPSNAPSHOT_DIR?.trim() ||
        path.join(os.tmpdir(), `openclaw-heapsnapshots-${Date.now()}`),
    )
  : null;
const ensureNodeOptionFlag = (nodeOptions, flagPrefix, nextValue) =>
  nodeOptions.includes(flagPrefix) ? nodeOptions : `${nodeOptions} ${nextValue}`.trim();
const isNodeLikeProcess = (command) => /(?:^|\/)node(?:$|\.exe$)/iu.test(command);

const runOnce = (entry, extraArgs = []) =>
  new Promise((resolve) => {
    const startedAt = Date.now();
    const maxWorkers = maxWorkersForRun(entry.name);
    const entryArgs = entry.args;
    const explicitEntryFilters = getExplicitEntryFilters(entryArgs);
    const args = maxWorkers
      ? [
          ...entryArgs,
          "--maxWorkers",
          String(maxWorkers),
          ...silentArgs,
          ...windowsCiArgs,
          ...extraArgs,
        ]
      : [...entryArgs, ...silentArgs, ...windowsCiArgs, ...extraArgs];
    console.log(
      `[test-parallel] start ${entry.name} workers=${maxWorkers ?? "default"} filters=${String(
        countExplicitEntryFilters(entryArgs) ?? "all",
      )}`,
    );
    const nodeOptions = process.env.NODE_OPTIONS ?? "";
    const nextNodeOptions = WARNING_SUPPRESSION_FLAGS.reduce(
      (acc, flag) => (acc.includes(flag) ? acc : `${acc} ${flag}`.trim()),
      nodeOptions,
    );
    const heapSnapshotDir =
      heapSnapshotBaseDir === null ? null : path.join(heapSnapshotBaseDir, entry.name);
    let resolvedNodeOptions =
      maxOldSpaceSizeMb && !nextNodeOptions.includes("--max-old-space-size=")
        ? `${nextNodeOptions} --max-old-space-size=${maxOldSpaceSizeMb}`.trim()
        : nextNodeOptions;
    if (heapSnapshotEnabled && heapSnapshotDir) {
      try {
        fs.mkdirSync(heapSnapshotDir, { recursive: true });
      } catch (err) {
        console.error(
          `[test-parallel] failed to create heap snapshot dir ${heapSnapshotDir}: ${String(err)}`,
        );
        resolve(1);
        return;
      }
      resolvedNodeOptions = ensureNodeOptionFlag(
        resolvedNodeOptions,
        "--diagnostic-dir=",
        `--diagnostic-dir=${heapSnapshotDir}`,
      );
      resolvedNodeOptions = ensureNodeOptionFlag(
        resolvedNodeOptions,
        "--heapsnapshot-signal=",
        `--heapsnapshot-signal=${heapSnapshotSignal}`,
      );
    }
    let output = "";
    let fatalSeen = false;
    let childError = null;
    let child;
    let pendingLine = "";
    let memoryPollTimer = null;
    let heapSnapshotTimer = null;
    const memoryFileRecords = [];
    let initialTreeSample = null;
    let latestTreeSample = null;
    let peakTreeSample = null;
    let heapSnapshotSequence = 0;
    const updatePeakTreeSample = (sample, reason) => {
      if (!sample) {
        return;
      }
      if (!peakTreeSample || sample.rssKb > peakTreeSample.rssKb) {
        peakTreeSample = { ...sample, reason };
      }
    };
    const triggerHeapSnapshot = (reason) => {
      if (!heapSnapshotEnabled || !child?.pid || !heapSnapshotDir) {
        return;
      }
      const records = getProcessTreeRecords(child.pid) ?? [];
      const targetPids = records
        .filter((record) => record.pid !== process.pid && isNodeLikeProcess(record.command))
        .map((record) => record.pid);
      if (targetPids.length === 0) {
        return;
      }
      heapSnapshotSequence += 1;
      let signaledCount = 0;
      for (const pid of targetPids) {
        try {
          process.kill(pid, heapSnapshotSignal);
          signaledCount += 1;
        } catch {
          // Process likely exited between ps sampling and signal delivery.
        }
      }
      if (signaledCount > 0) {
        console.log(
          `[test-parallel][heap] ${entry.name} seq=${String(heapSnapshotSequence)} reason=${reason} signaled=${String(
            signaledCount,
          )}/${String(targetPids.length)} dir=${heapSnapshotDir}`,
        );
      }
    };
    const captureTreeSample = (reason) => {
      if (!memoryTraceEnabled || !child?.pid) {
        return null;
      }
      const sample = sampleProcessTreeRssKb(child.pid);
      if (!sample) {
        return null;
      }
      latestTreeSample = sample;
      if (!initialTreeSample) {
        initialTreeSample = sample;
      }
      updatePeakTreeSample(sample, reason);
      return sample;
    };
    const logMemoryTraceForText = (text) => {
      if (!memoryTraceEnabled) {
        return;
      }
      const combined = `${pendingLine}${text}`;
      const lines = combined.split(/\r?\n/u);
      pendingLine = lines.pop() ?? "";
      const completedFiles = parseCompletedTestFileLines(lines.join("\n"));
      for (const completedFile of completedFiles) {
        const sample = captureTreeSample(completedFile.file);
        if (!sample) {
          continue;
        }
        const previousRssKb =
          memoryFileRecords.length > 0
            ? (memoryFileRecords.at(-1)?.rssKb ?? initialTreeSample?.rssKb ?? sample.rssKb)
            : (initialTreeSample?.rssKb ?? sample.rssKb);
        const deltaKb = sample.rssKb - previousRssKb;
        const record = {
          ...completedFile,
          rssKb: sample.rssKb,
          processCount: sample.processCount,
          deltaKb,
        };
        memoryFileRecords.push(record);
        console.log(
          `[test-parallel][mem] ${entry.name} file=${record.file} rss=${formatMemoryKb(
            record.rssKb,
          )} delta=${formatMemoryDeltaKb(record.deltaKb)} peak=${formatMemoryKb(
            peakTreeSample?.rssKb ?? record.rssKb,
          )} procs=${record.processCount}${record.durationMs ? ` duration=${formatElapsedMs(record.durationMs)}` : ""}`,
        );
      }
    };
    const logMemoryTraceSummary = () => {
      if (!memoryTraceEnabled) {
        return;
      }
      captureTreeSample("close");
      const fallbackRecord =
        memoryFileRecords.length === 0 &&
        explicitEntryFilters.length === 1 &&
        latestTreeSample &&
        initialTreeSample
          ? [
              {
                file: explicitEntryFilters[0],
                deltaKb: latestTreeSample.rssKb - initialTreeSample.rssKb,
              },
            ]
          : [];
      const totalDeltaKb =
        initialTreeSample && latestTreeSample
          ? latestTreeSample.rssKb - initialTreeSample.rssKb
          : 0;
      const topGrowthFiles = [...memoryFileRecords, ...fallbackRecord]
        .filter((record) => record.deltaKb > 0 && typeof record.file === "string")
        .toSorted((left, right) => right.deltaKb - left.deltaKb)
        .slice(0, memoryTraceTopCount)
        .map((record) => `${record.file}:${formatMemoryDeltaKb(record.deltaKb)}`);
      console.log(
        `[test-parallel][mem] summary ${entry.name} files=${memoryFileRecords.length} peak=${formatMemoryKb(
          peakTreeSample?.rssKb ?? 0,
        )} totalDelta=${formatMemoryDeltaKb(totalDeltaKb)} peakAt=${
          peakTreeSample?.reason ?? "n/a"
        } top=${topGrowthFiles.length > 0 ? topGrowthFiles.join(", ") : "none"}`,
      );
    };
    try {
      child = spawn(pnpm, args, {
        stdio: ["inherit", "pipe", "pipe"],
        env: {
          ...process.env,
          ...entry.env,
          VITEST_GROUP: entry.name,
          NODE_OPTIONS: resolvedNodeOptions,
        },
        shell: isWindows,
      });
      captureTreeSample("spawn");
      if (memoryTraceEnabled) {
        memoryPollTimer = setInterval(() => {
          captureTreeSample("poll");
        }, memoryTracePollMs);
      }
      if (heapSnapshotEnabled) {
        heapSnapshotTimer = setInterval(() => {
          triggerHeapSnapshot("interval");
        }, heapSnapshotIntervalMs);
      }
    } catch (err) {
      console.error(`[test-parallel] spawn failed: ${String(err)}`);
      resolve(1);
      return;
    }
    children.add(child);
    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      fatalSeen ||= hasFatalTestRunOutput(`${output}${text}`);
      output = appendCapturedOutput(output, text);
      logMemoryTraceForText(text);
      process.stdout.write(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      fatalSeen ||= hasFatalTestRunOutput(`${output}${text}`);
      output = appendCapturedOutput(output, text);
      logMemoryTraceForText(text);
      process.stderr.write(chunk);
    });
    child.on("error", (err) => {
      childError = err;
      console.error(`[test-parallel] child error: ${String(err)}`);
    });
    child.on("close", (code, signal) => {
      if (memoryPollTimer) {
        clearInterval(memoryPollTimer);
      }
      if (heapSnapshotTimer) {
        clearInterval(heapSnapshotTimer);
      }
      children.delete(child);
      const resolvedCode = resolveTestRunExitCode({ code, signal, output, fatalSeen, childError });
      logMemoryTraceSummary();
      console.log(
        `[test-parallel] done ${entry.name} code=${String(resolvedCode)} elapsed=${formatElapsedMs(Date.now() - startedAt)}`,
      );
      resolve(resolvedCode);
    });
  });

const run = async (entry, extraArgs = []) => {
  const explicitFilterCount = countExplicitEntryFilters(entry.args);
  // Vitest requires the shard count to stay strictly below the number of
  // resolved test files, so explicit-filter lanes need a `< fileCount` cap.
  const effectiveShardCount =
    explicitFilterCount === null
      ? shardCount
      : Math.min(shardCount, Math.max(1, explicitFilterCount - 1));

  if (effectiveShardCount <= 1) {
    if (shardIndexOverride !== null && shardIndexOverride > effectiveShardCount) {
      return 0;
    }
    return runOnce(entry, extraArgs);
  }
  if (shardIndexOverride !== null) {
    if (shardIndexOverride > effectiveShardCount) {
      return 0;
    }
    return runOnce(entry, [
      "--shard",
      `${shardIndexOverride}/${effectiveShardCount}`,
      ...extraArgs,
    ]);
  }
  for (let shardIndex = 1; shardIndex <= effectiveShardCount; shardIndex += 1) {
    // eslint-disable-next-line no-await-in-loop
    const code = await runOnce(entry, [
      "--shard",
      `${shardIndex}/${effectiveShardCount}`,
      ...extraArgs,
    ]);
    if (code !== 0) {
      return code;
    }
  }
  return 0;
};

const runEntriesWithLimit = async (entries, extraArgs = [], concurrency = 1) => {
  if (entries.length === 0) {
    return undefined;
  }

  const normalizedConcurrency = Math.max(1, Math.floor(concurrency));
  if (normalizedConcurrency <= 1) {
    for (const entry of entries) {
      // eslint-disable-next-line no-await-in-loop
      const code = await run(entry, extraArgs);
      if (code !== 0) {
        return code;
      }
    }

    return undefined;
  }

  let nextIndex = 0;
  let firstFailure;
  const worker = async () => {
    while (firstFailure === undefined) {
      const entryIndex = nextIndex;
      nextIndex += 1;
      if (entryIndex >= entries.length) {
        return;
      }
      const code = await run(entries[entryIndex], extraArgs);
      if (code !== 0 && firstFailure === undefined) {
        firstFailure = code;
      }
    }
  };

  const workerCount = Math.min(normalizedConcurrency, entries.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return firstFailure;
};

const runEntries = async (entries, extraArgs = []) => {
  if (topLevelParallelEnabled) {
    // Keep a bounded number of top-level Vitest processes in flight. As the
    // singleton lane list grows, unbounded Promise.all scheduling turns
    // isolation into cross-process contention and can reintroduce timeouts.
    return runEntriesWithLimit(entries, extraArgs, topLevelParallelLimit);
  }

  return runEntriesWithLimit(entries, extraArgs);
};

const shutdown = (signal) => {
  for (const child of children) {
    child.kill(signal);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("exit", cleanupTempArtifacts);

if (process.env.OPENCLAW_TEST_LIST_LANES === "1") {
  const entriesToPrint = targetedEntries.length > 0 ? targetedEntries : runs;
  for (const entry of entriesToPrint) {
    console.log(formatEntrySummary(entry));
  }
  process.exit(0);
}

if (passthroughMetadataOnly) {
  const exitCode = await runOnce(
    {
      name: "vitest-meta",
      args: ["vitest", "run"],
    },
    passthroughOptionArgs,
  );
  process.exit(exitCode);
}

if (targetedEntries.length > 0) {
  if (passthroughRequiresSingleRun && targetedEntries.length > 1) {
    console.error(
      "[test-parallel] The provided Vitest args require a single run, but the selected test filters span multiple wrapper configs. Run one target/config at a time.",
    );
    process.exit(2);
  }
  const targetedParallelRuns = keepGatewaySerial
    ? targetedEntries.filter((entry) => entry.name !== "gateway")
    : targetedEntries;
  const targetedSerialRuns = keepGatewaySerial
    ? targetedEntries.filter((entry) => entry.name === "gateway")
    : [];
  const failedTargetedParallel = await runEntries(targetedParallelRuns, passthroughOptionArgs);
  if (failedTargetedParallel !== undefined) {
    process.exit(failedTargetedParallel);
  }
  for (const entry of targetedSerialRuns) {
    // eslint-disable-next-line no-await-in-loop
    const code = await run(entry, passthroughOptionArgs);
    if (code !== 0) {
      process.exit(code);
    }
  }
  process.exit(0);
}

if (passthroughRequiresSingleRun && passthroughOptionArgs.length > 0) {
  console.error(
    "[test-parallel] The provided Vitest args require a single run. Use the dedicated npm script for that workflow (for example `pnpm test:coverage`) or target a single test file/filter.",
  );
  process.exit(2);
}

if (serialPrefixRuns.length > 0) {
  const failedSerialPrefix = await runEntriesWithLimit(serialPrefixRuns, passthroughOptionArgs, 1);
  if (failedSerialPrefix !== undefined) {
    process.exit(failedSerialPrefix);
  }
  const deferredRunConcurrency = isMacMiniProfile ? 3 : testProfile === "low" ? 2 : undefined;
  const failedDeferredParallel = isMacMiniProfile
    ? await runEntriesWithLimit(deferredParallelRuns, passthroughOptionArgs, deferredRunConcurrency)
    : deferredRunConcurrency
      ? await runEntriesWithLimit(
          deferredParallelRuns,
          passthroughOptionArgs,
          deferredRunConcurrency,
        )
      : await runEntries(deferredParallelRuns, passthroughOptionArgs);
  if (failedDeferredParallel !== undefined) {
    process.exit(failedDeferredParallel);
  }
} else if (isMacMiniProfile && targetedEntries.length === 0) {
  const unitFastEntriesForMacMini = parallelRuns.filter((entry) =>
    entry.name.startsWith("unit-fast"),
  );
  for (const entry of unitFastEntriesForMacMini) {
    // eslint-disable-next-line no-await-in-loop
    const unitFastCode = await run(entry, passthroughOptionArgs);
    if (unitFastCode !== 0) {
      process.exit(unitFastCode);
    }
  }
  const deferredEntries = parallelRuns.filter((entry) => !entry.name.startsWith("unit-fast"));
  const failedMacMiniParallel = await runEntriesWithLimit(
    deferredEntries,
    passthroughOptionArgs,
    3,
  );
  if (failedMacMiniParallel !== undefined) {
    process.exit(failedMacMiniParallel);
  }
} else {
  const failedParallel = await runEntries(parallelRuns, passthroughOptionArgs);
  if (failedParallel !== undefined) {
    process.exit(failedParallel);
  }
}

for (const entry of serialRuns) {
  // eslint-disable-next-line no-await-in-loop
  const code = await run(entry, passthroughOptionArgs);
  if (code !== 0) {
    process.exit(code);
  }
}

process.exit(0);
