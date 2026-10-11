/**
 * Runtime-state normalization and persistence for auth profile selection.
 * This state tracks order, last-good profile, and cooldown/failure metadata
 * separately from secret-bearing credentials.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { AUTH_STORE_VERSION } from "./constants.js";
import { coerceProfileUsageStats } from "./profile-usage-stats.js";
import { readPersistedAuthProfileStateRaw, type AuthProfileDatabase } from "./sqlite.js";
import type { AuthProfileState, AuthProfileStateStore } from "./types.js";

function normalizeAuthProfileEntries<T>(
  raw: unknown,
  normalizeKey: (value: string) => string | undefined,
  normalizeValue: (value: unknown) => T | undefined,
): Record<string, T> | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const normalized: Record<string, T> = {};
  for (const [rawKey, rawValue] of Object.entries(raw)) {
    const key = normalizeKey(rawKey);
    const value = normalizeValue(rawValue);
    if (!key || value === undefined) {
      continue;
    }
    normalized[key] = value;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

/** Coerces persisted auth profile runtime state into the current shape. */
export function coerceAuthProfileState(raw: unknown): AuthProfileState {
  if (!isRecord(raw)) {
    return {};
  }
  return {
    order: normalizeAuthProfileEntries(raw.order, normalizeProviderId, (value) => {
      const ids = Array.isArray(value) ? normalizeTrimmedStringList(value) : [];
      return ids.length > 0 ? ids : undefined;
    }),
    lastGood: normalizeAuthProfileEntries(
      raw.lastGood,
      normalizeProviderId,
      normalizeOptionalString,
    ),
    usageStats: normalizeAuthProfileEntries(
      raw.usageStats,
      normalizeOptionalString,
      coerceProfileUsageStats,
    ),
  };
}

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
