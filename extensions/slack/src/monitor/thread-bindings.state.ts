import fs from "node:fs";
import path from "node:path";
import { resolveStateDir } from "../../../../src/config/paths.js";
import { loadJsonFile, saveJsonFile } from "../../../../src/infra/json-file.js";
import {
  normalizeAccountId,
  resolveAgentIdFromSessionKey,
} from "../../../../src/routing/session-key.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  THREAD_BINDINGS_VERSION,
  type PersistedThreadBindingRecord,
  type PersistedThreadBindingsPayload,
  type ThreadBindingManager,
  type ThreadBindingRecord,
  type ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

type SlackThreadBindingsGlobalState = {
  managersByAccountId: Map<string, ThreadBindingManager>;
  bindingsByBindingKey: Map<string, ThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
  tokensByAccountId: Map<string, string>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
  lastPersistedAtMs: number;
};

// Store mutable state on globalThis so both Jiti and ESM loader paths share one registry.
const SLACK_THREAD_BINDINGS_STATE_KEY = "__openclawSlackThreadBindingsState";

function createSlackThreadBindingsGlobalState(): SlackThreadBindingsGlobalState {
  return {
    managersByAccountId: new Map<string, ThreadBindingManager>(),
    bindingsByBindingKey: new Map<string, ThreadBindingRecord>(),
    bindingsBySessionKey: new Map<string, Set<string>>(),
    tokensByAccountId: new Map<string, string>(),
    persistByAccountId: new Map<string, boolean>(),
    loadedBindings: false,
    lastPersistedAtMs: 0,
  };
}

function resolveSlackThreadBindingsGlobalState(): SlackThreadBindingsGlobalState {
  const runtimeGlobal = globalThis as typeof globalThis & {
    [SLACK_THREAD_BINDINGS_STATE_KEY]?: SlackThreadBindingsGlobalState;
  };
  if (!runtimeGlobal[SLACK_THREAD_BINDINGS_STATE_KEY]) {
    runtimeGlobal[SLACK_THREAD_BINDINGS_STATE_KEY] = createSlackThreadBindingsGlobalState();
  }
  return runtimeGlobal[SLACK_THREAD_BINDINGS_STATE_KEY];
}

const STATE = resolveSlackThreadBindingsGlobalState();

export const MANAGERS_BY_ACCOUNT_ID = STATE.managersByAccountId;
export const BINDINGS_BY_BINDING_KEY = STATE.bindingsByBindingKey;
export const BINDINGS_BY_SESSION_KEY = STATE.bindingsBySessionKey;
export const TOKENS_BY_ACCOUNT_ID = STATE.tokensByAccountId;
export const PERSIST_BY_ACCOUNT_ID = STATE.persistByAccountId;
export const THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS = 15_000;

export function rememberSlackThreadBindingToken(params: { accountId?: string; token?: string }) {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const token = params.token?.trim();
  if (!token) {
    return;
  }
  TOKENS_BY_ACCOUNT_ID.set(normalizedAccountId, token);
}

export function forgetSlackThreadBindingToken(accountId?: string) {
  TOKENS_BY_ACCOUNT_ID.delete(normalizeAccountId(accountId));
}

export function getSlackThreadBindingToken(accountId?: string): string | undefined {
  return TOKENS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
}

export function shouldDefaultPersist(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

export function resolveSlackThreadBindingsPath(): string {
  return path.join(resolveStateDir(process.env), "slack", "thread-bindings.json");
}

export function normalizeTargetKind(
  raw: unknown,
  targetSessionKey: string,
): ThreadBindingTargetKind {
  if (raw === "subagent" || raw === "acp") {
    return raw;
  }
  return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}

export function normalizeThreadId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Binding key for Slack: `accountId:channelId:threadTs`.
 * Slack thread_ts is only unique within a channel, so channelId is needed.
 */
export function toBindingRecordKey(params: {
  accountId: string;
  channelId: string;
  threadId: string;
}): string {
  return `${normalizeAccountId(params.accountId)}:${params.channelId.trim()}:${params.threadId.trim()}`;
}

export function resolveBindingRecordKey(params: {
  accountId?: string;
  channelId: string;
  threadId: string;
}): string | undefined {
  const threadId = normalizeThreadId(params.threadId);
  const channelId = params.channelId?.trim();
  if (!threadId || !channelId) {
    return undefined;
  }
  return toBindingRecordKey({
    accountId: normalizeAccountId(params.accountId),
    channelId,
    threadId,
  });
}

function normalizePersistedBinding(_bindingKey: string, raw: unknown): ThreadBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<PersistedThreadBindingRecord>;
  const channelId = typeof value.channelId === "string" ? value.channelId.trim() : "";
  const threadId = normalizeThreadId(value.threadId);
  const targetSessionKey =
    typeof value.targetSessionKey === "string"
      ? value.targetSessionKey.trim()
      : typeof value.sessionKey === "string"
        ? value.sessionKey.trim()
        : "";
  if (!threadId || !channelId || !targetSessionKey) {
    return null;
  }
  const accountId = normalizeAccountId(value.accountId);
  const targetKind = normalizeTargetKind(value.targetKind, targetSessionKey);
  const agentIdRaw = typeof value.agentId === "string" ? value.agentId.trim() : "";
  const agentId = agentIdRaw || resolveAgentIdFromSessionKey(targetSessionKey);
  const label = typeof value.label === "string" ? value.label.trim() || undefined : undefined;
  const boundBy = typeof value.boundBy === "string" ? value.boundBy.trim() || "system" : "system";
  const boundAt =
    typeof value.boundAt === "number" && Number.isFinite(value.boundAt)
      ? Math.floor(value.boundAt)
      : Date.now();
  const lastActivityAt =
    typeof value.lastActivityAt === "number" && Number.isFinite(value.lastActivityAt)
      ? Math.max(0, Math.floor(value.lastActivityAt))
      : boundAt;
  const idleTimeoutMs =
    typeof value.idleTimeoutMs === "number" && Number.isFinite(value.idleTimeoutMs)
      ? Math.max(0, Math.floor(value.idleTimeoutMs))
      : undefined;
  const maxAgeMs =
    typeof value.maxAgeMs === "number" && Number.isFinite(value.maxAgeMs)
      ? Math.max(0, Math.floor(value.maxAgeMs))
      : undefined;

  return {
    accountId,
    channelId,
    threadId,
    targetKind,
    targetSessionKey,
    agentId,
    label,
    // No webhookId/webhookToken for Slack — uses bot token directly
    boundBy,
    boundAt,
    lastActivityAt,
    idleTimeoutMs,
    maxAgeMs,
  };
}

export function normalizeThreadBindingDurationMs(raw: unknown, defaultsTo: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return defaultsTo;
  }
  const durationMs = Math.floor(raw);
  if (durationMs < 0) {
    return defaultsTo;
  }
  return durationMs;
}

export function resolveThreadBindingIdleTimeoutMs(params: {
  record: Pick<ThreadBindingRecord, "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number {
  const explicit = params.record.idleTimeoutMs;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return Math.max(0, Math.floor(params.defaultIdleTimeoutMs));
}

export function resolveThreadBindingMaxAgeMs(params: {
  record: Pick<ThreadBindingRecord, "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number {
  const explicit = params.record.maxAgeMs;
  if (typeof explicit === "number" && Number.isFinite(explicit)) {
    return Math.max(0, Math.floor(explicit));
  }
  return Math.max(0, Math.floor(params.defaultMaxAgeMs));
}

export function resolveThreadBindingInactivityExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "lastActivityAt" | "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number | undefined {
  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
    record: params.record,
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
  });
  if (idleTimeoutMs <= 0) {
    return undefined;
  }
  const lastActivityAt = Math.floor(params.record.lastActivityAt);
  if (!Number.isFinite(lastActivityAt) || lastActivityAt <= 0) {
    return undefined;
  }
  return lastActivityAt + idleTimeoutMs;
}

export function resolveThreadBindingMaxAgeExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "boundAt" | "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number | undefined {
  const maxAgeMs = resolveThreadBindingMaxAgeMs({
    record: params.record,
    defaultMaxAgeMs: params.defaultMaxAgeMs,
  });
  if (maxAgeMs <= 0) {
    return undefined;
  }
  const boundAt = Math.floor(params.record.boundAt);
  if (!Number.isFinite(boundAt) || boundAt <= 0) {
    return undefined;
  }
  return boundAt + maxAgeMs;
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

export function setBindingRecord(record: ThreadBindingRecord) {
  const bindingKey = toBindingRecordKey({
    accountId: record.accountId,
    channelId: record.channelId,
    threadId: record.threadId,
  });
  const existing = BINDINGS_BY_BINDING_KEY.get(bindingKey);
  if (existing) {
    unlinkSessionBinding(existing.targetSessionKey, bindingKey);
  }
  BINDINGS_BY_BINDING_KEY.set(bindingKey, record);
  linkSessionBinding(record.targetSessionKey, bindingKey);
}

export function removeBindingRecord(bindingKeyRaw: string): ThreadBindingRecord | null {
  const key = bindingKeyRaw.trim();
  if (!key) {
    return null;
  }
  const existing = BINDINGS_BY_BINDING_KEY.get(key);
  if (!existing) {
    return null;
  }
  BINDINGS_BY_BINDING_KEY.delete(key);
  unlinkSessionBinding(existing.targetSessionKey, key);
  return existing;
}

function shouldPersistAnyBindingState(): boolean {
  for (const value of PERSIST_BY_ACCOUNT_ID.values()) {
    if (value) {
      return true;
    }
  }
  return false;
}

export function shouldPersistBindingMutations(): boolean {
  if (shouldPersistAnyBindingState()) {
    return true;
  }
  return fs.existsSync(resolveSlackThreadBindingsPath());
}

export function saveBindingsToDisk(params: { force?: boolean; minIntervalMs?: number } = {}) {
  if (!params.force && !shouldPersistAnyBindingState()) {
    return;
  }
  const minIntervalMs =
    typeof params.minIntervalMs === "number" && Number.isFinite(params.minIntervalMs)
      ? Math.max(0, Math.floor(params.minIntervalMs))
      : 0;
  const now = Date.now();
  if (
    !params.force &&
    minIntervalMs > 0 &&
    STATE.lastPersistedAtMs > 0 &&
    now - STATE.lastPersistedAtMs < minIntervalMs
  ) {
    return;
  }
  const bindings: Record<string, PersistedThreadBindingRecord> = {};
  for (const [bindingKey, record] of BINDINGS_BY_BINDING_KEY.entries()) {
    bindings[bindingKey] = { ...record };
  }
  const payload: PersistedThreadBindingsPayload = {
    version: THREAD_BINDINGS_VERSION,
    bindings,
  };
  saveJsonFile(resolveSlackThreadBindingsPath(), payload);
  STATE.lastPersistedAtMs = now;
}

export function ensureBindingsLoaded() {
  if (STATE.loadedBindings) {
    return;
  }
  STATE.loadedBindings = true;
  BINDINGS_BY_BINDING_KEY.clear();
  BINDINGS_BY_SESSION_KEY.clear();

  const raw = loadJsonFile(resolveSlackThreadBindingsPath());
  if (!raw || typeof raw !== "object") {
    return;
  }
  const payload = raw as Partial<PersistedThreadBindingsPayload>;
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

export function resolveBindingIdsForSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
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
    const record = BINDINGS_BY_BINDING_KEY.get(bindingKey);
    if (!record) {
      continue;
    }
    if (params.accountId && record.accountId !== params.accountId) {
      continue;
    }
    if (params.targetKind && record.targetKind !== params.targetKind) {
      continue;
    }
    out.push(bindingKey);
  }
  return out;
}

export function resolveDefaultThreadBindingDurations() {
  return {
    defaultIdleTimeoutMs: DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    defaultMaxAgeMs: DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  };
}

export function resetSlackThreadBindingsForTests() {
  for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
    manager.stop();
  }
  MANAGERS_BY_ACCOUNT_ID.clear();
  BINDINGS_BY_BINDING_KEY.clear();
  BINDINGS_BY_SESSION_KEY.clear();
  TOKENS_BY_ACCOUNT_ID.clear();
  PERSIST_BY_ACCOUNT_ID.clear();
  STATE.loadedBindings = false;
  STATE.lastPersistedAtMs = 0;
}
