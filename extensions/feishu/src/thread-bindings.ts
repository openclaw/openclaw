import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  BindingTargetKind,
  ClawdbotConfig,
  SessionBindingRecord,
} from "openclaw/plugin-sdk/feishu";
import {
  normalizeAccountId,
  registerSessionBindingAdapter,
  resolveStateDir,
  resolveThreadBindingIdleTimeoutMsForChannel,
  resolveThreadBindingMaxAgeMsForChannel,
  resolveThreadBindingSpawnPolicy,
  unregisterSessionBindingAdapter,
} from "openclaw/plugin-sdk/feishu";
import {
  buildFeishuThreadConversationId,
  parseFeishuConversationTarget,
} from "./conversation-id.js";

const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const STORE_VERSION = 1;

type FeishuBindingTargetKind = "subagent" | "acp";

export type FeishuThreadBindingRecord = {
  accountId: string;
  conversationId: string;
  nativeThreadId?: string;
  targetKind: FeishuBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

type StoredFeishuBindingState = {
  version: number;
  bindings: FeishuThreadBindingRecord[];
};

export type FeishuThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => FeishuThreadBindingRecord | undefined;
  getByNativeThreadId: (params: {
    chatId: string;
    nativeThreadId: string;
  }) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => FeishuThreadBindingRecord[];
  listBindings: () => FeishuThreadBindingRecord[];
  recordNativeThreadId: (params: {
    conversationId: string;
    nativeThreadId: string;
  }) => FeishuThreadBindingRecord | null;
  touchConversation: (conversationId: string, at?: number) => FeishuThreadBindingRecord | null;
  unbindConversation: (params: { conversationId: string }) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (params: { targetSessionKey: string }) => FeishuThreadBindingRecord[];
  stop: () => void;
};

const MANAGERS_BY_ACCOUNT_ID = new Map<string, FeishuThreadBindingManager>();
const BINDINGS_BY_ACCOUNT_CONVERSATION = new Map<string, FeishuThreadBindingRecord>();
const BINDINGS_BY_ACCOUNT_NATIVE_THREAD = new Map<string, string>();
const PERSIST_QUEUE_BY_ACCOUNT = new Map<string, Promise<void>>();

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function normalizeConversationId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function normalizeNativeThreadId(raw: unknown): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed || undefined;
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function resolveNativeThreadBindingKey(params: {
  accountId: string;
  chatId: string;
  nativeThreadId: string;
}): string | undefined {
  const chatId = normalizeConversationId(params.chatId);
  const nativeThreadId = normalizeNativeThreadId(params.nativeThreadId);
  if (!chatId || !nativeThreadId) {
    return undefined;
  }
  return `${params.accountId}:${chatId}:thread:${nativeThreadId}`;
}

function resolveChatIdForBindingRecord(record: FeishuThreadBindingRecord): string | undefined {
  return parseFeishuConversationTarget(record.conversationId).chatId;
}

function clearNativeThreadAliasForRecord(record: FeishuThreadBindingRecord): void {
  const chatId = resolveChatIdForBindingRecord(record);
  const nativeThreadId = normalizeNativeThreadId(record.nativeThreadId);
  if (!chatId || !nativeThreadId) {
    return;
  }
  const nativeKey = resolveNativeThreadBindingKey({
    accountId: record.accountId,
    chatId,
    nativeThreadId,
  });
  if (nativeKey) {
    BINDINGS_BY_ACCOUNT_NATIVE_THREAD.delete(nativeKey);
  }
}

function setNativeThreadAliasForRecord(record: FeishuThreadBindingRecord): void {
  const chatId = resolveChatIdForBindingRecord(record);
  const nativeThreadId = normalizeNativeThreadId(record.nativeThreadId);
  if (!chatId || !nativeThreadId) {
    return;
  }
  const nativeKey = resolveNativeThreadBindingKey({
    accountId: record.accountId,
    chatId,
    nativeThreadId,
  });
  if (nativeKey) {
    BINDINGS_BY_ACCOUNT_NATIVE_THREAD.set(nativeKey, record.conversationId);
  }
}

function upsertBindingRecord(record: FeishuThreadBindingRecord): void {
  const canonicalKey = resolveBindingKey({
    accountId: record.accountId,
    conversationId: record.conversationId,
  });
  const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(canonicalKey);
  if (existing) {
    clearNativeThreadAliasForRecord(existing);
  }
  BINDINGS_BY_ACCOUNT_CONVERSATION.set(canonicalKey, record);
  setNativeThreadAliasForRecord(record);
}

function removeBindingRecord(record: FeishuThreadBindingRecord): void {
  clearNativeThreadAliasForRecord(record);
  BINDINGS_BY_ACCOUNT_CONVERSATION.delete(
    resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
  );
}

function clearBindingsForAccount(accountId: string): void {
  for (const [key, record] of BINDINGS_BY_ACCOUNT_CONVERSATION.entries()) {
    if (record.accountId !== accountId) {
      continue;
    }
    clearNativeThreadAliasForRecord(record);
    BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
  }
}

function hasPendingPersistQueue(accountId: string): boolean {
  return PERSIST_QUEUE_BY_ACCOUNT.has(accountId);
}

function areBindingRecordsEqual(
  left: FeishuThreadBindingRecord,
  right: FeishuThreadBindingRecord,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.conversationId === right.conversationId &&
    left.nativeThreadId === right.nativeThreadId &&
    left.targetKind === right.targetKind &&
    left.targetSessionKey === right.targetSessionKey &&
    left.agentId === right.agentId &&
    left.label === right.label &&
    left.boundBy === right.boundBy &&
    left.boundAt === right.boundAt &&
    left.lastActivityAt === right.lastActivityAt &&
    left.idleTimeoutMs === right.idleTimeoutMs &&
    left.maxAgeMs === right.maxAgeMs
  );
}

function mergeBindingsFromDisk(
  accountId: string,
  options: {
    authoritative?: boolean;
    includeMissingRecords?: boolean;
  } = {},
): number {
  let merged = 0;
  const includeMissingRecords = options.includeMissingRecords ?? true;
  const loadedBindings = new Map<string, FeishuThreadBindingRecord>();
  for (const entry of loadBindingsFromDisk(accountId)) {
    const record: FeishuThreadBindingRecord = {
      ...entry,
      accountId,
    };
    loadedBindings.set(
      resolveBindingKey({
        accountId,
        conversationId: record.conversationId,
      }),
      record,
    );
  }

  if (options.authoritative) {
    for (const [key, existing] of [...BINDINGS_BY_ACCOUNT_CONVERSATION.entries()]) {
      if (existing.accountId !== accountId) {
        continue;
      }
      const loaded = loadedBindings.get(key);
      if (!loaded) {
        removeBindingRecord(existing);
        merged += 1;
        continue;
      }
      if (!areBindingRecordsEqual(existing, loaded)) {
        upsertBindingRecord(loaded);
        merged += 1;
      }
      loadedBindings.delete(key);
    }

    for (const loaded of loadedBindings.values()) {
      upsertBindingRecord(loaded);
      merged += 1;
    }
    return merged;
  }

  for (const [key, loaded] of loadedBindings.entries()) {
    const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
    if (!existing) {
      if (!includeMissingRecords) {
        continue;
      }
      upsertBindingRecord(loaded);
      merged += 1;
      continue;
    }
    if (!existing.nativeThreadId && loaded.nativeThreadId) {
      upsertBindingRecord({
        ...existing,
        nativeThreadId: loaded.nativeThreadId,
      });
      merged += 1;
    }
  }
  return merged;
}

function toSessionBindingTargetKind(raw: FeishuBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toFeishuTargetKind(raw: BindingTargetKind): FeishuBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function resolveEffectiveBindingExpiresAt(params: {
  record: FeishuThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;

  const inactivityExpiresAt =
    idleTimeoutMs > 0
      ? Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
      : undefined;
  const maxAgeExpiresAt = maxAgeMs > 0 ? params.record.boundAt + maxAgeMs : undefined;

  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function toSessionBindingRecord(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      conversationId: record.conversationId,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "feishu",
      accountId: record.accountId,
      conversationId: record.conversationId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveBindingExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      nativeThreadId: record.nativeThreadId,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
    },
  };
}

function fromSessionBindingInput(params: {
  accountId: string;
  input: {
    targetSessionKey: string;
    targetKind: BindingTargetKind;
    conversationId: string;
    metadata?: Record<string, unknown>;
  };
}): FeishuThreadBindingRecord {
  const now = Date.now();
  const metadata = params.input.metadata ?? {};
  const existing = BINDINGS_BY_ACCOUNT_CONVERSATION.get(
    resolveBindingKey({
      accountId: params.accountId,
      conversationId: params.input.conversationId,
    }),
  );

  const record: FeishuThreadBindingRecord = {
    accountId: params.accountId,
    conversationId: params.input.conversationId,
    targetKind: toFeishuTargetKind(params.input.targetKind),
    targetSessionKey: params.input.targetSessionKey,
    agentId:
      typeof metadata.agentId === "string" && metadata.agentId.trim()
        ? metadata.agentId.trim()
        : existing?.agentId,
    label:
      typeof metadata.label === "string" && metadata.label.trim()
        ? metadata.label.trim()
        : existing?.label,
    boundBy:
      typeof metadata.boundBy === "string" && metadata.boundBy.trim()
        ? metadata.boundBy.trim()
        : existing?.boundBy,
    boundAt: now,
    lastActivityAt: now,
    nativeThreadId:
      typeof metadata.nativeThreadId === "string" && metadata.nativeThreadId.trim()
        ? metadata.nativeThreadId.trim()
        : existing?.nativeThreadId,
  };

  if (typeof metadata.idleTimeoutMs === "number" && Number.isFinite(metadata.idleTimeoutMs)) {
    record.idleTimeoutMs = Math.max(0, Math.floor(metadata.idleTimeoutMs));
  } else if (typeof existing?.idleTimeoutMs === "number") {
    record.idleTimeoutMs = existing.idleTimeoutMs;
  }

  if (typeof metadata.maxAgeMs === "number" && Number.isFinite(metadata.maxAgeMs)) {
    record.maxAgeMs = Math.max(0, Math.floor(metadata.maxAgeMs));
  } else if (typeof existing?.maxAgeMs === "number") {
    record.maxAgeMs = existing.maxAgeMs;
  }

  return record;
}

function resolveBindingsPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "feishu", `thread-bindings-${accountId}.json`);
}

function loadBindingsFromDisk(accountId: string): FeishuThreadBindingRecord[] {
  const filePath = resolveBindingsPath(accountId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredFeishuBindingState;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      return [];
    }
    const bindings: FeishuThreadBindingRecord[] = [];
    for (const entry of parsed.bindings) {
      const conversationId = normalizeConversationId(entry?.conversationId);
      const targetSessionKey =
        typeof entry?.targetSessionKey === "string" ? entry.targetSessionKey.trim() : "";
      const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
      if (!conversationId || !targetSessionKey) {
        continue;
      }
      const boundAt =
        typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
          ? Math.floor(entry.boundAt)
          : Date.now();
      const lastActivityAt =
        typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
          ? Math.floor(entry.lastActivityAt)
          : boundAt;
      const record: FeishuThreadBindingRecord = {
        accountId,
        conversationId,
        targetSessionKey,
        targetKind,
        boundAt,
        lastActivityAt,
      };
      if (typeof entry?.nativeThreadId === "string" && entry.nativeThreadId.trim()) {
        record.nativeThreadId = entry.nativeThreadId.trim();
      }
      if (typeof entry?.idleTimeoutMs === "number" && Number.isFinite(entry.idleTimeoutMs)) {
        record.idleTimeoutMs = Math.max(0, Math.floor(entry.idleTimeoutMs));
      }
      if (typeof entry?.maxAgeMs === "number" && Number.isFinite(entry.maxAgeMs)) {
        record.maxAgeMs = Math.max(0, Math.floor(entry.maxAgeMs));
      }
      if (typeof entry?.agentId === "string" && entry.agentId.trim()) {
        record.agentId = entry.agentId.trim();
      }
      if (typeof entry?.label === "string" && entry.label.trim()) {
        record.label = entry.label.trim();
      }
      if (typeof entry?.boundBy === "string" && entry.boundBy.trim()) {
        record.boundBy = entry.boundBy.trim();
      }
      bindings.push(record);
    }
    return bindings;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      console.warn(`feishu thread bindings load failed (${accountId}): ${String(err)}`);
    }
    return [];
  }
}

async function persistBindingsToDisk(params: {
  accountId: string;
  persist: boolean;
}): Promise<void> {
  if (!params.persist) {
    return;
  }
  const bindings = [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter(
    (entry) => entry.accountId === params.accountId,
  );
  const payload: StoredFeishuBindingState = {
    version: STORE_VERSION,
    bindings,
  };
  const filePath = resolveBindingsPath(params.accountId);
  const dirPath = path.dirname(filePath);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.mkdir(dirPath, { recursive: true, mode: 0o700 });
  await fsPromises.writeFile(tempPath, `${JSON.stringify(payload, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  await fsPromises.rename(tempPath, filePath);
}

function queuePersistBindingsToDisk(params: {
  accountId: string;
  persist: boolean;
}): Promise<void> {
  if (!params.persist) {
    return Promise.resolve();
  }
  const previous = PERSIST_QUEUE_BY_ACCOUNT.get(params.accountId) ?? Promise.resolve();
  const queued = previous.catch(() => {}).then(() => persistBindingsToDisk(params));
  const tracked = queued
    .catch((err) => {
      console.warn(`feishu thread bindings persist failed (${params.accountId}): ${String(err)}`);
    })
    .finally(() => {
      if (PERSIST_QUEUE_BY_ACCOUNT.get(params.accountId) === tracked) {
        PERSIST_QUEUE_BY_ACCOUNT.delete(params.accountId);
      }
    });
  PERSIST_QUEUE_BY_ACCOUNT.set(params.accountId, tracked);
  return tracked;
}

function resolveConversationIdFromBindingId(params: {
  accountId: string;
  bindingId?: string;
}): string | undefined {
  const bindingId = params.bindingId?.trim();
  if (!bindingId) {
    return undefined;
  }
  const prefix = `${params.accountId}:`;
  if (!bindingId.startsWith(prefix)) {
    return undefined;
  }
  const conversationId = bindingId.slice(prefix.length).trim();
  return conversationId || undefined;
}

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

function shouldExpireByIdle(params: {
  now: number;
  record: FeishuThreadBindingRecord;
  defaultIdleTimeoutMs: number;
}): boolean {
  const idleTimeoutMs =
    typeof params.record.idleTimeoutMs === "number"
      ? Math.max(0, Math.floor(params.record.idleTimeoutMs))
      : params.defaultIdleTimeoutMs;
  if (idleTimeoutMs <= 0) {
    return false;
  }
  return (
    params.now >= Math.max(params.record.lastActivityAt, params.record.boundAt) + idleTimeoutMs
  );
}

function shouldExpireByMaxAge(params: {
  now: number;
  record: FeishuThreadBindingRecord;
  defaultMaxAgeMs: number;
}): boolean {
  const maxAgeMs =
    typeof params.record.maxAgeMs === "number"
      ? Math.max(0, Math.floor(params.record.maxAgeMs))
      : params.defaultMaxAgeMs;
  if (maxAgeMs <= 0) {
    return false;
  }
  return params.now >= params.record.boundAt + maxAgeMs;
}

export function createFeishuThreadBindingManager(
  params: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
  } = {},
): FeishuThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);
  const hasPendingWrites = hasPendingPersistQueue(accountId);

  mergeBindingsFromDisk(accountId, {
    authoritative: persist && !hasPendingWrites,
    includeMissingRecords: !hasPendingWrites,
  });

  const listBindingsForAccount = () =>
    [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter((entry) => entry.accountId === accountId);

  let sweepTimer: NodeJS.Timeout | null = null;
  const adapterOwnerToken = Symbol(`feishu-thread-bindings:${accountId}`);

  const manager: FeishuThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByConversationId: (conversationIdRaw) => {
      const conversationId = normalizeConversationId(conversationIdRaw);
      if (!conversationId) {
        return undefined;
      }
      return BINDINGS_BY_ACCOUNT_CONVERSATION.get(
        resolveBindingKey({
          accountId,
          conversationId,
        }),
      );
    },
    getByNativeThreadId: ({ chatId, nativeThreadId }) => {
      const nativeKey = resolveNativeThreadBindingKey({
        accountId,
        chatId,
        nativeThreadId,
      });
      if (!nativeKey) {
        return undefined;
      }
      const conversationId = BINDINGS_BY_ACCOUNT_NATIVE_THREAD.get(nativeKey);
      if (!conversationId) {
        return undefined;
      }
      return BINDINGS_BY_ACCOUNT_CONVERSATION.get(
        resolveBindingKey({
          accountId,
          conversationId,
        }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount().filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(),
    recordNativeThreadId: ({ conversationId, nativeThreadId }) => {
      const normalizedConversationId = normalizeConversationId(conversationId);
      const normalizedNativeThreadId = normalizeNativeThreadId(nativeThreadId);
      if (!normalizedConversationId || !normalizedNativeThreadId) {
        return null;
      }
      const key = resolveBindingKey({
        accountId,
        conversationId: normalizedConversationId,
      });
      const existingRecord = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
      if (!existingRecord) {
        return null;
      }
      if (existingRecord.nativeThreadId === normalizedNativeThreadId) {
        return existingRecord;
      }
      const nextRecord: FeishuThreadBindingRecord = {
        ...existingRecord,
        nativeThreadId: normalizedNativeThreadId,
      };
      upsertBindingRecord(nextRecord);
      void queuePersistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return nextRecord;
    },
    touchConversation: (conversationIdRaw, at) => {
      const conversationId = normalizeConversationId(conversationIdRaw);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const existingRecord = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key);
      if (!existingRecord) {
        return null;
      }
      const nextRecord: FeishuThreadBindingRecord = {
        ...existingRecord,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      upsertBindingRecord(nextRecord);
      void queuePersistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return nextRecord;
    },
    unbindConversation: ({ conversationId }) => {
      const normalizedConversationId = normalizeConversationId(conversationId);
      if (!normalizedConversationId) {
        return null;
      }
      const key = resolveBindingKey({
        accountId,
        conversationId: normalizedConversationId,
      });
      const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
      if (!removed) {
        return null;
      }
      removeBindingRecord(removed);
      void queuePersistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return removed;
    },
    unbindBySessionKey: ({ targetSessionKey }) => {
      const normalizedSessionKey = targetSessionKey.trim();
      if (!normalizedSessionKey) {
        return [];
      }
      const removed: FeishuThreadBindingRecord[] = [];
      for (const entry of listBindingsForAccount()) {
        if (entry.targetSessionKey !== normalizedSessionKey) {
          continue;
        }
        removeBindingRecord(entry);
        removed.push(entry);
      }
      if (removed.length > 0) {
        void queuePersistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterSessionBindingAdapter({
        channel: "feishu",
        accountId,
        ownerToken: adapterOwnerToken,
      });
      if (!persist) {
        // Keep persisted bindings resident across manager restarts so queued writes
        // cannot flush an empty snapshot during shutdown.
        clearBindingsForAccount(accountId);
      }
      const existingManager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
      if (existingManager === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      }
    },
  };

  registerSessionBindingAdapter(
    {
      channel: "feishu",
      accountId,
      capabilities: {
        placements: ["current"],
      },
      bind: async (input) => {
        if (input.conversation.channel !== "feishu") {
          return null;
        }
        const conversationId = normalizeConversationId(input.conversation.conversationId);
        const targetSessionKey = input.targetSessionKey.trim();
        if (!targetSessionKey) {
          return null;
        }
        if (!conversationId) {
          return null;
        }
        const record = fromSessionBindingInput({
          accountId,
          input: {
            targetSessionKey,
            targetKind: input.targetKind,
            conversationId,
            metadata: input.metadata,
          },
        });
        upsertBindingRecord(record);
        void queuePersistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
        return toSessionBindingRecord(record, {
          idleTimeoutMs,
          maxAgeMs,
        });
      },
      listBySession: (targetSessionKeyRaw) => {
        const targetSessionKey = targetSessionKeyRaw.trim();
        if (!targetSessionKey) {
          return [];
        }
        return manager.listBySessionKey(targetSessionKey).map((entry) =>
          toSessionBindingRecord(entry, {
            idleTimeoutMs,
            maxAgeMs,
          }),
        );
      },
      resolveByConversation: (ref) => {
        if (ref.channel !== "feishu") {
          return null;
        }
        const conversationId = normalizeConversationId(ref.conversationId);
        if (!conversationId) {
          return null;
        }
        const record = manager.getByConversationId(conversationId);
        return record
          ? toSessionBindingRecord(record, {
              idleTimeoutMs,
              maxAgeMs,
            })
          : null;
      },
      touch: (bindingId, at) => {
        const conversationId = resolveConversationIdFromBindingId({
          accountId,
          bindingId,
        });
        if (!conversationId) {
          return;
        }
        manager.touchConversation(conversationId, at);
      },
      unbind: async (input) => {
        if (input.targetSessionKey?.trim()) {
          const removed = manager.unbindBySessionKey({
            targetSessionKey: input.targetSessionKey,
          });
          return removed.map((entry) =>
            toSessionBindingRecord(entry, {
              idleTimeoutMs,
              maxAgeMs,
            }),
          );
        }
        const conversationId = resolveConversationIdFromBindingId({
          accountId,
          bindingId: input.bindingId,
        });
        if (!conversationId) {
          return [];
        }
        const removed = manager.unbindConversation({
          conversationId,
        });
        return removed
          ? [
              toSessionBindingRecord(removed, {
                idleTimeoutMs,
                maxAgeMs,
              }),
            ]
          : [];
      },
    },
    {
      ownerToken: adapterOwnerToken,
    },
  );

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const record of listBindingsForAccount()) {
        const idleExpired = shouldExpireByIdle({
          now,
          record,
          defaultIdleTimeoutMs: idleTimeoutMs,
        });
        const maxAgeExpired = shouldExpireByMaxAge({
          now,
          record,
          defaultMaxAgeMs: maxAgeMs,
        });
        if (!idleExpired && !maxAgeExpired) {
          continue;
        }
        manager.unbindConversation({
          conversationId: record.conversationId,
        });
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function ensureFeishuThreadBindingManagerForAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  persist?: boolean;
  enableSweeper?: boolean;
}): FeishuThreadBindingManager | null {
  const accountId = normalizeAccountId(params.accountId);
  const subagentPolicy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: "feishu",
    accountId,
    kind: "subagent",
  });
  const acpPolicy = resolveThreadBindingSpawnPolicy({
    cfg: params.cfg,
    channel: "feishu",
    accountId,
    kind: "acp",
  });
  if (!subagentPolicy.enabled && !acpPolicy.enabled) {
    stopFeishuThreadBindingManager(accountId);
    return null;
  }
  return createFeishuThreadBindingManager({
    accountId,
    persist: params.persist,
    enableSweeper: params.enableSweeper,
    idleTimeoutMs: resolveThreadBindingIdleTimeoutMsForChannel({
      cfg: params.cfg,
      channel: "feishu",
      accountId,
    }),
    maxAgeMs: resolveThreadBindingMaxAgeMsForChannel({
      cfg: params.cfg,
      channel: "feishu",
      accountId,
    }),
  });
}

export function rehydrateFeishuThreadBindingManagerForAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
  persist?: boolean;
  enableSweeper?: boolean;
}): FeishuThreadBindingManager | null {
  const manager = ensureFeishuThreadBindingManagerForAccount(params);
  if (!manager) {
    return null;
  }
  const accountId = normalizeAccountId(params.accountId);
  const hasPendingWrites = hasPendingPersistQueue(accountId);
  mergeBindingsFromDisk(accountId, {
    // When a local write is still queued, disk can lag behind the live manager.
    authoritative: manager.shouldPersistMutations() && !hasPendingWrites,
    includeMissingRecords: !hasPendingWrites,
  });
  return manager;
}

export function stopFeishuThreadBindingManager(accountId?: string): void {
  if (accountId == null) {
    for (const manager of [...MANAGERS_BY_ACCOUNT_ID.values()]) {
      manager.stop();
    }
    return;
  }
  const manager = MANAGERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId));
  manager?.stop();
}

export function getFeishuThreadBindingManager(
  accountId?: string,
): FeishuThreadBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId)) ?? null;
}

export function recordFeishuNativeThreadBinding(params: {
  accountId?: string;
  chatId: string;
  rootMessageId: string;
  nativeThreadId: string;
}): FeishuThreadBindingRecord | null {
  const accountId = normalizeAccountId(params.accountId);
  const manager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (!manager) {
    return null;
  }
  const conversationId = buildFeishuThreadConversationId({
    chatId: params.chatId,
    rootMessageId: params.rootMessageId,
  });
  if (!conversationId) {
    return null;
  }
  return manager.recordNativeThreadId({
    conversationId,
    nativeThreadId: params.nativeThreadId,
  });
}

export function resolveFeishuThreadBindingByNativeThread(params: {
  accountId?: string;
  chatId: string;
  nativeThreadId: string;
}): SessionBindingRecord | null {
  const accountId = normalizeAccountId(params.accountId);
  const manager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (!manager) {
    return null;
  }
  const record = manager.getByNativeThreadId({
    chatId: params.chatId,
    nativeThreadId: params.nativeThreadId,
  });
  if (!record) {
    return null;
  }
  return toSessionBindingRecord(record, {
    idleTimeoutMs: manager.getIdleTimeoutMs(),
    maxAgeMs: manager.getMaxAgeMs(),
  });
}

export const __testing = {
  flushPersistQueueForTests(accountId?: string) {
    if (accountId) {
      return PERSIST_QUEUE_BY_ACCOUNT.get(accountId) ?? Promise.resolve();
    }
    return Promise.allSettled([...PERSIST_QUEUE_BY_ACCOUNT.values()]).then(() => undefined);
  },
  resetFeishuThreadBindingsForTests() {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
      manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
    BINDINGS_BY_ACCOUNT_NATIVE_THREAD.clear();
    PERSIST_QUEUE_BY_ACCOUNT.clear();
  },
};
