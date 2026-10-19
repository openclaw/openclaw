/**
 * Runtime-state normalization and persistence for auth profile selection.
 * This state tracks order, last-good profile, and cooldown/failure metadata
 * separately from secret-bearing credentials.
 */
import { AUTH_STORE_VERSION } from "./constants.js";
import { readPersistedAuthProfileStateRaw, type AuthProfileDatabase } from "./sqlite.js";
import { coerceAuthProfileState } from "./state-normalization.js";
import type { AuthProfileState, AuthProfileStateStore } from "./types.js";

export { coerceAuthProfileState } from "./state-normalization.js";

/** Merges auth profile runtime state, with override records winning per key. */
export function mergeAuthProfileState(
  base: AuthProfileState,
  override: AuthProfileState,
): AuthProfileState {
  const mergeRecord = <T>(left?: Record<string, T>, right?: Record<string, T>) => {
    if (!left && !right) {
      return undefined;
    }
    return { ...left, ...right };
  };

  return {
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
}

/** Loads persisted auth profile runtime state from SQLite. */
export function loadPersistedAuthProfileState(
  agentDir?: string,
  database?: AuthProfileDatabase,
): AuthProfileState {
  return coerceAuthProfileState(readPersistedAuthProfileStateRaw(agentDir, database));
}

/** Builds the persisted auth profile runtime state payload. */
export function buildPersistedAuthProfileState(
  store: AuthProfileState,
): AuthProfileStateStore | null {
  const state = coerceAuthProfileState(store);
  if (!state.order && !state.lastGood && !state.usageStats) {
    return null;
  }
  return {
    version: AUTH_STORE_VERSION,
    ...(state.order ? { order: state.order } : {}),
    ...(state.lastGood ? { lastGood: state.lastGood } : {}),
    ...(state.usageStats ? { usageStats: state.usageStats } : {}),
  };
}
