import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { createStaleWhileRevalidateCache } from "openclaw/plugin-sdk/collection-runtime";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { ZaloCredentialPersistence } from "./credential-persistence.js";
import type { ZaloGroupContext } from "./types.js";
import type { API } from "./zca-client.js";

const GROUP_CONTEXT_CACHE_TTL_MS = 5 * 60_000;
const GROUP_CONTEXT_CACHE_MAX_ENTRIES = 500;

export type ActiveZaloQrLogin = {
  id: string;
  startedAt: number;
  beforeCredentialPersistence?: () => Promise<void>;
  assertCredentialPersistenceCurrent?: () => void;
  qrDataUrl?: string;
  connected: boolean;
  error?: string;
  abort?: () => void;
  waitPromise: Promise<void>;
};

type ActiveZaloListener = {
  accountId: string;
  stop: () => void;
};

type ZaloSessionState = ReturnType<typeof createZaloSessionState>;

// Bundled modules survive replacement; the SDK slot follows the invoking instance,
// while direct standalone calls keep their existing process-local session lifetime.
const zalouserSessionStore = createPluginRuntimeStore<ZaloSessionState>({
  key: "zalouser:sessions",
  errorMessage: "Zalouser sessions not initialized",
});

export function registerZalouserRuntimeLifecycle(api: OpenClawPluginApi): void {
  api.lifecycle.onDispose?.(() => {
    zalouserSessionStore.tryGetRuntime()?.dispose();
    zalouserSessionStore.clearRuntime();
  });
}

function createZaloSessionState() {
  const apiByProfile = new Map<string, API>();
  const apiInitByProfile = new Map<string, Promise<API>>();
  const credentials = new ZaloCredentialPersistence(
    (profile, api) => apiByProfile.get(profile) === api,
  );
  const activeQrLogins = new Map<string, ActiveZaloQrLogin>();
  const activeListeners = new Map<string, ActiveZaloListener>();
  const groupContextCache = createStaleWhileRevalidateCache<ZaloGroupContext>({
    maxEntries: GROUP_CONTEXT_CACHE_MAX_ENTRIES,
    maxPending: Infinity,
    ttlMs: GROUP_CONTEXT_CACHE_TTL_MS,
  });
  const state = {
    apiByProfile,
    apiInitByProfile,
    credentials,
    activeQrLogins,
    activeListeners,
    groupContextCache,
    dispose(): void {
      for (const profile of activeQrLogins.keys()) {
        resetQrLogin(profile, state);
      }
      for (const listener of activeListeners.values()) {
        listener.stop();
      }
      for (const profile of apiByProfile.keys()) {
        invalidateApi(profile, state);
      }
      apiInitByProfile.clear();
      groupContextCache.clear();
      credentials.dispose();
    },
  };
  return state;
}

export function getZaloSessionState(): ZaloSessionState {
  let state = zalouserSessionStore.tryGetRuntime();
  if (!state) {
    state = createZaloSessionState();
    zalouserSessionStore.setRuntime(state);
  }
  return state;
}

export function invalidateApi(
  profile: string,
  state: ZaloSessionState = getZaloSessionState(),
): void {
  const { apiByProfile, apiInitByProfile } = state;
  const api = apiByProfile.get(profile);
  if (api) {
    try {
      api.listener.stop();
    } catch {
      // ignore
    }
  }
  apiByProfile.delete(profile);
  apiInitByProfile.delete(profile);
}

export function resetQrLogin(
  profile: string,
  state: ZaloSessionState = getZaloSessionState(),
): void {
  const { activeQrLogins } = state;
  const active = activeQrLogins.get(profile);
  if (!active) {
    return;
  }
  try {
    active.abort?.();
  } catch {
    // ignore
  }
  activeQrLogins.delete(profile);
}
