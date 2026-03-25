import path from "node:path";
import { isUnitConfigTestFile } from "../../vitest.unit-paths.mjs";
import {
  loadChannelTimingManifest,
  loadUnitMemoryHotspotManifest,
  loadUnitTimingManifest,
  packFilesByDuration,
  packFilesByDurationWithBaseLoads,
  selectUnitHeavyFileGroups,
} from "../test-runner-manifest.mjs";
import { loadTestCatalog, normalizeRepoPath } from "./catalog.mjs";
import { resolveRuntimeProfile } from "./runtime-profile.mjs";
import {
  countExplicitEntryFilters,
  parsePassthroughArgs,
  SINGLE_RUN_ONLY_FLAGS,
} from "./vitest-args.mjs";

const parseEnvNumber = (env, name, fallback) => {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const normalizeSurfaces = (values = []) => [
  ...new Set(
    values
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

const buildRequestedSurfaces = (request, env) => {
  const explicit = normalizeSurfaces(request.surfaces ?? []);
  if (explicit.length > 0) {
    return explicit;
  }
  const surfaces = [];
  const skipDefaultRuns = env.OPENCLAW_TEST_SKIP_DEFAULT === "1";
  if (!skipDefaultRuns) {
    surfaces.push("unit");
  }
  if (env.OPENCLAW_TEST_INCLUDE_EXTENSIONS === "1") {
    surfaces.push("extensions");
  }
  if (env.OPENCLAW_TEST_INCLUDE_CHANNELS === "1") {
    surfaces.push("channels");
  }
  if (env.OPENCLAW_TEST_INCLUDE_GATEWAY === "1") {
    surfaces.push("gateway");
  }
  return surfaces;
};

const createPlannerContext = (request, options = {}) => {
  const env = options.env ?? process.env;
  const runtime = resolveRuntimeProfile(env, {
    mode: request.mode ?? null,
    profile: request.profile ?? null,
  });
  const catalog = options.catalog ?? loadTestCatalog();
  const unitTimingManifest = loadUnitTimingManifest();
  const channelTimingManifest = loadChannelTimingManifest();
  const unitMemoryHotspotManifest = loadUnitMemoryHotspotManifest();
  return {
    env,
    runtime,
    catalog,
    unitTimingManifest,
    channelTimingManifest,
    unitMemoryHotspotManifest,
  };
};

const estimateEntryFilesDurationMs = (entry, files, context) => {
  const estimateDurationMs = resolveEntryTimingEstimator(entry, context);
  if (!estimateDurationMs) {
    return files.length * 1_000;
  }
  return files.reduce((totalMs, file) => totalMs + estimateDurationMs(file), 0);
};

const resolveEntryTimingEstimator = (entry, context) => {
  const configIndex = entry.args.findIndex((arg) => arg === "--config");
  const config = configIndex >= 0 ? (entry.args[configIndex + 1] ?? "") : "";
  if (config === "vitest.unit.config.ts") {
    return (file) =>
      context.unitTimingManifest.files[file]?.durationMs ??
      context.unitTimingManifest.defaultDurationMs;
  }
  if (config === "vitest.channels.config.ts" || config === "vitest.extensions.config.ts") {
    return (file) =>
      context.channelTimingManifest.files[file]?.durationMs ??
      context.channelTimingManifest.defaultDurationMs;
  }
  return null;
};

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

const resolveDefaultWorkerBudget = (runtime) => {
  const localWorkers = runtime.adjustedLocalWorkers;
  if (runtime.testProfile === "low") {
    return { unit: 2, unitIsolated: 1, extensions: 4, gateway: 1 };
  }
  if (runtime.isMacMiniProfile) {
    return { unit: 3, unitIsolated: 1, extensions: 1, gateway: 1 };
  }
  if (runtime.testProfile === "serial") {
    return { unit: 1, unitIsolated: 1, extensions: 1, gateway: 1 };
  }
  if (runtime.testProfile === "max") {
    return {
      unit: localWorkers,
      unitIsolated: Math.min(4, localWorkers),
      extensions: Math.max(1, Math.min(6, Math.floor(localWorkers / 2))),
      gateway: Math.max(1, Math.min(2, Math.floor(localWorkers / 4))),
    };
  }
  if (runtime.highMemLocalHost) {
    return {
      unit: Math.max(4, Math.min(10, Math.floor((localWorkers * 5) / 8))),
      unitIsolated: Math.max(1, Math.min(2, Math.floor(localWorkers / 6) || 1)),
      extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
      gateway: Math.max(2, Math.min(6, Math.floor(localWorkers / 2))),
    };
  }
  if (runtime.lowMemLocalHost) {
    return { unit: 2, unitIsolated: 1, extensions: 4, gateway: 1 };
  }
  return {
    unit: Math.max(2, Math.min(8, Math.floor(localWorkers / 2))),
    unitIsolated: 1,
    extensions: Math.max(1, Math.min(4, Math.floor(localWorkers / 4))),
    gateway: 1,
  };
};

const resolveMaxWorkersForUnit = (unit, context) => {
  const overrideWorkers = Number.parseInt(context.env.OPENCLAW_TEST_WORKERS ?? "", 10);
  const resolvedOverride =
    Number.isFinite(overrideWorkers) && overrideWorkers > 0 ? overrideWorkers : null;
  if (resolvedOverride) {
    return resolvedOverride;
  }
  if (context.runtime.isCI && !context.runtime.isMacOS) {
    return null;
  }
  if (context.runtime.isCI && context.runtime.isMacOS) {
    return 1;
  }
  const budget = context.defaultWorkerBudget;
  if (unit.isolate) {
    return 1;
  }
  if (unit.id.startsWith("unit-heavy-")) {
    return budget.unitIsolated;
  }
  if (unit.surface === "extensions") {
    return budget.extensions;
  }
  if (unit.surface === "gateway") {
    return budget.gateway;
  }
  return budget.unit;
};

const formatPerFileEntryName = (owner, file) => {
  const baseName = path
    .basename(file)
    .replace(/\.live\.test\.ts$/u, "")
    .replace(/\.e2e\.test\.ts$/u, "")
    .replace(/\.test\.ts$/u, "");
  return `${owner}-${baseName}`;
};

const createExecutionUnit = (context, config) => {
  const unit = {
    id: config.id,
    surface: config.surface,
    isolate: Boolean(config.isolate),
    pool: config.pool ?? "forks",
    args: config.args,
    env: config.env,
    includeFiles: config.includeFiles,
    serialPhase: config.serialPhase,
    fixedShardIndex: config.fixedShardIndex,
    estimatedDurationMs: config.estimatedDurationMs,
    timeoutMs: config.timeoutMs,
    reasons: config.reasons ?? [],
  };
  unit.maxWorkers = resolveMaxWorkersForUnit(unit, context);
  return unit;
};

const withIncludeFileEnv = (context, unitId, files) => ({
  OPENCLAW_VITEST_INCLUDE_FILE: context.writeTempJsonArtifact(unitId, files),
});

const buildDefaultUnits = (context, request) => {
  const {
    env,
    runtime,
    catalog,
    unitTimingManifest,
    channelTimingManifest,
    unitMemoryHotspotManifest,
  } = context;
  const noIsolateArgs = context.noIsolateArgs;
  const selectedSurfaces = buildRequestedSurfaces(request, env);
  const selectedSurfaceSet = new Set(selectedSurfaces);

  const defaultHeavyUnitFileLimit = runtime.isMacMiniProfile
    ? 90
    : runtime.testProfile === "low" || runtime.testProfile === "serial"
      ? 36
      : runtime.highMemLocalHost
        ? 80
        : 60;
  const defaultHeavyUnitLaneCount = runtime.isMacMiniProfile
    ? 6
    : runtime.testProfile === "low" || runtime.testProfile === "serial"
      ? 4
      : runtime.highMemLocalHost
        ? 5
        : 4;
  const heavyUnitFileLimit = parseEnvNumber(
    env,
    "OPENCLAW_TEST_HEAVY_UNIT_FILE_LIMIT",
    defaultHeavyUnitFileLimit,
  );
  const heavyUnitLaneCount = parseEnvNumber(
    env,
    "OPENCLAW_TEST_HEAVY_UNIT_LANES",
    defaultHeavyUnitLaneCount,
  );
  const heavyUnitMinDurationMs = parseEnvNumber(env, "OPENCLAW_TEST_HEAVY_UNIT_MIN_MS", 1200);
  const defaultMemoryHeavyUnitFileLimit = runtime.isCI
    ? 64
    : runtime.testProfile === "low" || runtime.testProfile === "serial"
      ? 8
      : 16;
  const memoryHeavyUnitFileLimit = parseEnvNumber(
    env,
    "OPENCLAW_TEST_MEMORY_HEAVY_UNIT_FILE_LIMIT",
    defaultMemoryHeavyUnitFileLimit,
  );
  const memoryHeavyUnitMinDeltaKb = parseEnvNumber(
    env,
    "OPENCLAW_TEST_MEMORY_HEAVY_UNIT_MIN_KB",
    unitMemoryHotspotManifest.defaultMinDeltaKb,
  );
  const { memoryHeavyFiles: memoryHeavyUnitFiles, timedHeavyFiles: timedHeavyUnitFiles } =
    selectUnitHeavyFileGroups({
      candidates: catalog.allKnownUnitFiles,
      behaviorOverrides: catalog.unitBehaviorOverrideSet,
      timedLimit: heavyUnitFileLimit,
      timedMinDurationMs: heavyUnitMinDurationMs,
      memoryLimit: memoryHeavyUnitFileLimit,
      memoryMinDeltaKb: memoryHeavyUnitMinDeltaKb,
      timings: unitTimingManifest,
      hotspots: unitMemoryHotspotManifest,
    });
  const unitMemoryIsolatedFiles = [...memoryHeavyUnitFiles].filter(
    (file) => !catalog.unitBehaviorOverrideSet.has(file),
  );
  const unitSchedulingOverrideSet = new Set([
    ...catalog.unitBehaviorOverrideSet,
    ...memoryHeavyUnitFiles,
  ]);
  const unitFastExcludedFiles = [
    ...new Set([
      ...unitSchedulingOverrideSet,
      ...timedHeavyUnitFiles,
      ...catalog.channelIsolatedFiles,
    ]),
  ];
  const estimateUnitDurationMs = (file) =>
    unitTimingManifest.files[file]?.durationMs ?? unitTimingManifest.defaultDurationMs;
  const estimateChannelDurationMs = (file) =>
    channelTimingManifest.files[file]?.durationMs ?? channelTimingManifest.defaultDurationMs;
  const unitFastCandidateFiles = catalog.allKnownUnitFiles.filter(
    (file) => !new Set(unitFastExcludedFiles).has(file),
  );
  const extensionSharedCandidateFiles = catalog.allKnownTestFiles.filter(
    (file) => file.startsWith("extensions/") && !catalog.extensionForkIsolatedFileSet.has(file),
  );
  const channelSharedCandidateFiles = catalog.allKnownTestFiles.filter(
    (file) =>
      catalog.channelTestPrefixes.some((prefix) => file.startsWith(prefix)) &&
      !catalog.channelIsolatedFileSet.has(file),
  );
  const defaultExtensionsBatchTargetMs = runtime.isCI && !runtime.isWindows ? 30_000 : 0;
  const extensionsBatchTargetMs = parseEnvNumber(
    env,
    "OPENCLAW_TEST_EXTENSIONS_BATCH_TARGET_MS",
    defaultExtensionsBatchTargetMs,
  );
  const defaultUnitFastLaneCount =
    runtime.testProfile === "low" ? 8 : runtime.isCI && !runtime.isWindows ? 3 : 1;
  const unitFastLaneCount = Math.max(
    1,
    parseEnvNumber(env, "OPENCLAW_TEST_UNIT_FAST_LANES", defaultUnitFastLaneCount),
  );
  const defaultUnitFastBatchTargetMs =
    runtime.testProfile === "low" || runtime.testProfile === "serial"
      ? 10_000
      : runtime.isCI && !runtime.isWindows
        ? 45_000
        : runtime.highMemLocalHost
          ? 45_000
          : 0;
  const unitFastBatchTargetMs = parseEnvNumber(
    env,
    "OPENCLAW_TEST_UNIT_FAST_BATCH_TARGET_MS",
    defaultUnitFastBatchTargetMs,
  );
  const defaultChannelsBatchTargetMs = runtime.isCI && !runtime.isWindows ? 30_000 : 0;
  const channelsBatchTargetMs = parseEnvNumber(
    env,
    "OPENCLAW_TEST_CHANNELS_BATCH_TARGET_MS",
    defaultChannelsBatchTargetMs,
  );
  const unitFastBuckets =
    unitFastLaneCount > 1
      ? packFilesByDuration(unitFastCandidateFiles, unitFastLaneCount, estimateUnitDurationMs)
      : [unitFastCandidateFiles];
  const units = [];

  if (selectedSurfaceSet.has("unit")) {
    for (const [laneIndex, files] of unitFastBuckets.entries()) {
      const laneName =
        unitFastBuckets.length === 1 ? "unit-fast" : `unit-fast-${String(laneIndex + 1)}`;
      const recycledBatches = splitFilesByDurationBudget(
        files,
        unitFastBatchTargetMs,
        estimateUnitDurationMs,
      );
      for (const [batchIndex, batch] of recycledBatches.entries()) {
        if (batch.length === 0) {
          continue;
        }
        const unitId =
          recycledBatches.length === 1 ? laneName : `${laneName}-batch-${String(batchIndex + 1)}`;
        units.push(
          createExecutionUnit(context, {
            id: unitId,
            surface: "unit",
            isolate: false,
            serialPhase: "unit-fast",
            includeFiles: batch,
            estimatedDurationMs: estimateEntryFilesDurationMs(
              { args: ["vitest", "run", "--config", "vitest.unit.config.ts"] },
              batch,
              context,
            ),
            env: withIncludeFileEnv(
              context,
              `vitest-unit-fast-include-${String(laneIndex + 1)}-${String(batchIndex + 1)}`,
              batch,
            ),
            args: [
              "vitest",
              "run",
              "--config",
              "vitest.unit.config.ts",
              "--pool=forks",
              ...noIsolateArgs,
            ],
            reasons: ["unit-fast-shared"],
          }),
        );
      }
    }

    for (const file of catalog.unitForkIsolatedFiles) {
      units.push(
        createExecutionUnit(context, {
          id: `unit-${path.basename(file, ".test.ts")}-isolated`,
          surface: "unit",
          isolate: true,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=forks",
            ...noIsolateArgs,
            file,
          ],
          reasons: ["unit-isolated-manifest"],
        }),
      );
    }

    const heavyUnitBuckets = packFilesByDuration(
      timedHeavyUnitFiles,
      heavyUnitLaneCount,
      estimateUnitDurationMs,
    );
    for (const [index, files] of heavyUnitBuckets.entries()) {
      units.push(
        createExecutionUnit(context, {
          id: `unit-heavy-${String(index + 1)}`,
          surface: "unit",
          isolate: false,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=forks",
            ...noIsolateArgs,
            ...files,
          ],
          reasons: ["unit-timed-heavy"],
        }),
      );
    }

    for (const file of unitMemoryIsolatedFiles) {
      units.push(
        createExecutionUnit(context, {
          id: `unit-${path.basename(file, ".test.ts")}-memory-isolated`,
          surface: "unit",
          isolate: true,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=forks",
            ...noIsolateArgs,
            file,
          ],
          reasons: ["unit-memory-isolated"],
        }),
      );
    }

    if (catalog.unitThreadPinnedFiles.length > 0) {
      units.push(
        createExecutionUnit(context, {
          id: "unit-pinned",
          surface: "unit",
          isolate: false,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.unit.config.ts",
            "--pool=forks",
            ...noIsolateArgs,
            ...catalog.unitThreadPinnedFiles,
          ],
          reasons: ["unit-pinned-manifest"],
        }),
      );
    }
  }

  if (selectedSurfaceSet.has("extensions")) {
    for (const file of catalog.extensionForkIsolatedFiles) {
      units.push(
        createExecutionUnit(context, {
          id: `extensions-${path.basename(file, ".test.ts")}-isolated`,
          surface: "extensions",
          isolate: true,
          args: ["vitest", "run", "--config", "vitest.extensions.config.ts", "--pool=forks", file],
          reasons: ["extensions-isolated-manifest"],
        }),
      );
    }
    const extensionBatches = splitFilesByDurationBudget(
      extensionSharedCandidateFiles,
      extensionsBatchTargetMs,
      estimateChannelDurationMs,
    );
    for (const [batchIndex, batch] of extensionBatches.entries()) {
      if (batch.length === 0) {
        continue;
      }
      const unitId =
        extensionBatches.length === 1 ? "extensions" : `extensions-batch-${String(batchIndex + 1)}`;
      units.push(
        createExecutionUnit(context, {
          id: unitId,
          surface: "extensions",
          isolate: false,
          serialPhase: "extensions",
          includeFiles: batch,
          estimatedDurationMs: estimateEntryFilesDurationMs(
            { args: ["vitest", "run", "--config", "vitest.extensions.config.ts"] },
            batch,
            context,
          ),
          env: withIncludeFileEnv(
            context,
            `vitest-extensions-include-${String(batchIndex + 1)}`,
            batch,
          ),
          args: ["vitest", "run", "--config", "vitest.extensions.config.ts", ...noIsolateArgs],
          reasons: ["extensions-shared"],
        }),
      );
    }
  }

  if (selectedSurfaceSet.has("channels")) {
    for (const file of catalog.channelIsolatedFiles) {
      units.push(
        createExecutionUnit(context, {
          id: `${path.basename(file, ".test.ts")}-channels-isolated`,
          surface: "channels",
          isolate: true,
          args: [
            "vitest",
            "run",
            "--config",
            "vitest.channels.config.ts",
            "--pool=forks",
            ...noIsolateArgs,
            file,
          ],
          reasons: ["channels-isolated-rule"],
        }),
      );
    }
    const channelBatches = splitFilesByDurationBudget(
      channelSharedCandidateFiles,
      channelsBatchTargetMs,
      estimateChannelDurationMs,
    );
    for (const [batchIndex, batch] of channelBatches.entries()) {
      if (batch.length === 0) {
        continue;
      }
      const unitId =
        channelBatches.length === 1 ? "channels" : `channels-batch-${String(batchIndex + 1)}`;
      units.push(
        createExecutionUnit(context, {
          id: unitId,
          surface: "channels",
          isolate: false,
          serialPhase: "channels",
          includeFiles: batch,
          estimatedDurationMs: estimateEntryFilesDurationMs(
            { args: ["vitest", "run", "--config", "vitest.channels.config.ts"] },
            batch,
            context,
          ),
          env: withIncludeFileEnv(
            context,
            `vitest-channels-include-${String(batchIndex + 1)}`,
            batch,
          ),
          args: ["vitest", "run", "--config", "vitest.channels.config.ts", ...noIsolateArgs],
          reasons: ["channels-shared"],
        }),
      );
    }
  }

  if (selectedSurfaceSet.has("gateway")) {
    units.push(
      createExecutionUnit(context, {
        id: "gateway",
        surface: "gateway",
        isolate: false,
        args: [
          "vitest",
          "run",
          "--config",
          "vitest.gateway.config.ts",
          "--pool=forks",
          ...noIsolateArgs,
        ],
        reasons: ["gateway-surface"],
      }),
    );
  }

  return { units, unitMemoryIsolatedFiles };
};

const createTargetedUnit = (context, classification, filters) => {
  const owner = classification.legacyBasePinned ? "base-pinned" : classification.surface;
  const unitId =
    filters.length === 1 && (classification.isolated || owner === "base-pinned")
      ? `${formatPerFileEntryName(owner, filters[0])}${classification.isolated ? "-isolated" : ""}`
      : classification.isolated
        ? `${owner}-isolated`
        : owner;
  const args = (() => {
    if (owner === "unit") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.unit.config.ts",
        "--pool=forks",
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    if (owner === "base-pinned") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.config.ts",
        "--pool=forks",
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    if (owner === "extensions") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.extensions.config.ts",
        ...(classification.isolated ? ["--pool=forks"] : []),
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    if (owner === "gateway") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.gateway.config.ts",
        "--pool=forks",
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    if (owner === "channels") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.channels.config.ts",
        ...(classification.isolated ? ["--pool=forks"] : []),
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    if (owner === "live") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.live.config.ts",
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    if (owner === "e2e") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.e2e.config.ts",
        ...context.noIsolateArgs,
        ...filters,
      ];
    }
    return [
      "vitest",
      "run",
      "--config",
      "vitest.config.ts",
      ...context.noIsolateArgs,
      ...(classification.isolated ? ["--pool=forks"] : []),
      ...filters,
    ];
  })();
  return createExecutionUnit(context, {
    id: unitId,
    surface: classification.legacyBasePinned ? "base" : classification.surface,
    isolate: classification.isolated || owner === "base-pinned",
    args,
    reasons: classification.reasons,
  });
};

const buildTargetedUnits = (context, request) => {
  if (request.fileFilters.length === 0) {
    return [];
  }
  const unitMemoryIsolatedFiles = request.unitMemoryIsolatedFiles ?? [];
  const groups = request.fileFilters.reduce((acc, fileFilter) => {
    const matchedFiles = context.catalog.resolveFilterMatches(fileFilter);
    if (matchedFiles.length === 0) {
      const classification = context.catalog.classifyTestFile(normalizeRepoPath(fileFilter), {
        unitMemoryIsolatedFiles,
      });
      const key = `${classification.legacyBasePinned ? "base-pinned" : classification.surface}:${
        classification.isolated ? "isolated" : "default"
      }`;
      const files = acc.get(key) ?? { classification, files: [] };
      files.files.push(normalizeRepoPath(fileFilter));
      acc.set(key, files);
      return acc;
    }
    for (const matchedFile of matchedFiles) {
      const classification = context.catalog.classifyTestFile(matchedFile, {
        unitMemoryIsolatedFiles,
      });
      const key = `${classification.legacyBasePinned ? "base-pinned" : classification.surface}:${
        classification.isolated ? "isolated" : "default"
      }`;
      const files = acc.get(key) ?? { classification, files: [] };
      files.files.push(matchedFile);
      acc.set(key, files);
    }
    return acc;
  }, new Map());
  return Array.from(groups.values()).flatMap(({ classification, files }) => {
    const uniqueFilters = [...new Set(files)];
    if (classification.isolated || classification.legacyBasePinned) {
      return uniqueFilters.map((file) =>
        createTargetedUnit(
          context,
          context.catalog.classifyTestFile(file, {
            unitMemoryIsolatedFiles,
          }),
          [file],
        ),
      );
    }
    return [createTargetedUnit(context, classification, uniqueFilters)];
  });
};

const rebuildEntryArgsWithFilters = (entryArgs, filters) => {
  const baseArgs = entryArgs.slice(0, 2);
  const { optionArgs } = parsePassthroughArgs(entryArgs.slice(2));
  return [...baseArgs, ...optionArgs, ...filters];
};

const createPinnedShardUnit = (context, unit, files, fixedShardIndex) => {
  const nextUnit = createExecutionUnit(context, {
    ...unit,
    id: `${unit.id}-shard-${String(fixedShardIndex)}`,
    fixedShardIndex,
    estimatedDurationMs: estimateEntryFilesDurationMs(unit, files, context),
    includeFiles:
      Array.isArray(unit.includeFiles) && unit.includeFiles.length > 0 ? files : undefined,
    env:
      Array.isArray(unit.includeFiles) && unit.includeFiles.length > 0
        ? {
            ...unit.env,
            OPENCLAW_VITEST_INCLUDE_FILE: context.writeTempJsonArtifact(
              `${unit.id}-shard-${String(fixedShardIndex)}-include`,
              files,
            ),
          }
        : unit.env,
    args:
      Array.isArray(unit.includeFiles) && unit.includeFiles.length > 0
        ? rebuildEntryArgsWithFilters(unit.args, [])
        : rebuildEntryArgsWithFilters(unit.args, files),
  });
  nextUnit.fixedShardIndex = fixedShardIndex;
  return nextUnit;
};

const expandUnitsAcrossTopLevelShards = (context, units) => {
  if (context.configuredShardCount === null || context.shardCount <= 1) {
    return units;
  }
  return units.flatMap((unit) => {
    const estimateDurationMs = resolveEntryTimingEstimator(unit, context);
    if (!estimateDurationMs || unit.fixedShardIndex !== undefined) {
      return [unit];
    }
    const candidateFiles =
      Array.isArray(unit.includeFiles) && unit.includeFiles.length > 0
        ? unit.includeFiles
        : getExplicitEntryFilters(unit.args);
    if (candidateFiles.length <= 1) {
      return [unit];
    }
    const effectiveShardCount = Math.min(
      context.shardCount,
      Math.max(1, candidateFiles.length - 1),
    );
    if (effectiveShardCount <= 1) {
      return [unit];
    }
    const buckets = packFilesByDurationWithBaseLoads(
      candidateFiles,
      effectiveShardCount,
      estimateDurationMs,
    );
    return buckets.flatMap((files, bucketIndex) =>
      files.length > 0 ? [createPinnedShardUnit(context, unit, files, bucketIndex + 1)] : [],
    );
  });
};

const estimateTopLevelEntryDurationMs = (unit, context) => {
  if (Number.isFinite(unit.estimatedDurationMs) && unit.estimatedDurationMs > 0) {
    return unit.estimatedDurationMs;
  }
  const filters = getExplicitEntryFilters(unit.args);
  if (filters.length === 0) {
    return context.unitTimingManifest.defaultDurationMs;
  }
  return filters.reduce((totalMs, file) => {
    if (isUnitConfigTestFile(file)) {
      return (
        totalMs +
        (context.unitTimingManifest.files[file]?.durationMs ??
          context.unitTimingManifest.defaultDurationMs)
      );
    }
    if (context.catalog.channelTestPrefixes.some((prefix) => file.startsWith(prefix))) {
      return totalMs + 3_000;
    }
    if (file.startsWith("extensions/")) {
      return totalMs + 2_000;
    }
    return totalMs + 1_000;
  }, 0);
};

const buildTopLevelSingleShardAssignments = (context, units) => {
  if (context.shardIndexOverride === null || context.shardCount <= 1) {
    return new Map();
  }

  const entriesNeedingAssignment = units.filter((unit) => {
    if (unit.fixedShardIndex !== undefined) {
      return false;
    }
    const explicitFilterCount = countExplicitEntryFilters(unit.args);
    if (explicitFilterCount === null) {
      return false;
    }
    const effectiveShardCount = Math.min(context.shardCount, Math.max(1, explicitFilterCount - 1));
    return effectiveShardCount <= 1;
  });

  const assignmentMap = new Map();
  const pinnedShardLoadsMs = Array.from({ length: context.shardCount }, () => 0);
  for (const unit of units) {
    if (unit.fixedShardIndex === undefined) {
      continue;
    }
    const shardArrayIndex = unit.fixedShardIndex - 1;
    if (shardArrayIndex < 0 || shardArrayIndex >= pinnedShardLoadsMs.length) {
      continue;
    }
    pinnedShardLoadsMs[shardArrayIndex] += estimateTopLevelEntryDurationMs(unit, context);
  }
  const buckets = packFilesByDurationWithBaseLoads(
    entriesNeedingAssignment,
    context.shardCount,
    (unit) => estimateTopLevelEntryDurationMs(unit, context),
    pinnedShardLoadsMs,
  );
  for (const [bucketIndex, bucket] of buckets.entries()) {
    for (const unit of bucket) {
      assignmentMap.set(unit.id, bucketIndex + 1);
    }
  }
  return assignmentMap;
};

export const formatExecutionUnitSummary = (unit) =>
  `${unit.id} filters=${String(countExplicitEntryFilters(unit.args) || "all")} maxWorkers=${String(
    unit.maxWorkers ?? "default",
  )} surface=${unit.surface} isolate=${unit.isolate ? "yes" : "no"} pool=${unit.pool}`;

export function explainExecutionTarget(request, options = {}) {
  const context = createPlannerContext(request, options);
  context.noIsolateArgs =
    context.env.OPENCLAW_TEST_ISOLATE === "1" || context.env.OPENCLAW_TEST_ISOLATE === "true"
      ? []
      : context.env.OPENCLAW_TEST_NO_ISOLATE !== "0" &&
          context.env.OPENCLAW_TEST_NO_ISOLATE !== "false"
        ? ["--isolate=false"]
        : [];
  context.defaultWorkerBudget = resolveDefaultWorkerBudget(context.runtime);
  const [target] = request.fileFilters;
  const classification = context.catalog.classifyTestFile(target, { unitMemoryIsolatedFiles: [] });
  const targetedUnit = createTargetedUnit(context, classification, [normalizeRepoPath(target)]);
  return {
    runtimeProfile: context.runtime.runtimeProfileName,
    file: classification.file,
    surface: classification.legacyBasePinned ? "base" : classification.surface,
    isolate: targetedUnit.isolate,
    pool: targetedUnit.pool,
    maxWorkers: targetedUnit.maxWorkers,
    reasons: classification.reasons,
    args: targetedUnit.args,
  };
}

export function buildExecutionPlan(request, options = {}) {
  const env = options.env ?? process.env;
  const explicitFileFilters = (request.fileFilters ?? []).map((value) => normalizeRepoPath(value));
  const { fileFilters: passthroughFileFilters, optionArgs } = parsePassthroughArgs(
    request.passthroughArgs ?? [],
  );
  const fileFilters = [...explicitFileFilters, ...passthroughFileFilters];
  const passthroughMetadataFlags = new Set(["-h", "--help", "--listTags", "--clearCache"]);
  const passthroughMetadataOnly =
    (request.passthroughArgs ?? []).length > 0 &&
    fileFilters.length === 0 &&
    optionArgs.every((arg) => {
      if (!arg.startsWith("-")) {
        return false;
      }
      const [flag] = arg.split("=", 1);
      return passthroughMetadataFlags.has(flag);
    });
  const passthroughRequiresSingleRun = optionArgs.some((arg) => {
    if (!arg.startsWith("-")) {
      return false;
    }
    const [flag] = arg.split("=", 1);
    return SINGLE_RUN_ONLY_FLAGS.has(flag);
  });
  const context = createPlannerContext(
    {
      ...request,
      fileFilters,
      passthroughOptionArgs: optionArgs,
    },
    options,
  );
  context.noIsolateArgs =
    env.OPENCLAW_TEST_ISOLATE === "1" || env.OPENCLAW_TEST_ISOLATE === "true"
      ? []
      : env.OPENCLAW_TEST_NO_ISOLATE !== "0" && env.OPENCLAW_TEST_NO_ISOLATE !== "false"
        ? ["--isolate=false"]
        : [];
  context.defaultWorkerBudget = resolveDefaultWorkerBudget(context.runtime);
  context.writeTempJsonArtifact =
    options.writeTempJsonArtifact ??
    (() => {
      throw new Error("buildExecutionPlan requires writeTempJsonArtifact for include-file units");
    });

  const shardOverride = Number.parseInt(env.OPENCLAW_TEST_SHARDS ?? "", 10);
  context.configuredShardCount =
    Number.isFinite(shardOverride) && shardOverride > 1 ? shardOverride : null;
  context.shardCount = context.configuredShardCount ?? (context.runtime.isWindowsCi ? 2 : 1);
  const shardIndexOverride = Number.parseInt(env.OPENCLAW_TEST_SHARD_INDEX ?? "", 10);
  context.shardIndexOverride =
    Number.isFinite(shardIndexOverride) && shardIndexOverride > 0 ? shardIndexOverride : null;

  if (context.shardIndexOverride !== null && context.shardCount <= 1) {
    throw new Error(
      `OPENCLAW_TEST_SHARD_INDEX=${String(context.shardIndexOverride)} requires OPENCLAW_TEST_SHARDS>1.`,
    );
  }
  if (context.shardIndexOverride !== null && context.shardIndexOverride > context.shardCount) {
    throw new Error(
      `OPENCLAW_TEST_SHARD_INDEX=${String(context.shardIndexOverride)} exceeds OPENCLAW_TEST_SHARDS=${String(context.shardCount)}.`,
    );
  }

  const defaultPlanning = buildDefaultUnits(context, { ...request, fileFilters });
  let units = defaultPlanning.units;
  const targetedUnits = buildTargetedUnits(context, {
    ...request,
    fileFilters,
    unitMemoryIsolatedFiles: defaultPlanning.unitMemoryIsolatedFiles,
  });
  if (context.configuredShardCount !== null && context.shardCount > 1) {
    units = expandUnitsAcrossTopLevelShards(context, units);
  }
  const selectedUnits = targetedUnits.length > 0 ? targetedUnits : units;
  const topLevelSingleShardAssignments = buildTopLevelSingleShardAssignments(context, units);
  const parallelGatewayEnabled =
    !context.runtime.isMacMiniProfile &&
    (env.OPENCLAW_TEST_PARALLEL_GATEWAY === "1" ||
      (!context.runtime.isCI && context.runtime.highMemLocalHost));
  const keepGatewaySerial =
    context.runtime.isWindowsCi ||
    env.OPENCLAW_TEST_SERIAL_GATEWAY === "1" ||
    context.runtime.testProfile === "serial" ||
    !parallelGatewayEnabled;
  const parallelUnits = keepGatewaySerial
    ? selectedUnits.filter((unit) => unit.surface !== "gateway")
    : selectedUnits;
  const serialUnits = keepGatewaySerial
    ? selectedUnits.filter((unit) => unit.surface === "gateway")
    : [];
  const serialPrefixUnits = parallelUnits.filter((unit) => unit.serialPhase);
  const deferredParallelUnits = parallelUnits.filter((unit) => !unit.serialPhase);
  const topLevelParallelEnabled =
    context.runtime.testProfile !== "low" &&
    context.runtime.testProfile !== "serial" &&
    !(!context.runtime.isCI && context.runtime.nodeMajor >= 25) &&
    !context.runtime.isMacMiniProfile;
  const defaultTopLevelParallelLimit =
    context.noIsolateArgs.length > 0
      ? context.runtime.isCI
        ? context.runtime.isWindows
          ? 2
          : 4
        : context.runtime.highMemLocalHost
          ? Math.min(16, context.runtime.hostCpuCount)
          : context.runtime.lowMemLocalHost
            ? Math.min(8, context.runtime.hostCpuCount)
            : Math.min(12, context.runtime.hostCpuCount)
      : context.runtime.testProfile === "serial"
        ? 1
        : context.runtime.testProfile === "low"
          ? context.runtime.lowMemLocalHost
            ? 2
            : 3
          : context.runtime.testProfile === "max"
            ? 5
            : context.runtime.highMemLocalHost
              ? 4
              : context.runtime.lowMemLocalHost
                ? 2
                : 3;
  const topLevelParallelLimit = Math.max(
    1,
    parseEnvNumber(env, "OPENCLAW_TEST_TOP_LEVEL_CONCURRENCY", defaultTopLevelParallelLimit),
  );
  const deferredRunConcurrency = context.runtime.isMacMiniProfile
    ? 3
    : context.runtime.testProfile === "low"
      ? 1
      : !context.runtime.isCI && !context.runtime.highMemLocalHost
        ? 2
        : undefined;

  return {
    runtimeProfile: context.runtime,
    passthroughOptionArgs: optionArgs,
    passthroughRequiresSingleRun,
    passthroughMetadataOnly,
    fileFilters,
    allUnits: units,
    selectedUnits,
    targetedUnits,
    parallelUnits,
    serialUnits,
    serialPrefixUnits,
    deferredParallelUnits,
    topLevelParallelEnabled,
    topLevelParallelLimit,
    deferredRunConcurrency,
    keepGatewaySerial,
    shardCount: context.shardCount,
    shardIndexOverride: context.shardIndexOverride,
    topLevelSingleShardAssignments,
  };
}
