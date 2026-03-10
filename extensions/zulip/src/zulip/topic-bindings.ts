import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveThreadBindingConversationIdFromBindingId } from "../../../../src/channels/thread-binding-id.js";
import { resolveStateDir } from "../../../../src/config/paths.js";
import { logVerbose } from "../../../../src/globals.js";
import { writeJsonAtomic } from "../../../../src/infra/json-files.js";
import {
  getSessionBindingService,
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
  type SessionBindingService,
} from "../../../../src/infra/outbound/session-binding-service.js";
import { normalizeAccountId } from "../../../../src/routing/session-key.js";

const DEFAULT_TOPIC_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_TOPIC_BINDING_MAX_AGE_MS = 0;
const TOPIC_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const STORE_VERSION = 1;

type ZulipBindingTargetKind = "subagent" | "acp";

export type ZulipTopicBindingRecord = {
  accountId: string;
  conversationId: string;
  stream: string;
  topic: string;
  targetKind: ZulipBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

type StoredZulipTopicBindingState = {
  version: number;
  bindings: ZulipTopicBindingRecord[];
};

export type ZulipTopicBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByConversationId: (conversationId: string) => ZulipTopicBindingRecord | undefined;
  getByTopic: (stream: string, topic: string) => ZulipTopicBindingRecord | undefined;
  bindTopic: (params: {
    stream: string;
    topic: string;
    targetSessionKey: string;
    targetKind?: BindingTargetKind;
    agentId?: string;
    label?: string;
    boundBy?: string;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    at?: number;
  }) => ZulipTopicBindingRecord;
  listBySessionKey: (targetSessionKey: string) => ZulipTopicBindingRecord[];
  listBindings: () => ZulipTopicBindingRecord[];
  touchConversation: (conversationId: string, at?: number) => ZulipTopicBindingRecord | null;
  unbindConversation: (params: {
    conversationId: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => ZulipTopicBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
    sendFarewell?: boolean;
  }) => ZulipTopicBindingRecord[];
  stop: () => void;
};

const MANAGERS_BY_ACCOUNT_ID = new Map<string, ZulipTopicBindingManager>();
const BINDINGS_BY_ACCOUNT_CONVERSATION = new Map<string, ZulipTopicBindingRecord>();

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

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

function resolveBindingKey(params: { accountId: string; conversationId: string }): string {
  return `${params.accountId}:${params.conversationId}`;
}

function toSessionBindingTargetKind(raw: ZulipBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toZulipTargetKind(raw: BindingTargetKind): ZulipBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

export function resolveZulipTopicConversationId(params: { stream: string; topic: string }): string {
  return `${params.stream.trim()}:topic:${params.topic.trim()}`;
}

function parseZulipTopicConversationId(
  conversationIdRaw: string | undefined | null,
): { stream: string; topic: string } | null {
  const conversationId = conversationIdRaw?.trim() ?? "";
  if (!conversationId) {
    return null;
  }
  const idx = conversationId.toLowerCase().indexOf(":topic:");
  if (idx <= 0) {
    return null;
  }
  const stream = conversationId.slice(0, idx).trim();
  const topic = conversationId.slice(idx + ":topic:".length).trim();
  if (!stream || !topic) {
    return null;
  }
  return { stream, topic };
}

export function buildZulipTopicSessionKey(params: {
  baseSessionKey: string;
  topic: string;
  boundAt: number;
}): string {
  return `${params.baseSessionKey.trim()}:topic:${params.topic.trim()}:b:${Math.max(0, Math.floor(params.boundAt))}`;
}

function resolveEffectiveBindingExpiresAt(params: {
  record: ZulipTopicBindingRecord;
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
  record: ZulipTopicBindingRecord,
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
      channel: "zulip",
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
      stream: record.stream,
      topic: record.topic,
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

function resolveBindingsPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "zulip", `topic-bindings-${accountId}.json`);
}

function loadBindingsFromDisk(accountId: string): ZulipTopicBindingRecord[] {
  const filePath = resolveBindingsPath(accountId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredZulipTopicBindingState;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      return [];
    }
    const bindings: ZulipTopicBindingRecord[] = [];
    for (const entry of parsed.bindings) {
      const conversationId = normalizeConversationId(entry?.conversationId);
      const targetSessionKey =
        typeof entry?.targetSessionKey === "string" ? entry.targetSessionKey.trim() : "";
      const parsedConversation = parseZulipTopicConversationId(conversationId);
      const boundAt =
        typeof entry?.boundAt === "number" && Number.isFinite(entry.boundAt)
          ? Math.floor(entry.boundAt)
          : Date.now();
      const lastActivityAt =
        typeof entry?.lastActivityAt === "number" && Number.isFinite(entry.lastActivityAt)
          ? Math.floor(entry.lastActivityAt)
          : boundAt;
      if (!conversationId || !targetSessionKey || !parsedConversation) {
        continue;
      }
      const record: ZulipTopicBindingRecord = {
        accountId,
        conversationId,
        stream: parsedConversation.stream,
        topic: parsedConversation.topic,
        targetSessionKey,
        targetKind: entry?.targetKind === "subagent" ? "subagent" : "acp",
        boundAt,
        lastActivityAt,
      };
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
      logVerbose(`zulip topic bindings load failed (${accountId}): ${String(err)}`);
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
  const payload: StoredZulipTopicBindingState = {
    version: STORE_VERSION,
    bindings,
  };
  await writeJsonAtomic(resolveBindingsPath(params.accountId), payload, {
    mode: 0o600,
    trailingNewline: true,
    ensureDirMode: 0o700,
  });
}

function shouldExpireByIdle(params: {
  now: number;
  record: ZulipTopicBindingRecord;
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
  record: ZulipTopicBindingRecord;
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

export function createZulipTopicBindingManager(
  params: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
  } = {},
): ZulipTopicBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_TOPIC_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_TOPIC_BINDING_MAX_AGE_MS);

  const loaded = loadBindingsFromDisk(accountId);
  for (const entry of loaded) {
    const key = resolveBindingKey({
      accountId,
      conversationId: entry.conversationId,
    });
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, {
      ...entry,
      accountId,
    });
  }

  const listBindingsForAccount = () =>
    [...BINDINGS_BY_ACCOUNT_CONVERSATION.values()].filter((entry) => entry.accountId === accountId);

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: ZulipTopicBindingManager = {
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
    getByTopic: (stream, topic) =>
      manager.getByConversationId(resolveZulipTopicConversationId({ stream, topic })),
    bindTopic: (bindParams) => {
      const conversationId = resolveZulipTopicConversationId({
        stream: bindParams.stream,
        topic: bindParams.topic,
      });
      const existingRecord = manager.getByConversationId(conversationId);
      if (existingRecord) {
        return existingRecord;
      }
      const now = normalizeTimestampMs(bindParams.at ?? Date.now());
      const record: ZulipTopicBindingRecord = {
        accountId,
        conversationId,
        stream: bindParams.stream.trim(),
        topic: bindParams.topic.trim(),
        targetKind: toZulipTargetKind(bindParams.targetKind ?? "session"),
        targetSessionKey: bindParams.targetSessionKey.trim(),
        agentId: bindParams.agentId?.trim() || undefined,
        label: bindParams.label?.trim() || undefined,
        boundBy: bindParams.boundBy?.trim() || undefined,
        boundAt: now,
        lastActivityAt: now,
      };
      if (
        typeof bindParams.idleTimeoutMs === "number" &&
        Number.isFinite(bindParams.idleTimeoutMs)
      ) {
        record.idleTimeoutMs = Math.max(0, Math.floor(bindParams.idleTimeoutMs));
      }
      if (typeof bindParams.maxAgeMs === "number" && Number.isFinite(bindParams.maxAgeMs)) {
        record.maxAgeMs = Math.max(0, Math.floor(bindParams.maxAgeMs));
      }
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(
        resolveBindingKey({ accountId, conversationId }),
        record,
      );
      void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return record;
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
      const nextRecord: ZulipTopicBindingRecord = {
        ...existingRecord,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, nextRecord);
      void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return nextRecord;
    },
    unbindConversation: (unbindParams) => {
      const conversationId = normalizeConversationId(unbindParams.conversationId);
      if (!conversationId) {
        return null;
      }
      const key = resolveBindingKey({ accountId, conversationId });
      const removed = BINDINGS_BY_ACCOUNT_CONVERSATION.get(key) ?? null;
      if (!removed) {
        return null;
      }
      BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
      void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const targetSessionKey = unbindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return [];
      }
      const removed: ZulipTopicBindingRecord[] = [];
      for (const entry of listBindingsForAccount()) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        const key = resolveBindingKey({
          accountId,
          conversationId: entry.conversationId,
        });
        BINDINGS_BY_ACCOUNT_CONVERSATION.delete(key);
        removed.push(entry);
      }
      if (removed.length > 0) {
        void persistBindingsToDisk({ accountId, persist: manager.shouldPersistMutations() });
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterSessionBindingAdapter({ channel: "zulip", accountId });
      const existingManager = MANAGERS_BY_ACCOUNT_ID.get(accountId);
      if (existingManager === manager) {
        MANAGERS_BY_ACCOUNT_ID.delete(accountId);
      }
    },
  };

  registerSessionBindingAdapter({
    channel: "zulip",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "zulip") {
        return null;
      }
      if (input.placement === "child") {
        return null;
      }
      const conversationId = normalizeConversationId(input.conversation.conversationId);
      const parsedConversation = parseZulipTopicConversationId(conversationId);
      const targetSessionKey = input.targetSessionKey.trim();
      if (!conversationId || !parsedConversation || !targetSessionKey) {
        return null;
      }
      const record = manager.bindTopic({
        stream: parsedConversation.stream,
        topic: parsedConversation.topic,
        targetSessionKey,
        targetKind: input.targetKind,
        agentId:
          typeof input.metadata?.agentId === "string" ? input.metadata.agentId.trim() : undefined,
        label: typeof input.metadata?.label === "string" ? input.metadata.label.trim() : undefined,
        boundBy:
          typeof input.metadata?.boundBy === "string" ? input.metadata.boundBy.trim() : undefined,
        idleTimeoutMs:
          typeof input.metadata?.idleTimeoutMs === "number"
            ? input.metadata.idleTimeoutMs
            : undefined,
        maxAgeMs:
          typeof input.metadata?.maxAgeMs === "number" ? input.metadata.maxAgeMs : undefined,
      });
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
      if (ref.channel !== "zulip") {
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
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
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
          reason: input.reason,
          sendFarewell: false,
        });
        return removed.map((entry) =>
          toSessionBindingRecord(entry, {
            idleTimeoutMs,
            maxAgeMs,
          }),
        );
      }
      const conversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!conversationId) {
        return [];
      }
      const removed = manager.unbindConversation({
        conversationId,
        reason: input.reason,
        sendFarewell: false,
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
  });

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
          reason: idleExpired ? "idle-expired" : "max-age-expired",
          sendFarewell: false,
        });
      }
    }, TOPIC_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT_ID.set(accountId, manager);
  return manager;
}

export function getZulipTopicBindingManager(accountId?: string): ZulipTopicBindingManager | null {
  return MANAGERS_BY_ACCOUNT_ID.get(normalizeAccountId(accountId)) ?? null;
}

function updateZulipBindingsBySessionKey(params: {
  manager: ZulipTopicBindingManager;
  targetSessionKey: string;
  update: (entry: ZulipTopicBindingRecord, now: number) => ZulipTopicBindingRecord;
}): ZulipTopicBindingRecord[] {
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const now = Date.now();
  const updated: ZulipTopicBindingRecord[] = [];
  for (const entry of params.manager.listBySessionKey(targetSessionKey)) {
    const key = resolveBindingKey({
      accountId: params.manager.accountId,
      conversationId: entry.conversationId,
    });
    const next = params.update(entry, now);
    BINDINGS_BY_ACCOUNT_CONVERSATION.set(key, next);
    updated.push(next);
  }
  if (updated.length > 0) {
    void persistBindingsToDisk({
      accountId: params.manager.accountId,
      persist: params.manager.shouldPersistMutations(),
    });
  }
  return updated;
}

export function setZulipTopicBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): ZulipTopicBindingRecord[] {
  const manager = getZulipTopicBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  return updateZulipBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      idleTimeoutMs,
      lastActivityAt: now,
    }),
  });
}

export function setZulipTopicBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): ZulipTopicBindingRecord[] {
  const manager = getZulipTopicBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  return updateZulipBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      maxAgeMs,
      lastActivityAt: now,
    }),
  });
}

export async function resolveZulipTopicSessionBinding(params: {
  accountId?: string;
  stream: string;
  topic: string;
  routeSessionKey: string;
  agentId?: string;
  boundBy?: string;
  bindingService?: SessionBindingService;
  touchAt?: number;
}): Promise<{
  binding: SessionBindingRecord;
  conversationId: string;
  sessionKey: string;
  isNewBinding: boolean;
}> {
  const accountId = normalizeAccountId(params.accountId);
  const bindingService = params.bindingService ?? getSessionBindingService();
  const conversationId = resolveZulipTopicConversationId({
    stream: params.stream,
    topic: params.topic,
  });
  const existing = bindingService.resolveByConversation({
    channel: "zulip",
    accountId,
    conversationId,
  });
  if (existing) {
    bindingService.touch(existing.bindingId, params.touchAt);
    return {
      binding: existing,
      conversationId,
      sessionKey: existing.targetSessionKey,
      isNewBinding: false,
    };
  }

  const boundAt = Date.now();
  const targetSessionKey = buildZulipTopicSessionKey({
    baseSessionKey: params.routeSessionKey,
    topic: params.topic,
    boundAt,
  });
  const binding = await bindingService.bind({
    targetSessionKey,
    targetKind: "session",
    conversation: {
      channel: "zulip",
      accountId,
      conversationId,
    },
    placement: "current",
    metadata: {
      agentId: params.agentId,
      boundBy: params.boundBy ?? "system",
    },
  });
  return {
    binding,
    conversationId,
    sessionKey: binding.targetSessionKey,
    isNewBinding: true,
  };
}

export const __testing = {
  resetZulipTopicBindingsForTests() {
    for (const manager of MANAGERS_BY_ACCOUNT_ID.values()) {
      manager.stop();
    }
    MANAGERS_BY_ACCOUNT_ID.clear();
    BINDINGS_BY_ACCOUNT_CONVERSATION.clear();
  },
};
