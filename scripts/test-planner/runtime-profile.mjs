import os from "node:os";

export const TEST_PROFILES = new Set(["low", "macmini", "max", "normal", "serial"]);

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

const resolveLoadRatio = (env, hostCpuCount, platform, loadAverage) => {
  const loadAwareDisabledRaw = env.OPENCLAW_TEST_LOAD_AWARE?.trim().toLowerCase();
  const loadAwareDisabled = loadAwareDisabledRaw === "0" || loadAwareDisabledRaw === "false";
  if (loadAwareDisabled || platform === "win32" || hostCpuCount <= 0) {
    return 0;
  }
  const source = Array.isArray(loadAverage) ? loadAverage : os.loadavg();
  return source.length > 0 ? source[0] / hostCpuCount : 0;
};

export function resolveRuntimeProfile(env = process.env, options = {}) {
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
  const highMemLocalHost = !isCI && hostMemoryGiB >= 96;
  const lowMemLocalHost = !isCI && hostMemoryGiB < 64;
  const nodeMajor = Number.parseInt(
    (options.nodeVersion ?? process.versions.node).split(".")[0] ?? "",
    10,
  );
  const rawTestProfile = (options.profile ?? env.OPENCLAW_TEST_PROFILE)?.trim().toLowerCase();
  const autoMacMiniProfile =
    !isCI && !rawTestProfile && isMacOS && hostCpuCount <= 12 && hostMemoryGiB <= 64;
  const testProfile = TEST_PROFILES.has(rawTestProfile)
    ? rawTestProfile
    : autoMacMiniProfile
      ? "macmini"
      : "normal";
  const isMacMiniProfile = testProfile === "macmini";
  const loadRatio = !isCI ? resolveLoadRatio(env, hostCpuCount, platform, options.loadAverage) : 0;
  const extremeLoadScale = loadRatio >= 1.1 ? 0.75 : loadRatio >= 1 ? 0.85 : 1;
  const baseLocalWorkers = Math.max(4, Math.min(16, hostCpuCount));
  const adjustedLocalWorkers = Math.max(
    4,
    Math.min(16, Math.floor(baseLocalWorkers * extremeLoadScale)),
  );
  const runtimeProfileName = isCI
    ? isWindows
      ? "ci-windows"
      : isMacOS
        ? "ci-macos"
        : "ci-linux"
    : isMacMiniProfile
      ? "macmini"
      : highMemLocalHost
        ? "local-high-mem"
        : lowMemLocalHost
          ? "local-constrained"
          : "local-mid-mem";

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
    highMemLocalHost,
    lowMemLocalHost,
    nodeMajor,
    testProfile,
    autoMacMiniProfile,
    isMacMiniProfile,
    loadRatio,
    extremeLoadScale,
    adjustedLocalWorkers,
  };
}

export function resolveLocalVitestMaxWorkers(env = process.env, options = {}) {
  const explicit = parsePositiveInt(env.OPENCLAW_VITEST_MAX_WORKERS);
  if (explicit !== null) {
    return explicit;
  }

  const runtime = resolveRuntimeProfile(env, {
    cpuCount: options.cpuCount,
    totalMemoryBytes: options.totalMemoryBytes,
    platform: options.platform,
    mode: "local",
    loadAverage: options.loadAverage,
  });
  const boundedCpuCount = Math.max(1, runtime.hostCpuCount);

  if (runtime.isMacOS && boundedCpuCount <= 12 && runtime.hostMemoryGiB <= 64) {
    return Math.min(3, boundedCpuCount);
  }
  if (runtime.hostMemoryGiB <= 64) {
    return Math.min(4, boundedCpuCount);
  }
  return Math.max(4, Math.min(16, boundedCpuCount));
}
