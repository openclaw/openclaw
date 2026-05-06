import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { loadJsonFile } from "../../infra/json-file.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  deleteOpenClawStateKvJson,
  readOpenClawStateKvJson,
  writeOpenClawStateKvJson,
  type OpenClawStateJsonValue,
} from "../../state/openclaw-state-kv.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import { AUTH_STATE_FILENAME } from "./path-constants.js";
import { resolveAuthStatePath } from "./paths.js";
import type { AuthProfileState, AuthProfileStateStore, ProfileUsageStats } from "./types.js";

const AUTH_PROFILE_STATE_KV_SCOPE = "auth-profile-state";

function authProfileStateKey(agentDir?: string): string {
  return resolveAuthStatePath(agentDir);
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

function buildPersistedAuthProfileState(store: AuthProfileState): AuthProfileStateStore | null {
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

export function legacyAuthProfileStateFileExists(agentDir?: string): boolean {
  try {
    return fs.statSync(resolveAuthStatePath(agentDir)).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

export function importLegacyAuthProfileStateFileToSqlite(agentDir?: string): { imported: boolean } {
  const statePath = resolveAuthStatePath(agentDir);
  if (!legacyAuthProfileStateFileExists(agentDir)) {
    return { imported: false };
  }
  const legacyState = coerceAuthProfileState(loadJsonFile(statePath));
  const payload = buildPersistedAuthProfileState(legacyState);
  if (payload) {
    writeAuthProfileStatePayload(statePath, payload);
  }
  try {
    fs.unlinkSync(statePath);
  } catch {
    // Import succeeded; a later doctor pass can remove the stale file.
  }
  return { imported: true };
}

export function discoverLegacyAuthProfileStateAgentDirs(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const agentsDir = path.join(resolveStateDir(env), "agents");
  const out: string[] = [];
  try {
    for (const entry of fs.readdirSync(agentsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agentDir = path.join(agentsDir, entry.name, "agent");
      if (fs.existsSync(path.join(agentDir, AUTH_STATE_FILENAME))) {
        out.push(agentDir);
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw error;
    }
  }
  return out;
}

export function savePersistedAuthProfileState(
  store: AuthProfileState,
  agentDir?: string,
): AuthProfileStateStore | null {
  const payload = buildPersistedAuthProfileState(store);
  if (!payload) {
    deleteOpenClawStateKvJson(AUTH_PROFILE_STATE_KV_SCOPE, authProfileStateKey(agentDir));
    return null;
  }
  writeAuthProfileStatePayload(authProfileStateKey(agentDir), payload);
  return payload;
}
