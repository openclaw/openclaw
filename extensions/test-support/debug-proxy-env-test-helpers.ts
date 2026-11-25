// Test Support helper module supports debug proxy env test helpers behavior.
import { afterEach, vi } from "vitest";

const DEBUG_PROXY_ENV_KEYS = [
  "OPENCLAW_DEBUG_PROXY_ENABLED",
  "OPENCLAW_DEBUG_PROXY_SESSION_ID",
  "OPENCLAW_STATE_DIR",
] as const;

type DebugProxyEnvKey = (typeof DEBUG_PROXY_ENV_KEYS)[number];
type DebugProxyEnvSnapshot = Partial<Record<DebugProxyEnvKey, string | undefined>>;

function snapshotDebugProxyEnv(): DebugProxyEnvSnapshot {
  return Object.fromEntries(
    DEBUG_PROXY_ENV_KEYS.map((key) => [key, process.env[key]]),
  ) as DebugProxyEnvSnapshot;
}

function restoreDebugProxyEnv(snapshot: DebugProxyEnvSnapshot): void {
  for (const key of DEBUG_PROXY_ENV_KEYS) {
    const value = snapshot[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}

export function installDebugProxyTestResetHooks() {
  const originalFetch = globalThis.fetch;
  const originalProxyEnv = snapshotDebugProxyEnv();
  let priorProxyEnv = originalProxyEnv;

  afterEach(async () => {
    const { closeDebugProxyCaptureStore, finalizeDebugProxyCaptureAsync } =
      await import("openclaw/plugin-sdk/proxy-capture");
    const { closeOpenClawStateDatabaseAsync, closeOpenClawStateDatabaseForTest } =
      await import("openclaw/plugin-sdk/sqlite-runtime-testing");
    const errors: unknown[] = [];
    for (const cleanup of [
      finalizeDebugProxyCaptureAsync,
      closeDebugProxyCaptureStore,
      closeOpenClawStateDatabaseAsync,
      closeOpenClawStateDatabaseForTest,
    ]) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    restoreDebugProxyEnv(priorProxyEnv);
    priorProxyEnv = originalProxyEnv;
    if (errors.length) {
      throw new AggregateError(errors, "Debug proxy test cleanup failed.");
    }
  });

  return {
    captureProxyEnv() {
      priorProxyEnv = snapshotDebugProxyEnv();
    },
    originalFetch,
  };
}
