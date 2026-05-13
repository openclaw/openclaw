/** Gateway session persistence backed by the plugin SQLite state table. */

import type { GatewayPluginRuntime } from "../gateway/types.js";
import { createMemoryKeyedStore, type KeyedStore } from "../state/keyed-store.js";
import { formatErrorMessage } from "../utils/format.js";
import { debugLog, debugError } from "../utils/log.js";

/** Persisted gateway session state. */
export interface SessionState {
  sessionId: string | null;
  lastSeq: number | null;
  lastConnectedAt: number;
  intentLevelIndex: number;
  accountId: string;
  savedAt: number;
  appId?: string;
}

const SESSION_EXPIRE_TIME = 5 * 60 * 1000;
const SAVE_THROTTLE_MS = 1000;
const SESSION_STORE_NAMESPACE = "sessions";

let sessionStore: KeyedStore<SessionState> = createMemoryKeyedStore();

const throttleState = new Map<
  string,
  {
    pendingState: SessionState | null;
    lastSaveTime: number;
    throttleTimer: ReturnType<typeof setTimeout> | null;
  }
>();

export function configureSessionStore(runtime: GatewayPluginRuntime): void {
  sessionStore = runtime.state.openKeyedStore<SessionState>({
    namespace: SESSION_STORE_NAMESPACE,
    maxEntries: 100,
    defaultTtlMs: SESSION_EXPIRE_TIME,
  });
}

/** Load a saved session, rejecting expired or mismatched appId entries. */
export async function loadSession(
  accountId: string,
  expectedAppId?: string,
): Promise<SessionState | null> {
  try {
    const state = (await sessionStore.lookup(accountId)) ?? null;
    if (!state) {
      return null;
    }

    const now = Date.now();

    if (now - state.savedAt > SESSION_EXPIRE_TIME) {
      debugLog(
        `[session-store] Session expired for ${accountId}, age: ${Math.round((now - state.savedAt) / 1000)}s`,
      );
      await sessionStore.delete(accountId);
      return null;
    }

    if (expectedAppId && state.appId && state.appId !== expectedAppId) {
      debugLog(
        `[session-store] appId mismatch for ${accountId}: saved=${state.appId}, current=${expectedAppId}. Discarding stale session.`,
      );
      await sessionStore.delete(accountId);
      return null;
    }

    if (!state.sessionId || state.lastSeq === null || state.lastSeq === undefined) {
      debugLog(`[session-store] Invalid session data for ${accountId}`);
      return null;
    }

    debugLog(
      `[session-store] Loaded session for ${accountId}: sessionId=${state.sessionId}, lastSeq=${state.lastSeq}, appId=${state.appId ?? "unknown"}, age=${Math.round((now - state.savedAt) / 1000)}s`,
    );
    return state;
  } catch (err) {
    debugError(
      `[session-store] Failed to load session for ${accountId}: ${formatErrorMessage(err)}`,
    );
    return null;
  }
}

/** Save session state with throttling. */
export function saveSession(state: SessionState): void {
  const { accountId } = state;
  let throttle = throttleState.get(accountId);
  if (!throttle) {
    throttle = { pendingState: null, lastSaveTime: 0, throttleTimer: null };
    throttleState.set(accountId, throttle);
  }

  const now = Date.now();
  const timeSinceLastSave = now - throttle.lastSaveTime;

  if (timeSinceLastSave >= SAVE_THROTTLE_MS) {
    doSaveSession(state);
    throttle.lastSaveTime = now;
    throttle.pendingState = null;
    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer);
      throttle.throttleTimer = null;
    }
  } else {
    throttle.pendingState = state;
    if (!throttle.throttleTimer) {
      const delay = SAVE_THROTTLE_MS - timeSinceLastSave;
      throttle.throttleTimer = setTimeout(() => {
        const t = throttleState.get(accountId);
        if (t?.pendingState) {
          doSaveSession(t.pendingState);
          t.lastSaveTime = Date.now();
          t.pendingState = null;
        }
        if (t) {
          t.throttleTimer = null;
        }
      }, delay);
    }
  }
}

function doSaveSession(state: SessionState): void {
  const stateToSave: SessionState = { ...state, savedAt: Date.now() };
  void sessionStore.register(state.accountId, stateToSave, { ttlMs: SESSION_EXPIRE_TIME }).then(
    () => {
      debugLog(
        `[session-store] Saved session for ${state.accountId}: sessionId=${state.sessionId}, lastSeq=${state.lastSeq}`,
      );
    },
    (err: unknown) => {
      debugError(
        `[session-store] Failed to save session for ${state.accountId}: ${formatErrorMessage(err)}`,
      );
    },
  );
}

/** Clear a saved session and any pending throttle state. */
export function clearSession(accountId: string): void {
  const throttle = throttleState.get(accountId);
  if (throttle) {
    if (throttle.throttleTimer) {
      clearTimeout(throttle.throttleTimer);
    }
    throttleState.delete(accountId);
  }
  void sessionStore.delete(accountId).then(
    (cleared) => {
      if (cleared) {
        debugLog(`[session-store] Cleared session for ${accountId}`);
      }
    },
    (err: unknown) => {
      debugError(
        `[session-store] Failed to clear session for ${accountId}: ${formatErrorMessage(err)}`,
      );
    },
  );
}
