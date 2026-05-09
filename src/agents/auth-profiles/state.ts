import { normalizeOptionalString } from "../../shared/string-coerce.js";
import type { OpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import {
  deleteOpenClawStateKvJson,
  deleteOpenClawStateKvJsonInTransaction,
  readOpenClawStateKvJson,
  readOpenClawStateKvJsonResultFromDatabase,
  writeOpenClawStateKvJson,
  writeOpenClawStateKvJsonInTransaction,
  type OpenClawStateJsonValue,
} from "../../state/openclaw-state-kv.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { resolveAuthProfileStoreKey } from "./paths.js";
import type { AuthProfileState, AuthProfileStateStore, ProfileUsageStats } from "./types.js";

export const AUTH_PROFILE_STATE_KV_SCOPE = "auth-profile-state";

export function authProfileStateKey(agentDir?: string): string {
  return resolveAuthProfileStoreKey(agentDir);
}

function normalizeAuthProfileOrder(raw: unknown): AuthProfileState["order"] {
  if (!raw || typeof raw !== "object") {
    return undefined;
  }
  const normalized = Object.entries(raw as Record<string, unknown>).reduce<
    Record<string, string[]>
  >((acc, [provider, value]) => {
    if (!Array.isArray(value)) {
      return acc;
    }
    const list = value.map((entry) => normalizeOptionalString(entry) ?? "").filter(Boolean);
    if (list.length > 0) {
      acc[provider] = list;
    }
    return acc;
  }, {});
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function coerceAuthProfileState(raw: unknown): AuthProfileState {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const record = raw as Record<string, unknown>;
  return {
    order: normalizeAuthProfileOrder(record.order),
    lastGood:
      record.lastGood && typeof record.lastGood === "object"
        ? (record.lastGood as Record<string, string>)
        : undefined,
    usageStats:
      record.usageStats && typeof record.usageStats === "object"
        ? (record.usageStats as Record<string, ProfileUsageStats>)
        : undefined,
  };
}

export function mergeAuthProfileState(
  base: AuthProfileState,
  override: AuthProfileState,
): AuthProfileState {
  const mergeRecord = <T>(left?: Record<string, T>, right?: Record<string, T>) => {
    if (!left && !right) {
      return undefined;
    }
    if (!left) {
      return { ...right };
    }
    if (!right) {
      return { ...left };
    }
    return { ...left, ...right };
  };

  return {
    order: mergeRecord(base.order, override.order),
    lastGood: mergeRecord(base.lastGood, override.lastGood),
    usageStats: mergeRecord(base.usageStats, override.usageStats),
  };
}

function authProfileStateToJsonValue(state: AuthProfileStateStore): OpenClawStateJsonValue {
  return state as OpenClawStateJsonValue;
}

function writeAuthProfileStatePayload(key: string, payload: AuthProfileStateStore): void {
  writeOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, key, authProfileStateToJsonValue(payload));
}

export function loadPersistedAuthProfileState(agentDir?: string): AuthProfileState {
  const key = authProfileStateKey(agentDir);
  const sqliteState = readOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, key);
  if (sqliteState !== undefined) {
    return coerceAuthProfileState(sqliteState);
  }

  return {};
}

export function loadPersistedAuthProfileStateFromDatabase(
  database: OpenClawStateDatabase,
  agentDir?: string,
): AuthProfileState {
  const key = authProfileStateKey(agentDir);
  const sqliteState = readOpenClawStateKvJsonResultFromDatabase(
    database,
    AUTH_PROFILE_STATE_KV_SCOPE,
    key,
  );
  if (sqliteState.exists && sqliteState.value !== undefined) {
    return coerceAuthProfileState(sqliteState.value);
  }

  return {};
}

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

export function savePersistedAuthProfileState(
  store: AuthProfileState,
  agentDir?: string,
): AuthProfileStateStore | null {
  return savePersistedAuthProfileStatePayload({
    store,
    key: authProfileStateKey(agentDir),
    write: (key, payload) => writeAuthProfileStatePayload(key, payload),
    delete: (key) => deleteOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, key),
  });
}

export function savePersistedAuthProfileStateInTransaction(
  database: OpenClawStateDatabase,
  store: AuthProfileState,
  agentDir?: string,
  updatedAt: number = Date.now(),
): AuthProfileStateStore | null {
  return savePersistedAuthProfileStatePayload({
    store,
    key: authProfileStateKey(agentDir),
    write: (key, payload) =>
      writeOpenClawStateKvJsonInTransaction(
        database,
        AUTH_PROFILE_STATE_KV_SCOPE,
        key,
        authProfileStateToJsonValue(payload),
        updatedAt,
      ),
    delete: (key) =>
      deleteOpenClawStateKvJsonInTransaction(database, AUTH_PROFILE_STATE_KV_SCOPE, key),
  });
}

function savePersistedAuthProfileStatePayload(params: {
  store: AuthProfileState;
  key: string;
  write: (key: string, payload: AuthProfileStateStore) => void;
  delete: (key: string) => void;
}): AuthProfileStateStore | null {
  const payload = buildPersistedAuthProfileState(params.store);
  if (!payload) {
    params.delete(params.key);
    return null;
  }
  params.write(params.key, payload);
  return payload;
}
