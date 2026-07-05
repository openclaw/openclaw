// Test Support helper module supports debug proxy env test helpers behavior.
import { afterEach, vi } from "vitest";

const DEBUG_PROXY_ENV_KEYS = [
  "OPENCLAW_DEBUG_PROXY_ENABLED",
<<<<<<< HEAD
  "OPENCLAW_DEBUG_PROXY_SESSION_ID",
  "OPENCLAW_STATE_DIR",
=======
  "OPENCLAW_DEBUG_PROXY_DB_PATH",
  "OPENCLAW_DEBUG_PROXY_BLOB_DIR",
  "OPENCLAW_DEBUG_PROXY_SESSION_ID",
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
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
<<<<<<< HEAD
  const originalProxyEnv = snapshotDebugProxyEnv();
  let priorProxyEnv = originalProxyEnv;

  afterEach(async () => {
    const { closeDebugProxyCaptureStore } = await import("openclaw/plugin-sdk/proxy-capture");
    const { closeOpenClawStateDatabaseForTest } =
      await import("openclaw/plugin-sdk/sqlite-runtime-testing");
    closeDebugProxyCaptureStore();
    closeOpenClawStateDatabaseForTest();
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    restoreDebugProxyEnv(priorProxyEnv);
    priorProxyEnv = originalProxyEnv;
=======
  let priorProxyEnv: DebugProxyEnvSnapshot = {};

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    restoreDebugProxyEnv(priorProxyEnv);
    priorProxyEnv = {};
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  });

  return {
    captureProxyEnv() {
      priorProxyEnv = snapshotDebugProxyEnv();
    },
    originalFetch,
  };
}
