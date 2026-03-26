import os from "node:os";

export const TEST_PROFILES = new Set(["normal", "serial", "max"]);

export const parsePositiveInt = (value) => {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
};

export const resolveVitestMode = (env = process.env, explicitMode = null) => {
  if (explicitMode === "ci" || explicitMode === "local") {
    return explicitMode;
  }
  return env.CI === "true" || env.GITHUB_ACTIONS === "true" ? "ci" : "local";
};

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const parseProfile = (rawProfile) => {
  if (!rawProfile) {
    return "normal";
  }
  const normalized = rawProfile.trim().toLowerCase();
  if (normalized === "low") {
    return "serial";
  }
  if (!TEST_PROFILES.has(normalized)) {
    throw new Error(
      `Unsupported test profile "${normalized}". Supported profiles: normal, serial, max.`,
    );
  }
  return normalized;
};

const resolveLoadRatio = (env, cpuCount, platform, loadAverage) => {
  const loadAwareDisabledRaw = env.OPENCLAW_TEST_LOAD_AWARE?.trim().toLowerCase();
  const loadAwareDisabled = loadAwareDisabledRaw === "0" || loadAwareDisabledRaw === "false";
  if (loadAwareDisabled || platform === "win32" || cpuCount <= 0) {
    return 0;
  }
  const source = Array.isArray(loadAverage) ? loadAverage : os.loadavg();
  return source.length > 0 ? source[0] / cpuCount : 0;
};

const resolveMemoryBand = (memoryGiB) => {
  if (memoryGiB < 24) {
    return "constrained";
  }
  if (memoryGiB < 48) {
    return "moderate";
  }
  if (memoryGiB < 96) {
    return "mid";
  }
  return "high";
};

const resolveLoadBand = (isLoadAware, loadRatio) => {
  if (!isLoadAware) {
    return "normal";
  }
  if (loadRatio < 0.5) {
    return "idle";
  }
  if (loadRatio < 0.9) {
    return "normal";
  }
  if (loadRatio < 1.1) {
    return "busy";
  }
  return "saturated";
};

const scaleForLoad = (value, loadBand) => {
  if (value === null || value === undefined) {
    return value;
  }
  const scale = loadBand === "busy" ? 0.75 : loadBand === "saturated" ? 0.5 : 1;
  return Math.max(1, Math.floor(value * scale));
};

const scaleConcurrencyForLoad = (value, loadBand) => {
  if (value === null || value === undefined) {
    return value;
  }
  const scale = loadBand === "busy" ? 0.8 : loadBand === "saturated" ? 0.5 : 1;
  return Math.max(1, Math.floor(value * scale));
};

const LOCAL_MEMORY_BUDGETS = {
  constrained: {
    vitestCap: 2,
    unitShared: 2,
    unitIsolated: 1,
    unitHeavy: 1,
    extensions: 1,
    gateway: 1,
    topLevelNoIsolate: 4,
    topLevelIsolated: 2,
    deferred: 1,
    heavyFileLimit: 36,
    heavyLaneCount: 3,
    memoryHeavyFileLimit: 8,
    unitFastBatchTargetMs: 10_000,
    channelsBatchTargetMs: 0,
  },
  moderate: {
    vitestCap: 3,
    unitShared: 3,
    unitIsolated: 1,
    unitHeavy: 1,
    extensions: 2,
    gateway: 1,
    topLevelNoIsolate: 6,
    topLevelIsolated: 2,
    deferred: 1,
    heavyFileLimit: 48,
    heavyLaneCount: 4,
    memoryHeavyFileLimit: 12,
    unitFastBatchTargetMs: 15_000,
    channelsBatchTargetMs: 0,
  },
  mid: {
    vitestCap: 4,
    unitShared: 4,
    unitIsolated: 1,
    unitHeavy: 1,
    extensions: 3,
    gateway: 1,
    topLevelNoIsolate: 8,
    topLevelIsolated: 3,
    deferred: 2,
    heavyFileLimit: 60,
    heavyLaneCount: 4,
    memoryHeavyFileLimit: 16,
    unitFastBatchTargetMs: 0,
    channelsBatchTargetMs: 0,
  },
  high: {
    vitestCap: 6,
    unitShared: 6,
    unitIsolated: 2,
    unitHeavy: 2,
    extensions: 4,
    gateway: 3,
    topLevelNoIsolate: 14,
    topLevelIsolated: 4,
    deferred: 8,
    heavyFileLimit: 80,
    heavyLaneCount: 5,
    memoryHeavyFileLimit: 16,
    unitFastBatchTargetMs: 45_000,
    channelsBatchTargetMs: 30_000,
  },
};

const withIntentBudgetAdjustments = (budget, intentProfile, cpuCount) => {
  if (intentProfile === "serial") {
    return {
      ...budget,
      vitestMaxWorkers: 1,
      unitSharedWorkers: 1,
      unitIsolatedWorkers: 1,
      unitHeavyWorkers: 1,
      extensionWorkers: 1,
      gatewayWorkers: 1,
      topLevelParallelEnabled: false,
      topLevelParallelLimit: 1,
      topLevelParallelLimitNoIsolate: 1,
      topLevelParallelLimitIsolated: 1,
      deferredRunConcurrency: 1,
    };
  }

  if (intentProfile === "max") {
    const maxTopLevelParallelLimit = clamp(
      Math.max(budget.topLevelParallelLimitNoIsolate ?? budget.topLevelParallelLimit ?? 1, 5),
      1,
      8,
    );
    return {
      ...budget,
      vitestMaxWorkers: clamp(Math.max(budget.vitestMaxWorkers, Math.min(8, cpuCount)), 1, 16),
      unitSharedWorkers: clamp(Math.max(budget.unitSharedWorkers, Math.min(8, cpuCount)), 1, 16),
      unitIsolatedWorkers: clamp(Math.max(budget.unitIsolatedWorkers, Math.min(4, cpuCount)), 1, 4),
      unitHeavyWorkers: clamp(Math.max(budget.unitHeavyWorkers, Math.min(4, cpuCount)), 1, 4),
      extensionWorkers: clamp(Math.max(budget.extensionWorkers, Math.min(6, cpuCount)), 1, 6),
      gatewayWorkers: clamp(Math.max(budget.gatewayWorkers, Math.min(2, cpuCount)), 1, 6),
      topLevelParallelEnabled: true,
      topLevelParallelLimit: maxTopLevelParallelLimit,
      topLevelParallelLimitNoIsolate: maxTopLevelParallelLimit,
      topLevelParallelLimitIsolated: clamp(
        Math.max(budget.topLevelParallelLimitIsolated ?? budget.topLevelParallelLimit ?? 1, 4),
        1,
        8,
      ),
      deferredRunConcurrency: Math.max(budget.deferredRunConcurrency ?? 1, 3),
    };
  }

  return budget;
};

export function resolveRuntimeCapabilities(env = process.env, options = {}) {
  const mode = resolveVitestMode(env, options.mode ?? null);
  const isCI = mode === "ci";
  const platform = options.platform ?? process.platform;
  const runnerOs = env.RUNNER_OS ?? "";
  const isMacOS = platform === "darwin" || runnerOs === "macOS";
  const isWindows = platform === "win32" || runnerOs === "Windows";
  const isWindowsCi = isCI && isWindows;
  const hostCpuCount =
    parsePositiveInt(env.OPENCLAW_TEST_HOST_CPU_COUNT) ?? options.cpuCount ?? os.cpus().length;
  const totalMemoryBytes = options.totalMemoryBytes ?? os.totalmem();
  const hostMemoryGiB =
    parsePositiveInt(env.OPENCLAW_TEST_HOST_MEMORY_GIB) ?? Math.floor(totalMemoryBytes / 1024 ** 3);
  const nodeMajor = Number.parseInt(
    (options.nodeVersion ?? process.versions.node).split(".")[0] ?? "",
    10,
  );
  const intentProfile = parseProfile(options.profile ?? env.OPENCLAW_TEST_PROFILE ?? "normal");
  const loadRatio = !isCI ? resolveLoadRatio(env, hostCpuCount, platform, options.loadAverage) : 0;
  const loadAware = !isCI && platform !== "win32";
  const memoryBand = resolveMemoryBand(hostMemoryGiB);
  const loadBand = resolveLoadBand(loadAware, loadRatio);
  const runtimeProfileName = isCI
    ? isWindows
      ? "ci-windows"
      : isMacOS
        ? "ci-macos"
        : "ci-linux"
    : isWindows
      ? "local-windows"
      : isMacOS
        ? "local-darwin"
        : "local-linux";

  return {
    mode,
    runtimeProfileName,
    isCI,
    isMacOS,
    isWindows,
    isWindowsCi,
    platform,
    hostCpuCount,
    hostMemoryGiB,
    nodeMajor,
    intentProfile,
    memoryBand,
    loadAware,
    loadRatio,
    loadBand,
  };
}

export function resolveExecutionBudget(runtimeCapabilities) {
  const runtime = runtimeCapabilities;
  const cpuCount = clamp(runtime.hostCpuCount, 1, 16);

  if (runtime.isCI) {
    const macCiWorkers = runtime.isMacOS ? 1 : null;
    return {
      vitestMaxWorkers: runtime.isWindows ? 2 : runtime.isMacOS ? 1 : 3,
      unitSharedWorkers: macCiWorkers,
      unitIsolatedWorkers: macCiWorkers,
      unitHeavyWorkers: macCiWorkers,
      extensionWorkers: macCiWorkers,
      gatewayWorkers: macCiWorkers,
      topLevelParallelEnabled: runtime.intentProfile !== "serial" && !runtime.isWindows,
      topLevelParallelLimit: runtime.isWindows ? 2 : 4,
      topLevelParallelLimitNoIsolate: runtime.isWindows ? 2 : 4,
      topLevelParallelLimitIsolated: runtime.isWindows ? 2 : 4,
      deferredRunConcurrency: null,
      heavyUnitFileLimit: 64,
      heavyUnitLaneCount: 4,
      memoryHeavyUnitFileLimit: 64,
      unitFastLaneCount: runtime.isWindows ? 1 : 3,
      unitFastBatchTargetMs: runtime.isWindows ? 0 : 45_000,
      channelsBatchTargetMs: runtime.isWindows ? 0 : 30_000,
      extensionsBatchTargetMs: runtime.isWindows ? 0 : 30_000,
    };
  }

  const bandBudget = LOCAL_MEMORY_BUDGETS[runtime.memoryBand];
  const baseBudget = {
    vitestMaxWorkers: Math.min(cpuCount, bandBudget.vitestCap),
    unitSharedWorkers: Math.min(cpuCount, bandBudget.unitShared),
    unitIsolatedWorkers: Math.min(cpuCount, bandBudget.unitIsolated),
    unitHeavyWorkers: Math.min(cpuCount, bandBudget.unitHeavy),
    extensionWorkers: Math.min(cpuCount, bandBudget.extensions),
    gatewayWorkers: Math.min(cpuCount, bandBudget.gateway),
    topLevelParallelEnabled: !runtime.isWindows,
    topLevelParallelLimit: Math.min(cpuCount, bandBudget.topLevelIsolated),
    topLevelParallelLimitNoIsolate: Math.min(cpuCount, bandBudget.topLevelNoIsolate),
    topLevelParallelLimitIsolated: Math.min(cpuCount, bandBudget.topLevelIsolated),
    deferredRunConcurrency: bandBudget.deferred,
    heavyUnitFileLimit: bandBudget.heavyFileLimit,
    heavyUnitLaneCount: bandBudget.heavyLaneCount,
    memoryHeavyUnitFileLimit: bandBudget.memoryHeavyFileLimit,
    unitFastLaneCount: 1,
    unitFastBatchTargetMs: bandBudget.unitFastBatchTargetMs,
    channelsBatchTargetMs: bandBudget.channelsBatchTargetMs ?? 0,
    extensionsBatchTargetMs: 240_000,
  };

  const loadAdjustedBudget = {
    ...baseBudget,
    vitestMaxWorkers: scaleForLoad(baseBudget.vitestMaxWorkers, runtime.loadBand),
    unitSharedWorkers: scaleForLoad(baseBudget.unitSharedWorkers, runtime.loadBand),
    unitHeavyWorkers: scaleForLoad(baseBudget.unitHeavyWorkers, runtime.loadBand),
    extensionWorkers: scaleForLoad(baseBudget.extensionWorkers, runtime.loadBand),
    gatewayWorkers: scaleForLoad(baseBudget.gatewayWorkers, runtime.loadBand),
    topLevelParallelLimit: scaleConcurrencyForLoad(
      baseBudget.topLevelParallelLimit,
      runtime.loadBand,
    ),
    topLevelParallelLimitNoIsolate: scaleConcurrencyForLoad(
      baseBudget.topLevelParallelLimitNoIsolate,
      runtime.loadBand,
    ),
    topLevelParallelLimitIsolated: scaleConcurrencyForLoad(
      baseBudget.topLevelParallelLimitIsolated,
      runtime.loadBand,
    ),
    deferredRunConcurrency:
      runtime.loadBand === "busy"
        ? Math.max(1, (baseBudget.deferredRunConcurrency ?? 1) - 1)
        : runtime.loadBand === "saturated"
          ? 1
          : baseBudget.deferredRunConcurrency,
  };

  return withIntentBudgetAdjustments(loadAdjustedBudget, runtime.intentProfile, cpuCount);
}

export function resolveLocalVitestMaxWorkers(env = process.env, options = {}) {
  const explicit = parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS);
  if (explicit !== null) {
    return explicit;
  }

  const runtimeCapabilities = resolveRuntimeCapabilities(env, {
    cpuCount: options.cpuCount,
    totalMemoryBytes: options.totalMemoryBytes,
    platform: options.platform,
    mode: "local",
    loadAverage: options.loadAverage,
    profile: options.profile,
  });
  return resolveExecutionBudget(runtimeCapabilities).vitestMaxWorkers;
}
