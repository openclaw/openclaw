import path from "node:path";
import { isUnitConfigTestFile } from "../../vitest.unit-paths.mjs";
import {
  loadChannelTimingManifest,
  loadExtensionTimingManifest,
  loadUnitMemoryHotspotManifest,
  loadUnitTimingManifest,
  packFilesByDuration,
  packFilesByDurationWithBaseLoads,
  selectUnitHeavyFileGroups,
} from "../test-runner-manifest.mjs";
import { loadTestCatalog, normalizeRepoPath } from "./catalog.mjs";
import { resolveExecutionBudget, resolveRuntimeCapabilities } from "./runtime-profile.mjs";
import {
  countExplicitEntryFilters,
  getExplicitEntryFilters,
  parsePassthroughArgs,
  SINGLE_RUN_ONLY_FLAGS,
} from "./vitest-args.mjs";

const parseEnvNumber = (env, name, fallback) => {
  const parsed = Number.parseInt(env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const parseBooleanLike = (value, fallback = false) => {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
  }
  return fallback;
};

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const sumKnownManifestDurationsMs = (manifest) =>
  Object.values(manifest.files ?? {}).reduce((totalMs, entry) => totalMs + entry.durationMs, 0);

const resolveDynamicShardCount = ({
  estimatedDurationMs,
  fileCount,
  targetDurationMs,
  targetFilesPerShard,
  minShards,
  maxShards,
}) => {
  const durationDriven =
    Number.isFinite(targetDurationMs) && targetDurationMs > 0
      ? Math.ceil(estimatedDurationMs / targetDurationMs)
      : 1;
  const fileDriven =
    Number.isFinite(targetFilesPerShard) && targetFilesPerShard > 0
      ? Math.ceil(fileCount / targetFilesPerShard)
      : 1;
  return clamp(Math.max(minShards, durationDriven, fileDriven), minShards, maxShards);
};

const createShardMatrixEntries = ({ checkNamePrefix, runtime, task, command, shardCount }) =>
  Array.from({ length: shardCount }, (_, index) => ({
    check_name: `${checkNamePrefix}-${String(index + 1)}`,
    runtime,
    task,
    command,
    shard_index: index + 1,
    shard_count: shardCount,
  }));

const parseChangedExtensionsMatrix = (value) => {
  if (typeof value === "object" && value !== null && Array.isArray(value.include)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && Array.isArray(parsed.include)) {
        return parsed;
      }
    } catch {}
  }
  return { include: [] };
};

const normalizeSurfaces = (values = []) => [
  ...new Set(
    values
      .flatMap((value) => String(value).split(","))
      .map((value) => value.trim())
      .filter(Boolean),
  ),
];

const EXPLICIT_PLAN_SURFACES = new Set([
  "unit",
  "extensions",
  "channels",
  "contracts",
  "gateway",
]);
const FAILURE_POLICIES = new Set(["fail-fast", "collect-all"]);

const validateExplicitSurfaces = (surfaces) => {
  const invalidSurfaces = surfaces.filter((surface) => !EXPLICIT_PLAN_SURFACES.has(surface));
  if (invalidSurfaces.length > 0) {
    throw new Error(
      `Unsupported --surface value(s): ${invalidSurfaces.join(", ")}. Supported surfaces: unit, extensions, channels, contracts, gateway.`,
    );
  }
};

const buildRequestedSurfaces = (request, env) => {
  const explicit = normalizeSurfaces(request.surfaces ?? []);
  if (explicit.length > 0) {
    validateExplicitSurfaces(explicit);
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
  if (env.OPENCLAW_TEST_INCLUDE_CONTRACTS === "1") {
    surfaces.push("contracts");
  }
  if (env.OPENCLAW_TEST_INCLUDE_GATEWAY === "1") {
    surfaces.push("gateway");
  }
  return surfaces;
};

const normalizeFailurePolicy = (requestFailurePolicy, optionArgs) => {
  if (requestFailurePolicy !== null && requestFailurePolicy !== undefined) {
    if (!FAILURE_POLICIES.has(requestFailurePolicy)) {
      throw new Error(
        `Unsupported failure policy "${String(requestFailurePolicy)}". Supported values: fail-fast, collect-all.`,
      );
    }
    return { failurePolicy: requestFailurePolicy, passthroughOptionArgs: optionArgs };
  }

  const normalizedOptionArgs = [];
  let failurePolicy = "fail-fast";

  for (let index = 0; index < optionArgs.length; index += 1) {
    const arg = optionArgs[index];
    if (arg === "--bail") {
      const nextValue = optionArgs[index + 1] ?? "";
      if (nextValue === "0") {
        failurePolicy = "collect-all";
        index += 1;
        continue;
      }
      throw new Error(
        `Unsupported wrapper-level --bail value: ${String(nextValue || "<missing>")}. Use --bail=0, --collect-failures, or --failure-policy=collect-all.`,
      );
    }
    if (arg.startsWith("--bail=")) {
      const value = arg.slice("--bail=".length);
      if (value === "0") {
        failurePolicy = "collect-all";
        continue;
      }
      throw new Error(
        `Unsupported wrapper-level --bail value: ${String(value || "<missing>")}. Use --bail=0, --collect-failures, or --failure-policy=collect-all.`,
      );
    }
    normalizedOptionArgs.push(arg);
  }

  return { failurePolicy, passthroughOptionArgs: normalizedOptionArgs };
};

const createPlannerContext = (request, options = {}) => {
  const env = options.env ?? process.env;
  const runtime = resolveRuntimeCapabilities(env, {
    mode: request.mode ?? null,
    profile: request.profile ?? null,
    cpuCount: options.cpuCount,
    totalMemoryBytes: options.totalMemoryBytes,
    platform: options.platform,
    loadAverage: options.loadAverage,
    nodeVersion: options.nodeVersion,
  });
  const executionBudget = resolveExecutionBudget(runtime);
  const catalog = options.catalog ?? loadTestCatalog();
  const unitTimingManifest = loadUnitTimingManifest();
  const channelTimingManifest = loadChannelTimingManifest();
  const extensionTimingManifest = loadExtensionTimingManifest();
  const unitMemoryHotspotManifest = loadUnitMemoryHotspotManifest();
  return {
    env,
    runtime,
    executionBudget,
    catalog,
    unitTimingManifest,
    channelTimingManifest,
    extensionTimingManifest,
    unitMemoryHotspotManifest,
  };
};

const resolveCIManifestScope = (scope = {}, env = process.env) => ({
  eventName: scope.eventName ?? env.GITHUB_EVENT_NAME ?? "pull_request",
  docsOnly: parseBooleanLike(scope.docsOnly ?? env.OPENCLAW_CI_DOCS_ONLY, false),
  docsChanged: parseBooleanLike(scope.docsChanged ?? env.OPENCLAW_CI_DOCS_CHANGED, false),
  runNode: parseBooleanLike(scope.runNode ?? env.OPENCLAW_CI_RUN_NODE, true),
  runMacos: parseBooleanLike(scope.runMacos ?? env.OPENCLAW_CI_RUN_MACOS, true),
  runAndroid: parseBooleanLike(scope.runAndroid ?? env.OPENCLAW_CI_RUN_ANDROID, true),
  runWindows: parseBooleanLike(scope.runWindows ?? env.OPENCLAW_CI_RUN_WINDOWS, true),
  runSkillsPython: parseBooleanLike(
    scope.runSkillsPython ?? env.OPENCLAW_CI_RUN_SKILLS_PYTHON,
    true,
  ),
  hasChangedExtensions: parseBooleanLike(
    scope.hasChangedExtensions ?? env.OPENCLAW_CI_HAS_CHANGED_EXTENSIONS,
    false,
  ),
  changedExtensionsMatrix: parseChangedExtensionsMatrix(
    scope.changedExtensionsMatrix ?? env.OPENCLAW_CI_CHANGED_EXTENSIONS_MATRIX,
  ),
  runChangedSmoke: parseBooleanLike(
    scope.runChangedSmoke ?? env.OPENCLAW_CI_RUN_CHANGED_SMOKE,
    true,
  ),
});

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
  if (config === "vitest.channels.config.ts") {
    return (file) =>
      context.channelTimingManifest.files[file]?.durationMs ??
      context.channelTimingManifest.defaultDurationMs;
  }
  if (config === "vitest.extensions.config.ts") {
    return (file) =>
      context.extensionTimingManifest.files[file]?.durationMs ??
      context.extensionTimingManifest.defaultDurationMs;
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

const splitFilesByBalancedDurationBudget = (files, targetDurationMs, estimateDurationMs) => {
  if (!Number.isFinite(targetDurationMs) || targetDurationMs <= 0 || files.length <= 1) {
    return [files];
  }
  const totalDurationMs = files.reduce((sum, file) => sum + estimateDurationMs(file), 0);
  const batchCount = clamp(Math.ceil(totalDurationMs / targetDurationMs), 1, files.length);
  const originalOrder = new Map(files.map((file, index) => [file, index]));
  return packFilesByDuration(files, batchCount, estimateDurationMs).map((batch) =>
    [...batch].toSorted(
      (left, right) => (originalOrder.get(left) ?? 0) - (originalOrder.get(right) ?? 0),
    ),
  );
};

const resolveUnitFastBatchTargetMs = ({ context, selectedSurfaceSet, unitOnlyRun }) => {
  const defaultTargetMs = context.executionBudget.unitFastBatchTargetMs;
  if (
    !unitOnlyRun &&
    selectedSurfaceSet.size > 1 &&
    !context.runtime.isCI &&
    context.runtime.memoryBand === "high"
  ) {
    return Math.max(defaultTargetMs, 75_000);
  }
  return defaultTargetMs;
};

const resolveMaxWorkersForUnit = (unit, context) => {
  const overrideWorkers = Number.parseInt(context.env.OPENCLAW_TEST_WORKERS ?? "", 10);
  const resolvedOverride =
    Number.isFinite(overrideWorkers) && overrideWorkers > 0 ? overrideWorkers : null;
  if (resolvedOverride) {
    return resolvedOverride;
  }
  const budget = context.executionBudget;
  if (unit.isolate) {
    return budget.unitIsolatedWorkers;
  }
  if (unit.id.startsWith("unit-heavy-")) {
    return budget.unitHeavyWorkers;
  }
  if (unit.surface === "extensions") {
    return budget.extensionWorkers;
  }
  if (unit.surface === "channels") {
    return budget.channelSharedWorkers ?? budget.unitSharedWorkers;
  }
  if (unit.surface === "contracts") {
    return budget.unitSharedWorkers;
  }
  if (unit.surface === "gateway") {
    return budget.gatewayWorkers;
  }
  return budget.unitSharedWorkers;
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

const resolveUnitHeavyFileGroups = (context) => {
  const { env, runtime, executionBudget, catalog, unitTimingManifest, unitMemoryHotspotManifest } =
    context;
  const heavyUnitFileLimit = parseEnvNumber(
    env,
    "OPENCLAW_TEST_HEAVY_UNIT_FILE_LIMIT",
    runtime.intentProfile === "max"
      ? Math.max(executionBudget.heavyUnitFileLimit, 90)
      : executionBudget.heavyUnitFileLimit,
  );
  const heavyUnitLaneCount = parseEnvNumber(
    env,
    "OPENCLAW_TEST_HEAVY_UNIT_LANES",
    runtime.intentProfile === "max"
      ? Math.max(executionBudget.heavyUnitLaneCount, 6)
      : executionBudget.heavyUnitLaneCount,
  );
  const heavyUnitMinDurationMs = parseEnvNumber(env, "OPENCLAW_TEST_HEAVY_UNIT_MIN_MS", 1200);
  const memoryHeavyUnitFileLimit = parseEnvNumber(
    env,
    "OPENCLAW_TEST_MEMORY_HEAVY_UNIT_FILE_LIMIT",
    executionBudget.memoryHeavyUnitFileLimit,
  );
  const memoryHeavyUnitMinDeltaKb = parseEnvNumber(
    env,
    "OPENCLAW_TEST_MEMORY_HEAVY_UNIT_MIN_KB",
    unitMemoryHotspotManifest.defaultMinDeltaKb,
  );
  return {
    heavyUnitLaneCount,
    ...selectUnitHeavyFileGroups({
      candidates: catalog.allKnownUnitFiles,
      behaviorOverrides: catalog.unitBehaviorOverrideSet,
      timedLimit: heavyUnitFileLimit,
      timedMinDurationMs: heavyUnitMinDurationMs,
      memoryLimit: memoryHeavyUnitFileLimit,
      memoryMinDeltaKb: memoryHeavyUnitMinDeltaKb,
      timings: unitTimingManifest,
      hotspots: unitMemoryHotspotManifest,
    }),
  };
};

const buildDefaultUnits = (context, request) => {
  const {
    env,
    executionBudget,
    catalog,
    unitTimingManifest,
    channelTimingManifest,
    extensionTimingManifest,
  } = context;
  const noIsolateArgs = context.noIsolateArgs;
  const selectedSurfaces = buildRequestedSurfaces(request, env);
  const selectedSurfaceSet = new Set(selectedSurfaces);
  const unitOnlyRun = selectedSurfaceSet.size === 1 && selectedSurfaceSet.has("unit");
  const channelsOnlyRun = selectedSurfaceSet.size === 1 && selectedSurfaceSet.has("channels");
  const contractsOnlyRun = selectedSurfaceSet.size === 1 && selectedSurfaceSet.has("contracts");
  const extensionsOnlyRun = selectedSurfaceSet.size === 1 && selectedSurfaceSet.has("extensions");

  const {
    heavyUnitLaneCount,
    memoryHeavyFiles: memoryHeavyUnitFiles,
    timedHeavyFiles: timedHeavyUnitFiles,
  } = resolveUnitHeavyFileGroups(context);
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
  const estimateExtensionDurationMs = (file) =>
    extensionTimingManifest.files[file]?.durationMs ?? extensionTimingManifest.defaultDurationMs;
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
  const defaultExtensionsBatchTargetMs = executionBudget.extensionsBatchTargetMs;
  const extensionsBatchTargetMs = parseEnvNumber(
    env,
    "OPENCLAW_TEST_EXTENSIONS_BATCH_TARGET_MS",
    defaultExtensionsBatchTargetMs,
  );
  const defaultUnitFastLaneCount = executionBudget.unitFastLaneCount;
  const unitFastLaneCount = Math.max(
    1,
    parseEnvNumber(env, "OPENCLAW_TEST_UNIT_FAST_LANES", defaultUnitFastLaneCount),
  );
  const defaultUnitFastBatchTargetMs = resolveUnitFastBatchTargetMs({
    context,
    selectedSurfaceSet,
    unitOnlyRun,
  });
  const unitFastBatchTargetMs = parseEnvNumber(
    env,
    "OPENCLAW_TEST_UNIT_FAST_BATCH_TARGET_MS",
    defaultUnitFastBatchTargetMs,
  );
  const defaultChannelsBatchTargetMs = executionBudget.channelsBatchTargetMs;
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
            serialPhase: unitOnlyRun ? undefined : "unit-fast",
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
          estimatedDurationMs: estimateUnitDurationMs(file),
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
          estimatedDurationMs: files.reduce((sum, file) => sum + estimateUnitDurationMs(file), 0),
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
          estimatedDurationMs: estimateUnitDurationMs(file),
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

  if (selectedSurfaceSet.has("channels")) {
    for (const file of catalog.channelIsolatedFiles) {
      units.push(
        createExecutionUnit(context, {
          id: `${path.basename(file, ".test.ts")}-channels-isolated`,
          surface: "channels",
          isolate: true,
          estimatedDurationMs: estimateChannelDurationMs(file),
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
  }

  if (selectedSurfaceSet.has("contracts")) {
    units.push(
      createExecutionUnit(context, {
        id: "contracts",
        surface: "contracts",
        isolate: false,
        serialPhase: contractsOnlyRun ? undefined : "contracts",
        args: ["vitest", "run", "--config", "vitest.contracts.config.ts", ...noIsolateArgs],
        reasons: ["contracts-shared"],
      }),
    );
  }

  if (selectedSurfaceSet.has("extensions")) {
    for (const file of catalog.extensionForkIsolatedFiles) {
      units.push(
        createExecutionUnit(context, {
          id: `extensions-${path.basename(file, ".test.ts")}-isolated`,
          surface: "extensions",
          isolate: true,
          estimatedDurationMs: estimateExtensionDurationMs(file),
          args: ["vitest", "run", "--config", "vitest.extensions.config.ts", "--pool=forks", file],
          reasons: ["extensions-isolated-manifest"],
        }),
      );
    }
    const extensionBatches = splitFilesByBalancedDurationBudget(
      extensionSharedCandidateFiles,
      extensionsBatchTargetMs,
      estimateExtensionDurationMs,
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
          serialPhase: extensionsOnlyRun ? undefined : "extensions",
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
          serialPhase: channelsOnlyRun ? undefined : "channels",
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
    if (owner === "contracts") {
      return [
        "vitest",
        "run",
        "--config",
        "vitest.contracts.config.ts",
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
  const estimateUnitDurationMs = (file) =>
    context.unitTimingManifest.files[file]?.durationMs ??
    context.unitTimingManifest.defaultDurationMs;
  const estimateChannelDurationMs = (file) =>
    context.channelTimingManifest.files[file]?.durationMs ??
    context.channelTimingManifest.defaultDurationMs;
  const defaultTargetedUnitBatchTargetMs = 12_000;
  const targetedUnitBatchTargetMs = parseEnvNumber(
    context.env,
    "OPENCLAW_TEST_TARGETED_UNIT_BATCH_TARGET_MS",
    defaultTargetedUnitBatchTargetMs,
  );
  const defaultTargetedChannelsBatchTargetMs = 11_000;
  const targetedChannelsBatchTargetMs = parseEnvNumber(
    context.env,
    "OPENCLAW_TEST_TARGETED_CHANNELS_BATCH_TARGET_MS",
    defaultTargetedChannelsBatchTargetMs,
  );
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
    if (
      classification.surface === "unit" &&
      uniqueFilters.length > 4 &&
      targetedUnitBatchTargetMs > 0
    ) {
      const estimatedTotalDurationMs = uniqueFilters.reduce(
        (totalMs, file) => totalMs + estimateUnitDurationMs(file),
        0,
      );
      if (estimatedTotalDurationMs > targetedUnitBatchTargetMs) {
        return splitFilesByBalancedDurationBudget(
          uniqueFilters,
          targetedUnitBatchTargetMs,
          estimateUnitDurationMs,
        ).map((batch, batchIndex) =>
          createExecutionUnit(context, {
            ...createTargetedUnit(context, classification, batch),
            id: `unit-batch-${String(batchIndex + 1)}`,
          }),
        );
      }
    }
    if (
      classification.surface === "channels" &&
      uniqueFilters.length > 4 &&
      targetedChannelsBatchTargetMs > 0
    ) {
      const estimatedTotalDurationMs = uniqueFilters.reduce(
        (totalMs, file) => totalMs + estimateChannelDurationMs(file),
        0,
      );
      if (estimatedTotalDurationMs > targetedChannelsBatchTargetMs) {
        return splitFilesByBalancedDurationBudget(
          uniqueFilters,
          targetedChannelsBatchTargetMs,
          estimateChannelDurationMs,
        ).map((batch, batchIndex) =>
          createExecutionUnit(context, {
            ...createTargetedUnit(context, classification, batch),
            id: `channels-batch-${String(batchIndex + 1)}`,
          }),
        );
      }
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
    return new WeakMap();
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

  const assignmentMap = new WeakMap();
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
      assignmentMap.set(unit, bucketIndex + 1);
    }
  }
  return assignmentMap;
};

export function buildCIExecutionManifest(scopeInput = {}, options = {}) {
  const env = options.env ?? process.env;
  const scope = resolveCIManifestScope(scopeInput, env);
  const context = createPlannerContext({ mode: "ci", profile: null }, { ...options, env });
  const isPullRequest = scope.eventName === "pull_request";
  const isPush = scope.eventName === "push";
  const nodeEligible = !scope.docsOnly && scope.runNode;
  const macosEligible = !scope.docsOnly && isPullRequest && scope.runMacos;
  const windowsEligible = !scope.docsOnly && scope.runWindows;
  const androidEligible = !scope.docsOnly && scope.runAndroid;
  const docsEligible = scope.docsChanged;
  const skillsPythonEligible = !scope.docsOnly && (isPush || scope.runSkillsPython);
  const extensionFastEligible = nodeEligible && scope.hasChangedExtensions;

  const channelCandidateFiles = context.catalog.allKnownTestFiles.filter((file) =>
    context.catalog.channelTestPrefixes.some((prefix) => file.startsWith(prefix)),
  );
  const unitShardCount = resolveDynamicShardCount({
    estimatedDurationMs: sumKnownManifestDurationsMs(context.unitTimingManifest),
    fileCount: context.catalog.allKnownUnitFiles.length,
    targetDurationMs: 30_000,
    targetFilesPerShard: 80,
    minShards: 1,
    maxShards: 4,
  });
  const channelShardCount = resolveDynamicShardCount({
    estimatedDurationMs: sumKnownManifestDurationsMs(context.channelTimingManifest),
    fileCount: channelCandidateFiles.length,
    targetDurationMs: 90_000,
    targetFilesPerShard: 150,
    minShards: 1,
    maxShards: 4,
  });
  const windowsShardCount = resolveDynamicShardCount({
    estimatedDurationMs: sumKnownManifestDurationsMs(context.unitTimingManifest),
    fileCount: context.catalog.allKnownUnitFiles.length,
    targetDurationMs: 12_000,
    targetFilesPerShard: 30,
    minShards: 1,
    maxShards: 6,
  });
  const macosNodeShardCount = resolveDynamicShardCount({
    estimatedDurationMs: sumKnownManifestDurationsMs(context.unitTimingManifest),
    fileCount: context.catalog.allKnownUnitFiles.length,
    targetDurationMs: 12_000,
    targetFilesPerShard: 30,
    minShards: 1,
    maxShards: 9,
  });
  const bunShardCount = resolveDynamicShardCount({
    estimatedDurationMs: sumKnownManifestDurationsMs(context.unitTimingManifest),
    fileCount: context.catalog.allKnownUnitFiles.length,
    targetDurationMs: 30_000,
    targetFilesPerShard: 80,
    minShards: 1,
    maxShards: 4,
  });

  const checksFastInclude = nodeEligible
    ? [
        {
          check_name: "checks-fast-extensions",
          runtime: "node",
          task: "extensions",
          command: "pnpm test:extensions",
        },
        {
          check_name: "checks-fast-contracts-protocol",
          runtime: "node",
          task: "contracts-protocol",
          command: "pnpm test:contracts\npnpm protocol:check",
        },
      ]
    : [];
  const checksInclude = nodeEligible
    ? [
        ...createShardMatrixEntries({
          checkNamePrefix: "checks-node-test",
          runtime: "node",
          task: "test",
          command: "pnpm test",
          shardCount: unitShardCount,
        }),
        ...createShardMatrixEntries({
          checkNamePrefix: "checks-node-channels",
          runtime: "node",
          task: "channels",
          command: "pnpm test:channels",
          shardCount: channelShardCount,
        }),
        ...(isPush
          ? [
              {
                check_name: "checks-node-compat-node22",
                runtime: "node",
                task: "compat-node22",
                node_version: "22.x",
                cache_key_suffix: "node22",
                command: [
                  "pnpm build",
                  "pnpm ui:build",
                  "node openclaw.mjs --help",
                  "node openclaw.mjs status --json --timeout 1",
                  "pnpm test:build:singleton",
                ].join("\n"),
              },
            ]
          : []),
      ]
    : [];
  const checksWindowsInclude = windowsEligible
    ? createShardMatrixEntries({
        checkNamePrefix: "checks-windows-node-test",
        runtime: "node",
        task: "test",
        command: "pnpm test",
        shardCount: windowsShardCount,
      })
    : [];
  const macosNodeInclude = macosEligible
    ? createShardMatrixEntries({
        checkNamePrefix: "macos-node",
        runtime: "node",
        task: "test",
        command: "pnpm test",
        shardCount: macosNodeShardCount,
      })
    : [];
  const androidInclude = androidEligible
    ? [
        {
          check_name: "android-test-play",
          task: "test-play",
          command: "./gradlew --no-daemon :app:testPlayDebugUnitTest",
        },
        {
          check_name: "android-test-third-party",
          task: "test-third-party",
          command: "./gradlew --no-daemon :app:testThirdPartyDebugUnitTest",
        },
        {
          check_name: "android-build-play",
          task: "build-play",
          command: "./gradlew --no-daemon :app:assemblePlayDebug",
        },
        {
          check_name: "android-build-third-party",
          task: "build-third-party",
          command: "./gradlew --no-daemon :app:assembleThirdPartyDebug",
        },
      ]
    : [];
  const bunChecksInclude = createShardMatrixEntries({
    checkNamePrefix: "bun-checks",
    runtime: "bun",
    task: "test",
    command: "bunx vitest run --config vitest.unit.config.ts",
    shardCount: bunShardCount,
  });
  const extensionFastInclude = extensionFastEligible
    ? scope.changedExtensionsMatrix.include.map((entry) => ({
        check_name: `extension-fast-${entry.extension}`,
        extension: entry.extension,
      }))
    : [];

  const jobs = {
    buildArtifacts: { enabled: nodeEligible, needsDistArtifacts: false },
    checksFast: { enabled: checksFastInclude.length > 0, matrix: { include: checksFastInclude } },
    checks: { enabled: checksInclude.length > 0, matrix: { include: checksInclude } },
    extensionFast: {
      enabled: extensionFastInclude.length > 0,
      matrix: { include: extensionFastInclude },
    },
    check: { enabled: !scope.docsOnly },
    checkAdditional: { enabled: !scope.docsOnly },
    buildSmoke: { enabled: nodeEligible },
    checkDocs: { enabled: docsEligible },
    skillsPython: { enabled: skillsPythonEligible },
    checksWindows: {
      enabled: checksWindowsInclude.length > 0,
      matrix: { include: checksWindowsInclude },
    },
    macosNode: { enabled: macosNodeInclude.length > 0, matrix: { include: macosNodeInclude } },
    macosSwift: { enabled: macosEligible },
    android: { enabled: androidInclude.length > 0, matrix: { include: androidInclude } },
    bunChecks: { enabled: bunChecksInclude.length > 0, matrix: { include: bunChecksInclude } },
    installSmoke: { enabled: !scope.docsOnly && scope.runChangedSmoke },
  };

  return {
    runtimeProfile: context.runtime.runtimeProfileName,
    scope,
    shardCounts: {
      unit: unitShardCount,
      channels: channelShardCount,
      windows: windowsShardCount,
      macosNode: macosNodeShardCount,
      bun: bunShardCount,
    },
    jobs,
    requiredCheckNames: [
      ...checksFastInclude.map((entry) => entry.check_name),
      ...checksInclude.map((entry) => entry.check_name),
      ...checksWindowsInclude.map((entry) => entry.check_name),
      ...macosNodeInclude.map((entry) => entry.check_name),
      ...(macosEligible ? ["macos-swift"] : []),
      ...androidInclude.map((entry) => entry.check_name),
      ...extensionFastInclude.map((entry) => entry.check_name),
      ...bunChecksInclude.map((entry) => entry.check_name),
      "check",
      "check-additional",
      "build-smoke",
      ...(docsEligible ? ["check-docs"] : []),
      ...(skillsPythonEligible ? ["skills-python"] : []),
      ...(nodeEligible ? ["build-artifacts"] : []),
    ],
  };
}

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
  const [target] = request.fileFilters;
  const matchedFiles = context.catalog.resolveFilterMatches(target);
  const normalizedTarget = matchedFiles[0] ?? normalizeRepoPath(target);
  const { memoryHeavyFiles } = resolveUnitHeavyFileGroups(context);
  const unitMemoryIsolatedFiles = [...memoryHeavyFiles].filter(
    (file) => !context.catalog.unitBehaviorOverrideSet.has(file),
  );
  const classification = context.catalog.classifyTestFile(normalizedTarget, {
    unitMemoryIsolatedFiles,
  });
  const targetedUnit = createTargetedUnit(context, classification, [normalizedTarget]);
  return {
    runtimeProfile: context.runtime.runtimeProfileName,
    intentProfile: context.runtime.intentProfile,
    memoryBand: context.runtime.memoryBand,
    loadBand: context.runtime.loadBand,
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
  const normalizedFailurePolicy = normalizeFailurePolicy(request.failurePolicy ?? null, optionArgs);
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
  const passthroughRequiresSingleRun = normalizedFailurePolicy.passthroughOptionArgs.some((arg) => {
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
      passthroughOptionArgs: normalizedFailurePolicy.passthroughOptionArgs,
    },
    options,
  );
  context.noIsolateArgs =
    env.OPENCLAW_TEST_ISOLATE === "1" || env.OPENCLAW_TEST_ISOLATE === "true"
      ? []
      : env.OPENCLAW_TEST_NO_ISOLATE !== "0" && env.OPENCLAW_TEST_NO_ISOLATE !== "false"
        ? ["--isolate=false"]
        : [];
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
    env.OPENCLAW_TEST_PARALLEL_GATEWAY === "1" ||
    (!context.runtime.isCI && context.executionBudget.gatewayWorkers > 1);
  const keepGatewaySerial =
    context.runtime.isWindowsCi ||
    env.OPENCLAW_TEST_SERIAL_GATEWAY === "1" ||
    context.runtime.intentProfile === "serial" ||
    !parallelGatewayEnabled;
  const parallelUnits = keepGatewaySerial
    ? selectedUnits.filter((unit) => unit.surface !== "gateway")
    : selectedUnits;
  const serialUnits = keepGatewaySerial
    ? selectedUnits.filter((unit) => unit.surface === "gateway")
    : [];
  const serialPrefixUnits = parallelUnits.filter((unit) => unit.serialPhase);
  const deferredParallelUnits = parallelUnits.filter((unit) => !unit.serialPhase);
  const topLevelParallelEnabled = context.executionBudget.topLevelParallelEnabled;
  const baseTopLevelParallelLimit =
    context.noIsolateArgs.length > 0
      ? context.executionBudget.topLevelParallelLimitNoIsolate
      : context.executionBudget.topLevelParallelLimitIsolated;
  const defaultTopLevelParallelLimit = baseTopLevelParallelLimit;
  const topLevelParallelLimit = Math.max(
    1,
    parseEnvNumber(env, "OPENCLAW_TEST_TOP_LEVEL_CONCURRENCY", defaultTopLevelParallelLimit),
  );
  const deferredRunConcurrency = context.executionBudget.deferredRunConcurrency;

  return {
    runtimeCapabilities: context.runtime,
    executionBudget: context.executionBudget,
    failurePolicy: normalizedFailurePolicy.failurePolicy,
    passthroughOptionArgs: normalizedFailurePolicy.passthroughOptionArgs,
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
