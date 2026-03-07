import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import {
  PUMBLE_THREAD_BINDINGS_VERSION,
  type PersistedPumbleThreadBindingsPayload,
  type PumbleThreadBindingManager,
  type PumbleThreadBindingRecord,
} from "./thread-bindings.types.js";

type PumbleThreadBindingsGlobalState = {
  managersByAccountId: Map<string, PumbleThreadBindingManager>;
  bindingsByThreadRootId: Map<string, PumbleThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
};

const PUMBLE_THREAD_BINDINGS_STATE_KEY = "__openclawPumbleThreadBindingsState";

function createPumbleThreadBindingsGlobalState(): PumbleThreadBindingsGlobalState {
  return {
    managersByAccountId: new Map<string, PumbleThreadBindingManager>(),
    bindingsByThreadRootId: new Map<string, PumbleThreadBindingRecord>(),
    bindingsBySessionKey: new Map<string, Set<string>>(),
    persistByAccountId: new Map<string, boolean>(),
    loadedBindings: false,
  };
}

function resolvePumbleThreadBindingsGlobalState(): PumbleThreadBindingsGlobalState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [PUMBLE_THREAD_BINDINGS_STATE_KEY]?: PumbleThreadBindingsGlobalState;
  };
  if (!runtimeGlobal[PUMBLE_THREAD_BINDINGS_STATE_KEY]) {
    runtimeGlobal[PUMBLE_THREAD_BINDINGS_STATE_KEY] = createPumbleThreadBindingsGlobalState();
  }
  return runtimeGlobal[PUMBLE_THREAD_BINDINGS_STATE_KEY];
}

const STATE = resolvePumbleThreadBindingsGlobalState();

export const MANAGERS_BY_ACCOUNT_ID = STATE.managersByAccountId;
export const BINDINGS_BY_THREAD_ROOT_ID = STATE.bindingsByThreadRootId;
export const BINDINGS_BY_SESSION_KEY = STATE.bindingsBySessionKey;

function resolveStateDir(): string {
  const override = process.env.OPENCLAW_STATE_DIR?.trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".openclaw");
}

export function resolveThreadBindingsPath(): string {
  return path.join(resolveStateDir(), "state", "pumble", "thread-bindings.json");
}

function loadJsonFile(pathname: string): unknown {
  try {
    const raw = fs.readFileSync(pathname, "utf8");
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

async function saveJsonFileAsync(pathname: string, data: unknown) {
  const dir = path.dirname(pathname);
  try {
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.promises.writeFile(pathname, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await fs.promises.chmod(pathname, 0o600);
  } catch {
    // Best-effort persistence — non-fatal
  }
}

export function resolveAgentIdFromSessionKey(sessionKey: string | undefined | null): string {
  const trimmed = (sessionKey ?? "").trim();
  if (!trimmed) {
    return "main";
  }
  // Parse "agent:{agentId}:{rest}" format
  if (trimmed.startsWith("agent:")) {
    const parts = trimmed.split(":");
    if (parts.length >= 2 && parts[1]) {
      return parts[1];
    }
  }
  return "main";
}

export function toBindingRecordKey(params: { accountId: string; threadRootId: string }): string {
  return `${normalizeAccountId(params.accountId)}:${params.threadRootId.trim()}`;
}

function normalizePersistedBinding(
  bindingKey: string,
  raw: unknown,
): PumbleThreadBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<PumbleThreadBindingRecord>;
  const threadRootId = typeof value.threadRootId === "string" ? value.threadRootId.trim() : "";
  const channelId = typeof value.channelId === "string" ? value.channelId.trim() : "";
  const targetSessionKey =
    typeof value.targetSessionKey === "string" ? value.targetSessionKey.trim() : "";
  if (!threadRootId || !channelId || !targetSessionKey) {
    return null;
  }
  const accountId = normalizeAccountId(value.accountId);
  const agentIdRaw = typeof value.agentId === "string" ? value.agentId.trim() : "";
  const agentId = agentIdRaw || resolveAgentIdFromSessionKey(targetSessionKey);
  const label = typeof value.label === "string" ? value.label.trim() || undefined : undefined;
  const boundBy = typeof value.boundBy === "string" ? value.boundBy.trim() || "system" : "system";
  const boundAt =
    typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
      ? Math.floor(value.boundAt)
      : Date.now();
  const expiresAt =
    typeof value.expiresAt === "number" && Number.isFinite(value.expiresAt)
      ? Math.max(0, Math.floor(value.expiresAt))
      : undefined;
  return {
    accountId,
    channelId,
    threadRootId,
    targetKind: "subagent",
    targetSessionKey,
    agentId,
    label,
    boundBy,
    boundAt,
    expiresAt,
  };
}

function linkSessionBinding(targetSessionKey: string, bindingKey: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key) ?? new Set<string>();
  threads.add(bindingKey);
  BINDINGS_BY_SESSION_KEY.set(key, threads);
}

function unlinkSessionBinding(targetSessionKey: string, bindingKey: string) {
  const key = targetSessionKey.trim();
  if (!key) {
    return;
  }
  const threads = BINDINGS_BY_SESSION_KEY.get(key);
  if (!threads) {
    return;
  }
  threads.delete(bindingKey);
  if (threads.size === 0) {
    BINDINGS_BY_SESSION_KEY.delete(key);
  }
}

export function setBindingRecord(record: PumbleThreadBindingRecord) {
  const bindingKey = toBindingRecordKey({
    accountId: record.accountId,
    threadRootId: record.threadRootId,
  });
  const existing = BINDINGS_BY_THREAD_ROOT_ID.get(bindingKey);
  if (existing) {
    unlinkSessionBinding(existing.targetSessionKey, bindingKey);
  }
  BINDINGS_BY_THREAD_ROOT_ID.set(bindingKey, record);
  linkSessionBinding(record.targetSessionKey, bindingKey);
}

export function removeBindingRecord(bindingKey: string): PumbleThreadBindingRecord | null {
  const key = bindingKey.trim();
  if (!key) {
    return null;
  }
  const existing = BINDINGS_BY_THREAD_ROOT_ID.get(key);
  if (!existing) {
    return null;
  }
  BINDINGS_BY_THREAD_ROOT_ID.delete(key);
  unlinkSessionBinding(existing.targetSessionKey, key);
  return existing;
}

export function resolveBindingIdsForSession(params: {
  targetSessionKey: string;
  accountId?: string;
}): string[] {
  const key = params.targetSessionKey.trim();
  if (!key) {
    return [];
  }
  const ids = BINDINGS_BY_SESSION_KEY.get(key);
  if (!ids) {
    return [];
  }
  const out: string[] = [];
  for (const bindingKey of ids.values()) {
    const record = BINDINGS_BY_THREAD_ROOT_ID.get(bindingKey);
    if (!record) {
      continue;
    }
    if (params.accountId && record.accountId !== params.accountId) {
      continue;
    }
    out.push(bindingKey);
  }
  return out;
}

function shouldPersistAnyBindingState(): boolean {
  for (const value of STATE.persistByAccountId.values()) {
    if (value) {
      return true;
    }
  }
  return false;
}

export function shouldDefaultPersist(): boolean {
  return process.env.NODE_ENV !== "test";
}

export function saveBindingsToDisk(params: { force?: boolean } = {}) {
  if (!params.force && !shouldPersistAnyBindingState()) {
    return;
  }
  const bindings: Record<string, PumbleThreadBindingRecord> = {};
  for (const [bindingKey, record] of BINDINGS_BY_THREAD_ROOT_ID.entries()) {
    bindings[bindingKey] = { ...record };
  }
  const payload: PersistedPumbleThreadBindingsPayload = {
    version: PUMBLE_THREAD_BINDINGS_VERSION,
    bindings,
  };
  void saveJsonFileAsync(resolveThreadBindingsPath(), payload);
}

export function ensureBindingsLoaded() {
  if (STATE.loadedBindings) {
    return;
  }
  STATE.loadedBindings = true;
  BINDINGS_BY_THREAD_ROOT_ID.clear();
  BINDINGS_BY_SESSION_KEY.clear();

  const raw = loadJsonFile(resolveThreadBindingsPath());
  if (!raw || typeof raw !== "object") {
    return;
  }
  const payload = raw as Partial<PersistedPumbleThreadBindingsPayload>;
  if (payload.version !== 1 || !payload.bindings || typeof payload.bindings !== "object") {
    return;
  }

  for (const [bindingKey, entry] of Object.entries(payload.bindings)) {
    const normalized = normalizePersistedBinding(bindingKey, entry);
    if (!normalized) {
      continue;
    }
    setBindingRecord(normalized);
  }
}

export function resetPumbleThreadBindingsForTests() {
  for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
    manager.stop();
  }
  MANAGERS_BY_ACCOUNT_ID.clear();
  BINDINGS_BY_THREAD_ROOT_ID.clear();
  BINDINGS_BY_SESSION_KEY.clear();
  STATE.persistByAccountId.clear();
  STATE.loadedBindings = false;
}

export const PERSIST_BY_ACCOUNT_ID = STATE.persistByAccountId;
