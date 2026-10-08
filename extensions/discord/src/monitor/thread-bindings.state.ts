import { resolveGlobalSingleton } from "openclaw/plugin-sdk/global-singleton";
import {
  resolveNonNegativeIntegerOption,
  resolveOptionalIntegerOption,
} from "openclaw/plugin-sdk/number-runtime";
import { recordOutboundMessageIdentity } from "openclaw/plugin-sdk/outbound-echo-runtime";
import type { PluginStateEntry } from "openclaw/plugin-sdk/plugin-state-runtime";
import { normalizeAccountId, resolveAgentIdFromSessionKey } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveThreadBindingExpiry } from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import { getDiscordRuntime } from "../runtime.js";
import type {
  ThreadBindingManager,
  ThreadBindingRecord,
  ThreadBindingTargetKind,
} from "./thread-bindings.types.js";

export type ThreadBindingPersistence = {
  targetKey: string;
  deletingTarget: boolean;
  nextRecord: ThreadBindingRecord | null;
  writingKey?: string;
  committedKeys: Set<string>;
};

type ThreadBindingsGlobalState = {
  managersByAccountId: Map<string, ThreadBindingManager>;
  bindingsByThreadId: Map<string, ThreadBindingRecord>;
  bindingsBySessionKey: Map<string, Set<string>>;
  tokensByAccountId: Map<string, string>;
  reusableWebhooksByAccountChannel: Map<string, { webhookId: string; webhookToken: string }>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
  loadingBindings?: Promise<void>;
  loadedPersistentBindings: boolean;
  persistenceAvailable: boolean;
  lastPersistedAtMs: number;
  revision: number;
  mutationTail: Promise<void>;
  accountOperationTails: WeakMap<ThreadBindingManager, Promise<void>>;
  activePersistence?: ThreadBindingPersistence;
};

// Plugin hooks can load this module through a separate runtime path while core
// imports it via ESM. Store mutable state on globalThis so both paths share one
// registry.
const THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.discordThreadBindingsState");

function createThreadBindingsGlobalState(): ThreadBindingsGlobalState {
  return {
    managersByAccountId: new Map(),
    bindingsByThreadId: new Map(),
    bindingsBySessionKey: new Map(),
    tokensByAccountId: new Map(),
    reusableWebhooksByAccountChannel: new Map(),
    persistByAccountId: new Map(),
    loadedBindings: false,
    loadedPersistentBindings: false,
    persistenceAvailable: true,
    lastPersistedAtMs: 0,
    revision: 0,
    mutationTail: Promise.resolve(),
    accountOperationTails: new WeakMap(),
  };
}

export const THREAD_BINDINGS_STATE = resolveGlobalSingleton(
  THREAD_BINDINGS_STATE_KEY,
  createThreadBindingsGlobalState,
);
// Source-plugin reloads retain the previous generation's shared registry.
THREAD_BINDINGS_STATE.accountOperationTails ??= new WeakMap();

export const MANAGERS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.managersByAccountId;
export const BINDINGS_BY_THREAD_ID = THREAD_BINDINGS_STATE.bindingsByThreadId;
const BINDINGS_BY_SESSION_KEY = THREAD_BINDINGS_STATE.bindingsBySessionKey;
const TOKENS_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.tokensByAccountId;
export const REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL =
  THREAD_BINDINGS_STATE.reusableWebhooksByAccountChannel;
export const PERSIST_BY_ACCOUNT_ID = THREAD_BINDINGS_STATE.persistByAccountId;
export const THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS = 15_000;
export const THREAD_BINDINGS_NAMESPACE = "thread-bindings";
export const THREAD_BINDINGS_MAX_ENTRIES = 10_000;

export function rememberThreadBindingToken(params: { accountId?: string; token?: string }) {
  const normalizedAccountId = normalizeAccountId(params.accountId);
  const token = params.token?.trim();
  if (!token) {
    return;
  }
  TOKENS_BY_ACCOUNT_ID.set(normalizedAccountId, token);
}

export function forgetThreadBindingToken(accountId?: string) {
  TOKENS_BY_ACCOUNT_ID.delete(normalizeAccountId(accountId));
}

export function getThreadBindingToken(accountId?: string): string | undefined {
  return TOKENS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
}

export function shouldDefaultPersist(): boolean {
  return !(process.env.VITEST || process.env.NODE_ENV === "test");
}

export function openThreadBindingsStore() {
  return getDiscordRuntime().state.openSyncKeyedStore<ThreadBindingRecord>({
    namespace: THREAD_BINDINGS_NAMESPACE,
    maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
  });
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

export function toBindingRecordKey(params: { accountId: string; threadId: string }): string {
  return `${normalizeAccountId(params.accountId)}:${params.threadId.trim()}`;
}

export function resolveBindingRecordKey(params: {
  accountId?: string;
  threadId: string;
}): string | undefined {
  const threadId = normalizeOptionalStringifiedId(params.threadId);
  if (!threadId) {
    return undefined;
  }
  return toBindingRecordKey({
    accountId: normalizeAccountId(params.accountId),
    threadId,
  });
}

export function normalizePersistedBinding(
  threadIdKey: string,
  raw: unknown,
): ThreadBindingRecord | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }
  const value = raw as Partial<ThreadBindingRecord>;
  const threadId = normalizeOptionalStringifiedId(value.threadId ?? threadIdKey);
  const channelId = normalizeOptionalString(value.channelId) ?? "";
  const targetSessionKey = normalizeOptionalString(value.targetSessionKey) ?? "";
  if (!threadId || !channelId || !targetSessionKey) {
    return null;
  }
  const accountId = normalizeAccountId(value.accountId);
  const targetKind = normalizeTargetKind(value.targetKind, targetSessionKey);
  const agentIdRaw = normalizeOptionalString(value.agentId) ?? "";
  const agentId = agentIdRaw || resolveAgentIdFromSessionKey(targetSessionKey);
  const label = normalizeOptionalString(value.label);
  const webhookId = normalizeOptionalString(value.webhookId);
  const webhookToken = normalizeOptionalString(value.webhookToken);
  const boundBy = normalizeOptionalString(value.boundBy) ?? "system";
  const boundAt = resolveOptionalIntegerOption(value.boundAt) ?? Date.now();
  const lastActivityAt = resolveOptionalIntegerOption(value.lastActivityAt, { min: 0 }) ?? boundAt;
  const idleTimeoutMs = resolveOptionalIntegerOption(value.idleTimeoutMs, { min: 0 });
  const maxAgeMs = resolveOptionalIntegerOption(value.maxAgeMs, { min: 0 });
  const metadata =
    value.metadata && typeof value.metadata === "object" ? { ...value.metadata } : undefined;

  return {
    accountId,
    channelId,
    threadId,
    targetKind,
    targetSessionKey,
    agentId,
    boundBy,
    boundAt,
    lastActivityAt,
    ...(label !== undefined ? { label } : {}),
    ...(webhookId !== undefined ? { webhookId } : {}),
    ...(webhookToken !== undefined ? { webhookToken } : {}),
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
    ...(maxAgeMs !== undefined ? { maxAgeMs } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function normalizeThreadBindingDurationMs(raw: unknown, defaultsTo: number): number {
  const durationMs = resolveOptionalIntegerOption(raw);
  return durationMs !== undefined && durationMs >= 0 ? durationMs : defaultsTo;
}

export function resolveThreadBindingIdleTimeoutMs(params: {
  record: Pick<ThreadBindingRecord, "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number {
  return resolveNonNegativeIntegerOption(params.record.idleTimeoutMs, params.defaultIdleTimeoutMs);
}

export function resolveThreadBindingMaxAgeMs(params: {
  record: Pick<ThreadBindingRecord, "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number {
  return resolveNonNegativeIntegerOption(params.record.maxAgeMs, params.defaultMaxAgeMs);
}

function resolveTimestampExpiry(timestamp: number, durationMs: number): number | undefined {
  if (durationMs <= 0) {
    return undefined;
  }
  const at = Math.floor(timestamp);
  return Number.isFinite(at) && at > 0 ? at + durationMs : undefined;
}

export function resolvePreparedThreadBindingLifecycle(params: {
  record: ThreadBindingRecord;
  idleTimeoutMs: number;
  maxAgeMs: number;
}) {
  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs({
    record: params.record,
    defaultIdleTimeoutMs: params.idleTimeoutMs,
  });
  const maxAgeMs = resolveThreadBindingMaxAgeMs({
    record: params.record,
    defaultMaxAgeMs: params.maxAgeMs,
  });
  return {
    idleTimeoutMs,
    maxAgeMs,
    ...resolveThreadBindingExpiry({
      inactivityExpiresAt: resolveTimestampExpiry(params.record.lastActivityAt, idleTimeoutMs),
      maxAgeExpiresAt: resolveTimestampExpiry(params.record.boundAt, maxAgeMs),
    }),
  };
}

export function resolveThreadBindingInactivityExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "lastActivityAt" | "idleTimeoutMs">;
  defaultIdleTimeoutMs: number;
}): number | undefined {
  const idleTimeoutMs = resolveThreadBindingIdleTimeoutMs(params);
  return resolveTimestampExpiry(params.record.lastActivityAt, idleTimeoutMs);
}

export function resolveThreadBindingMaxAgeExpiresAt(params: {
  record: Pick<ThreadBindingRecord, "boundAt" | "maxAgeMs">;
  defaultMaxAgeMs: number;
}): number | undefined {
  const maxAgeMs = resolveThreadBindingMaxAgeMs(params);
  return resolveTimestampExpiry(params.record.boundAt, maxAgeMs);
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

export function toReusableWebhookKey(params: { accountId: string; channelId: string }): string {
  return `${normalizeLowercaseStringOrEmpty(params.accountId)}:${params.channelId.trim()}`;
}

export function rememberReusableWebhook(record: ThreadBindingRecord) {
  const webhookId = record.webhookId?.trim();
  const webhookToken = record.webhookToken?.trim();
  if (!webhookId || !webhookToken) {
    return;
  }
  const key = toReusableWebhookKey(record);
  REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.set(key, { webhookId, webhookToken });
}

export function refreshUnboundThreadWebhookIdentity(record: ThreadBindingRecord): void {
  const sourceId = record.webhookId?.trim();
  if (!sourceId) {
    return;
  }
  // The generic source identity keeps in-flight webhook echoes suppressed for
  // a fresh window after the plugin removes its bound-thread preflight route.
  recordOutboundMessageIdentity({
    channel: "discord",
    accountId: record.accountId,
    conversationId: record.threadId,
    sourceId,
  });
}

export function setBindingRecord(record: ThreadBindingRecord) {
  const bindingKey = toBindingRecordKey(record);
  const existing = BINDINGS_BY_THREAD_ID.get(bindingKey);
  if (existing) {
    unlinkSessionBinding(existing.targetSessionKey, bindingKey);
  }
  BINDINGS_BY_THREAD_ID.set(bindingKey, record);
  THREAD_BINDINGS_STATE.revision += 1;
  linkSessionBinding(record.targetSessionKey, bindingKey);
  rememberReusableWebhook(record);
}

export function removeBindingRecord(bindingKeyRaw: string): ThreadBindingRecord | null {
  const key = bindingKeyRaw.trim();
  if (!key) {
    return null;
  }
  const existing = BINDINGS_BY_THREAD_ID.get(key);
  if (!existing) {
    return null;
  }
  BINDINGS_BY_THREAD_ID.delete(key);
  THREAD_BINDINGS_STATE.revision += 1;
  unlinkSessionBinding(existing.targetSessionKey, key);
  return existing;
}

function beginBindingsLoad() {
  THREAD_BINDINGS_STATE.loadedBindings = true;
  BINDINGS_BY_THREAD_ID.clear();
  THREAD_BINDINGS_STATE.revision += 1;
  BINDINGS_BY_SESSION_KEY.clear();
  REUSABLE_WEBHOOKS_BY_ACCOUNT_CHANNEL.clear();
  THREAD_BINDINGS_STATE.loadedPersistentBindings = false;
}

function restoreBindings(entries: PluginStateEntry<ThreadBindingRecord>[]) {
  THREAD_BINDINGS_STATE.persistenceAvailable = true;
  THREAD_BINDINGS_STATE.loadedPersistentBindings = entries.length > 0;
  for (const entry of entries) {
    const normalized = normalizePersistedBinding(entry.key, entry.value);
    if (!normalized) {
      continue;
    }
    setBindingRecord(normalized);
  }
}

export function ensureBindingsLoaded() {
  if (THREAD_BINDINGS_STATE.loadedBindings) {
    return;
  }
  beginBindingsLoad();
  let entries: PluginStateEntry<ThreadBindingRecord>[];
  try {
    entries = openThreadBindingsStore().entries();
  } catch {
    THREAD_BINDINGS_STATE.persistenceAvailable = false;
    return;
  }
  restoreBindings(entries);
}

async function loadBindingsAsync() {
  let entries: PluginStateEntry<ThreadBindingRecord>[];
  try {
    entries = await getDiscordRuntime()
      .state.openKeyedStore<ThreadBindingRecord>({
        namespace: THREAD_BINDINGS_NAMESPACE,
        maxEntries: THREAD_BINDINGS_MAX_ENTRIES,
      })
      .entries();
  } catch {
    if (!THREAD_BINDINGS_STATE.loadedBindings) {
      beginBindingsLoad();
      THREAD_BINDINGS_STATE.persistenceAvailable = false;
      logVerbose("discord thread binding persistence unavailable; keeping bindings in memory");
    }
    return;
  }
  // A synchronous compatibility caller can initialize and mutate the registry while we wait.
  if (THREAD_BINDINGS_STATE.loadedBindings) {
    return;
  }
  beginBindingsLoad();
  restoreBindings(entries);
}

export async function ensureBindingsLoadedAsync(): Promise<void> {
  if (THREAD_BINDINGS_STATE.loadedBindings) {
    return;
  }
  const loading = (THREAD_BINDINGS_STATE.loadingBindings ??= loadBindingsAsync());
  try {
    await loading;
  } finally {
    if (THREAD_BINDINGS_STATE.loadingBindings === loading) {
      delete THREAD_BINDINGS_STATE.loadingBindings;
    }
  }
}

export function resolveBindingIdsForSession(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: ThreadBindingTargetKind;
}): string[] {
  const out: string[] = [];
  for (const bindingKey of BINDINGS_BY_SESSION_KEY.get(params.targetSessionKey.trim()) ?? []) {
    const record = BINDINGS_BY_THREAD_ID.get(bindingKey);
    if (
      record &&
      (!params.accountId || record.accountId === params.accountId) &&
      (!params.targetKind || record.targetKind === params.targetKind)
    ) {
      out.push(bindingKey);
    }
  }
  return out;
}
