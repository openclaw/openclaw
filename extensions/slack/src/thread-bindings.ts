import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  formatThreadBindingDurationLabel,
  registerSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  resolveThreadBindingEffectiveExpiresAt,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { writeJsonFileAtomically } from "openclaw/plugin-sdk/json-store";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";

const DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const DEFAULT_THREAD_BINDING_MAX_AGE_MS = 0;
const THREAD_BINDINGS_SWEEP_INTERVAL_MS = 60_000;
const STORE_VERSION = 1;

export type SlackBindingTargetKind = "subagent" | "acp";

export type SlackThreadBindingRecord = {
  accountId: string;
  channelId: string;
  threadTs: string;
  targetKind: SlackBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  boundAt: number;
  lastActivityAt: number;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
  metadata?: Record<string, unknown>;
};

type StoredSlackBindingState = {
  version: number;
  bindings: SlackThreadBindingRecord[];
};

export type SlackThreadBindingManager = {
  accountId: string;
  shouldPersistMutations: () => boolean;
  getIdleTimeoutMs: () => number;
  getMaxAgeMs: () => number;
  getByThread: (params: {
    channelId: string;
    threadTs: string;
  }) => SlackThreadBindingRecord | undefined;
  listBySessionKey: (targetSessionKey: string) => SlackThreadBindingRecord[];
  listBindings: () => SlackThreadBindingRecord[];
  touchThread: (params: {
    channelId: string;
    threadTs: string;
    at?: number;
  }) => SlackThreadBindingRecord | null;
  unbindThread: (params: {
    channelId: string;
    threadTs: string;
    reason?: string;
  }) => SlackThreadBindingRecord | null;
  unbindBySessionKey: (params: {
    targetSessionKey: string;
    reason?: string;
  }) => SlackThreadBindingRecord[];
  stop: () => void;
};

type SlackThreadBindingsState = {
  managersByAccountId: Map<string, SlackThreadBindingManager>;
  bindingsByAccountThread: Map<string, SlackThreadBindingRecord>;
  persistQueueByAccountId: Map<string, Promise<void>>;
};

const SLACK_THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.slackThreadBindingsState");
let threadBindingsState: SlackThreadBindingsState | undefined;

function getThreadBindingsState(): SlackThreadBindingsState {
  if (!threadBindingsState) {
    const globalStore = globalThis as Record<PropertyKey, unknown>;
    threadBindingsState = (globalStore[SLACK_THREAD_BINDINGS_STATE_KEY] as
      | SlackThreadBindingsState
      | undefined) ?? {
      managersByAccountId: new Map<string, SlackThreadBindingManager>(),
      bindingsByAccountThread: new Map<string, SlackThreadBindingRecord>(),
      persistQueueByAccountId: new Map<string, Promise<void>>(),
    };
    globalStore[SLACK_THREAD_BINDINGS_STATE_KEY] = threadBindingsState;
  }
  return threadBindingsState;
}

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return fallback;
  }
  return Math.max(0, Math.floor(raw));
}

function resolveBindingKey(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
}): string {
  return `${params.accountId}:${params.channelId}:${params.threadTs}`;
}

function toSessionBindingTargetKind(raw: SlackBindingTargetKind): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toSlackTargetKind(raw: BindingTargetKind): SlackBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: SlackThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  return {
    bindingId: resolveBindingKey({
      accountId: record.accountId,
      channelId: record.channelId,
      threadTs: record.threadTs,
    }),
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "slack",
      accountId: record.accountId,
      conversationId: record.threadTs,
      parentConversationId: record.channelId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveThreadBindingEffectiveExpiresAt({
      record,
      defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      defaultMaxAgeMs: defaults.maxAgeMs,
    }),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      channelId: record.channelId,
      threadTs: record.threadTs,
      idleTimeoutMs:
        typeof record.idleTimeoutMs === "number"
          ? Math.max(0, Math.floor(record.idleTimeoutMs))
          : defaults.idleTimeoutMs,
      maxAgeMs:
        typeof record.maxAgeMs === "number"
          ? Math.max(0, Math.floor(record.maxAgeMs))
          : defaults.maxAgeMs,
      ...record.metadata,
    },
  };
}

export function parseSlackChannelIdFromTo(to: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(to);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.toLowerCase().startsWith("channel:")) {
    return normalizeOptionalString(trimmed.slice("channel:".length));
  }
  return trimmed;
}

function resolveBindingsPath(accountId: string, env: NodeJS.ProcessEnv = process.env): string {
  const stateDir = resolveStateDir(env, os.homedir);
  return path.join(stateDir, "slack", `thread-bindings-${accountId}.json`);
}

function summarizeLifecycleForLog(
  record: SlackThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
) {
  const idleTimeoutMs =
    typeof record.idleTimeoutMs === "number" ? record.idleTimeoutMs : defaults.idleTimeoutMs;
  const maxAgeMs = typeof record.maxAgeMs === "number" ? record.maxAgeMs : defaults.maxAgeMs;
  const idleLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(idleTimeoutMs)));
  const maxAgeLabel = formatThreadBindingDurationLabel(Math.max(0, Math.floor(maxAgeMs)));
  return `idle=${idleLabel} maxAge=${maxAgeLabel}`;
}

function loadBindingsFromDisk(accountId: string): SlackThreadBindingRecord[] {
  const filePath = resolveBindingsPath(accountId);
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw) as StoredSlackBindingState;
    if (parsed?.version !== STORE_VERSION || !Array.isArray(parsed.bindings)) {
      return [];
    }
    const bindings: SlackThreadBindingRecord[] = [];
    for (const entry of parsed.bindings) {
      const channelId = normalizeOptionalString(entry?.channelId);
      const threadTs = normalizeOptionalString(entry?.threadTs);
      const targetSessionKey = normalizeOptionalString(entry?.targetSessionKey) ?? "";
      const targetKind = entry?.targetKind === "subagent" ? "subagent" : "acp";
      if (!channelId || !threadTs || !targetSessionKey) {
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
      const record: SlackThreadBindingRecord = {
        accountId,
        channelId,
        threadTs,
        targetSessionKey,
        targetKind,
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
      if (entry?.metadata && typeof entry.metadata === "object") {
        record.metadata = { ...entry.metadata };
      }
      bindings.push(record);
    }
    return bindings;
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== "ENOENT") {
      logVerbose(`slack thread bindings load failed (${accountId}): ${String(err)}`);
    }
    return [];
  }
}

async function persistBindingsToDisk(params: {
  accountId: string;
  persist: boolean;
  bindings?: SlackThreadBindingRecord[];
}): Promise<void> {
  if (!params.persist) {
    return;
  }
  const payload: StoredSlackBindingState = {
    version: STORE_VERSION,
    bindings:
      params.bindings ??
      [...getThreadBindingsState().bindingsByAccountThread.values()].filter(
        (entry) => entry.accountId === params.accountId,
      ),
  };
  await writeJsonFileAtomically(resolveBindingsPath(params.accountId), payload);
}

function listBindingsForAccount(accountId: string): SlackThreadBindingRecord[] {
  return [...getThreadBindingsState().bindingsByAccountThread.values()].filter(
    (entry) => entry.accountId === accountId,
  );
}

function enqueuePersistBindings(params: {
  accountId: string;
  persist: boolean;
  bindings?: SlackThreadBindingRecord[];
}): Promise<void> {
  if (!params.persist) {
    return Promise.resolve();
  }
  const previous =
    getThreadBindingsState().persistQueueByAccountId.get(params.accountId) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(async () => {
      await persistBindingsToDisk(params);
    });
  getThreadBindingsState().persistQueueByAccountId.set(params.accountId, next);
  void next.finally(() => {
    if (getThreadBindingsState().persistQueueByAccountId.get(params.accountId) === next) {
      getThreadBindingsState().persistQueueByAccountId.delete(params.accountId);
    }
  });
  return next;
}

function persistBindingsSafely(params: {
  accountId: string;
  persist: boolean;
  bindings?: SlackThreadBindingRecord[];
  reason: string;
}): void {
  void enqueuePersistBindings(params).catch((err) => {
    logVerbose(
      `slack thread bindings persist failed (${params.accountId}, ${params.reason}): ${String(err)}`,
    );
  });
}

function normalizeTimestampMs(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return Date.now();
  }
  return Math.max(0, Math.floor(raw));
}

function shouldExpireByIdle(params: {
  now: number;
  record: SlackThreadBindingRecord;
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
  record: SlackThreadBindingRecord;
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

function fromSessionBindingInput(params: {
  accountId: string;
  channelId: string;
  threadTs: string;
  targetSessionKey: string;
  targetKind: BindingTargetKind;
  metadata?: Record<string, unknown>;
}): SlackThreadBindingRecord {
  const now = Date.now();
  const metadata = params.metadata ?? {};
  const existing = getThreadBindingsState().bindingsByAccountThread.get(
    resolveBindingKey({
      accountId: params.accountId,
      channelId: params.channelId,
      threadTs: params.threadTs,
    }),
  );

  const record: SlackThreadBindingRecord = {
    accountId: params.accountId,
    channelId: params.channelId,
    threadTs: params.threadTs,
    targetKind: toSlackTargetKind(params.targetKind),
    targetSessionKey: params.targetSessionKey,
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
    metadata: {
      ...existing?.metadata,
      ...metadata,
    },
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

function resolveChannelAndThreadFromConversationRef(ref: {
  conversationId?: string;
  parentConversationId?: string;
}): { channelId: string; threadTs: string } | null {
  const rawConversation = normalizeOptionalString(ref.conversationId);
  const rawParent = normalizeOptionalString(ref.parentConversationId);
  if (rawParent && rawConversation && rawParent !== rawConversation) {
    return { channelId: rawParent, threadTs: rawConversation };
  }
  if (!rawConversation) {
    return null;
  }
  const colonIdx = rawConversation.indexOf(":");
  if (colonIdx > 0) {
    const channelId = rawConversation.slice(0, colonIdx).trim();
    const threadTs = rawConversation.slice(colonIdx + 1).trim();
    if (channelId && threadTs) {
      return { channelId, threadTs };
    }
  }
  return null;
}

export function createSlackThreadBindingManager(
  params: {
    accountId?: string;
    persist?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
    enableSweeper?: boolean;
  } = {},
): SlackThreadBindingManager {
  const accountId = normalizeAccountId(params.accountId);
  const existing = getThreadBindingsState().managersByAccountId.get(accountId);
  if (existing) {
    return existing;
  }

  const persist = params.persist ?? true;
  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_THREAD_BINDING_MAX_AGE_MS);

  const loaded = loadBindingsFromDisk(accountId);
  for (const entry of loaded) {
    const key = resolveBindingKey({
      accountId,
      channelId: entry.channelId,
      threadTs: entry.threadTs,
    });
    getThreadBindingsState().bindingsByAccountThread.set(key, {
      ...entry,
      accountId,
    });
  }

  let sweepTimer: NodeJS.Timeout | null = null;

  const manager: SlackThreadBindingManager = {
    accountId,
    shouldPersistMutations: () => persist,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByThread: ({ channelId, threadTs }) => {
      const cleanChannelId = normalizeOptionalString(channelId);
      const cleanThreadTs = normalizeOptionalString(threadTs);
      if (!cleanChannelId || !cleanThreadTs) {
        return undefined;
      }
      return getThreadBindingsState().bindingsByAccountThread.get(
        resolveBindingKey({
          accountId,
          channelId: cleanChannelId,
          threadTs: cleanThreadTs,
        }),
      );
    },
    listBySessionKey: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return listBindingsForAccount(accountId).filter(
        (entry) => entry.targetSessionKey === targetSessionKey,
      );
    },
    listBindings: () => listBindingsForAccount(accountId),
    touchThread: ({ channelId, threadTs, at }) => {
      const cleanChannelId = normalizeOptionalString(channelId);
      const cleanThreadTs = normalizeOptionalString(threadTs);
      if (!cleanChannelId || !cleanThreadTs) {
        return null;
      }
      const key = resolveBindingKey({
        accountId,
        channelId: cleanChannelId,
        threadTs: cleanThreadTs,
      });
      const existingRecord = getThreadBindingsState().bindingsByAccountThread.get(key);
      if (!existingRecord) {
        return null;
      }
      const nextRecord: SlackThreadBindingRecord = {
        ...existingRecord,
        lastActivityAt: normalizeTimestampMs(at ?? Date.now()),
      };
      getThreadBindingsState().bindingsByAccountThread.set(key, nextRecord);
      persistBindingsSafely({
        accountId,
        persist: manager.shouldPersistMutations(),
        bindings: listBindingsForAccount(accountId),
        reason: "touch",
      });
      return nextRecord;
    },
    unbindThread: ({ channelId, threadTs }) => {
      const cleanChannelId = normalizeOptionalString(channelId);
      const cleanThreadTs = normalizeOptionalString(threadTs);
      if (!cleanChannelId || !cleanThreadTs) {
        return null;
      }
      const key = resolveBindingKey({
        accountId,
        channelId: cleanChannelId,
        threadTs: cleanThreadTs,
      });
      const removed = getThreadBindingsState().bindingsByAccountThread.get(key) ?? null;
      if (!removed) {
        return null;
      }
      getThreadBindingsState().bindingsByAccountThread.delete(key);
      persistBindingsSafely({
        accountId,
        persist: manager.shouldPersistMutations(),
        bindings: listBindingsForAccount(accountId),
        reason: "unbind-thread",
      });
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const targetSessionKey = unbindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return [];
      }
      const removed: SlackThreadBindingRecord[] = [];
      for (const entry of listBindingsForAccount(accountId)) {
        if (entry.targetSessionKey !== targetSessionKey) {
          continue;
        }
        const key = resolveBindingKey({
          accountId,
          channelId: entry.channelId,
          threadTs: entry.threadTs,
        });
        getThreadBindingsState().bindingsByAccountThread.delete(key);
        removed.push(entry);
      }
      if (removed.length > 0) {
        persistBindingsSafely({
          accountId,
          persist: manager.shouldPersistMutations(),
          bindings: listBindingsForAccount(accountId),
          reason: "unbind-session",
        });
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterSessionBindingAdapter({
        channel: "slack",
        accountId,
        adapter: sessionBindingAdapter,
      });
      const existingManager = getThreadBindingsState().managersByAccountId.get(accountId);
      if (existingManager === manager) {
        getThreadBindingsState().managersByAccountId.delete(accountId);
      }
    },
  };

  const sessionBindingAdapter: SessionBindingAdapter = {
    channel: "slack",
    accountId,
    capabilities: {
      placements: ["current"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "slack") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const placement = input.placement === "child" ? "child" : "current";
      if (placement === "child") {
        logVerbose(
          "slack: child thread-binding placement is not supported (Slack cannot create an empty thread without posting a parent message); falling back to current-placement semantics.",
        );
        return null;
      }
      const resolved = resolveChannelAndThreadFromConversationRef(input.conversation);
      if (!resolved) {
        logVerbose(
          `slack: current-placement bind failed: could not resolve channelId+threadTs from conversationId=${input.conversation.conversationId ?? ""} parentConversationId=${input.conversation.parentConversationId ?? ""}`,
        );
        return null;
      }
      const record = fromSessionBindingInput({
        accountId,
        channelId: resolved.channelId,
        threadTs: resolved.threadTs,
        targetSessionKey,
        targetKind: input.targetKind,
        metadata: input.metadata,
      });
      getThreadBindingsState().bindingsByAccountThread.set(
        resolveBindingKey({
          accountId,
          channelId: resolved.channelId,
          threadTs: resolved.threadTs,
        }),
        record,
      );
      await enqueuePersistBindings({
        accountId,
        persist: manager.shouldPersistMutations(),
        bindings: listBindingsForAccount(accountId),
      });
      logVerbose(
        `slack: bound thread ${resolved.channelId}:${resolved.threadTs} -> ${targetSessionKey} (${summarizeLifecycleForLog(
          record,
          { idleTimeoutMs, maxAgeMs },
        )})`,
      );
      return toSessionBindingRecord(record, { idleTimeoutMs, maxAgeMs });
    },
    listBySession: (targetSessionKeyRaw) => {
      const targetSessionKey = targetSessionKeyRaw.trim();
      if (!targetSessionKey) {
        return [];
      }
      return manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
    },
    resolveByConversation: (ref) => {
      if (ref.channel !== "slack") {
        return null;
      }
      const resolved = resolveChannelAndThreadFromConversationRef(ref);
      if (!resolved) {
        return null;
      }
      const record = manager.getByThread({
        channelId: resolved.channelId,
        threadTs: resolved.threadTs,
      });
      return record ? toSessionBindingRecord(record, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const resolvedConversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId,
      });
      if (!resolvedConversationId) {
        return;
      }
      const colonIdx = resolvedConversationId.indexOf(":");
      if (colonIdx <= 0) {
        return;
      }
      const channelId = resolvedConversationId.slice(0, colonIdx).trim();
      const threadTs = resolvedConversationId.slice(colonIdx + 1).trim();
      if (!channelId || !threadTs) {
        return;
      }
      manager.touchThread({ channelId, threadTs, at });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        if (removed.length > 0) {
          await enqueuePersistBindings({
            accountId,
            persist: manager.shouldPersistMutations(),
            bindings: listBindingsForAccount(accountId),
          });
        }
        return removed.map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const resolvedConversationId = resolveThreadBindingConversationIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!resolvedConversationId) {
        return [];
      }
      const colonIdx = resolvedConversationId.indexOf(":");
      if (colonIdx <= 0) {
        return [];
      }
      const channelId = resolvedConversationId.slice(0, colonIdx).trim();
      const threadTs = resolvedConversationId.slice(colonIdx + 1).trim();
      if (!channelId || !threadTs) {
        return [];
      }
      const removed = manager.unbindThread({
        channelId,
        threadTs,
        reason: input.reason,
      });
      if (removed) {
        await enqueuePersistBindings({
          accountId,
          persist: manager.shouldPersistMutations(),
          bindings: listBindingsForAccount(accountId),
        });
      }
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  };

  registerSessionBindingAdapter(sessionBindingAdapter);

  const sweeperEnabled = params.enableSweeper !== false;
  if (sweeperEnabled) {
    sweepTimer = setInterval(() => {
      const now = Date.now();
      for (const record of listBindingsForAccount(accountId)) {
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
        manager.unbindThread({
          channelId: record.channelId,
          threadTs: record.threadTs,
          reason: idleExpired ? "idle-expired" : "max-age-expired",
        });
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  getThreadBindingsState().managersByAccountId.set(accountId, manager);
  return manager;
}

export function getSlackThreadBindingManager(accountId?: string): SlackThreadBindingManager | null {
  return getThreadBindingsState().managersByAccountId.get(normalizeAccountId(accountId)) ?? null;
}

export function listSlackThreadBindingsForAccount(accountId?: string): SlackThreadBindingRecord[] {
  return listBindingsForAccount(normalizeAccountId(accountId));
}

export function listSlackThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: SlackBindingTargetKind;
}): SlackThreadBindingRecord[] {
  const manager = getSlackThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const all = manager.listBySessionKey(params.targetSessionKey);
  if (!params.targetKind) {
    return all;
  }
  return all.filter((entry) => entry.targetKind === params.targetKind);
}

export async function autoBindSpawnedSlackSubagent(params: {
  accountId?: string;
  channel?: string;
  to?: string;
  threadId?: string | number;
  childSessionKey: string;
  agentId: string;
  label?: string;
  boundBy?: string;
}): Promise<SlackThreadBindingRecord | null> {
  const channel = normalizeOptionalString(params.channel)?.toLowerCase();
  if (channel !== "slack") {
    return null;
  }
  const manager = getSlackThreadBindingManager(params.accountId);
  if (!manager) {
    return null;
  }
  const threadTs =
    params.threadId != null && params.threadId !== "" ? String(params.threadId).trim() : undefined;
  if (!threadTs) {
    return null;
  }
  const channelId = parseSlackChannelIdFromTo(params.to);
  if (!channelId) {
    return null;
  }

  const now = Date.now();
  const record: SlackThreadBindingRecord = {
    accountId: manager.accountId,
    channelId,
    threadTs,
    targetKind: "subagent",
    targetSessionKey: params.childSessionKey,
    agentId: params.agentId.trim() || undefined,
    label: params.label?.trim() || undefined,
    boundBy: params.boundBy ?? "system",
    boundAt: now,
    lastActivityAt: now,
  };
  getThreadBindingsState().bindingsByAccountThread.set(
    resolveBindingKey({
      accountId: manager.accountId,
      channelId,
      threadTs,
    }),
    record,
  );
  persistBindingsSafely({
    accountId: manager.accountId,
    persist: manager.shouldPersistMutations(),
    bindings: listBindingsForAccount(manager.accountId),
    reason: "auto-bind-spawn",
  });
  logVerbose(
    `slack: auto-bound thread ${channelId}:${threadTs} -> ${params.childSessionKey} (${summarizeLifecycleForLog(
      record,
      {
        idleTimeoutMs: manager.getIdleTimeoutMs(),
        maxAgeMs: manager.getMaxAgeMs(),
      },
    )})`,
  );
  return record;
}

export function unbindSlackThreadBindingsBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  targetKind?: SlackBindingTargetKind;
  reason?: string;
}): SlackThreadBindingRecord[] {
  const manager = getSlackThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const removed = manager.unbindBySessionKey({
    targetSessionKey: params.targetSessionKey,
    reason: params.reason,
  });
  if (!params.targetKind) {
    return removed;
  }
  return removed.filter((entry) => entry.targetKind === params.targetKind);
}

function updateSlackBindingsBySessionKey(params: {
  manager: SlackThreadBindingManager;
  targetSessionKey: string;
  update: (entry: SlackThreadBindingRecord, now: number) => SlackThreadBindingRecord;
}): SlackThreadBindingRecord[] {
  const targetSessionKey = params.targetSessionKey.trim();
  if (!targetSessionKey) {
    return [];
  }
  const now = Date.now();
  const updated: SlackThreadBindingRecord[] = [];
  for (const entry of params.manager.listBySessionKey(targetSessionKey)) {
    const key = resolveBindingKey({
      accountId: params.manager.accountId,
      channelId: entry.channelId,
      threadTs: entry.threadTs,
    });
    const next = params.update(entry, now);
    getThreadBindingsState().bindingsByAccountThread.set(key, next);
    updated.push(next);
  }
  if (updated.length > 0) {
    persistBindingsSafely({
      accountId: params.manager.accountId,
      persist: params.manager.shouldPersistMutations(),
      bindings: listBindingsForAccount(params.manager.accountId),
      reason: "session-lifecycle-update",
    });
  }
  return updated;
}

export function setSlackThreadBindingIdleTimeoutBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  idleTimeoutMs: number;
}): SlackThreadBindingRecord[] {
  const manager = getSlackThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const idleTimeoutMs = normalizeDurationMs(params.idleTimeoutMs, 0);
  return updateSlackBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      idleTimeoutMs,
      lastActivityAt: now,
    }),
  });
}

export function setSlackThreadBindingMaxAgeBySessionKey(params: {
  targetSessionKey: string;
  accountId?: string;
  maxAgeMs: number;
}): SlackThreadBindingRecord[] {
  const manager = getSlackThreadBindingManager(params.accountId);
  if (!manager) {
    return [];
  }
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, 0);
  return updateSlackBindingsBySessionKey({
    manager,
    targetSessionKey: params.targetSessionKey,
    update: (entry, now) => ({
      ...entry,
      maxAgeMs,
      lastActivityAt: now,
    }),
  });
}

export async function resetSlackThreadBindingsForTests() {
  for (const manager of getThreadBindingsState().managersByAccountId.values()) {
    manager.stop();
  }
  const pendingPersists = [...getThreadBindingsState().persistQueueByAccountId.values()];
  if (pendingPersists.length > 0) {
    await Promise.allSettled(pendingPersists);
  }
  getThreadBindingsState().persistQueueByAccountId.clear();
  getThreadBindingsState().managersByAccountId.clear();
  getThreadBindingsState().bindingsByAccountThread.clear();
}

export const __testing = {
  resetSlackThreadBindingsForTests,
  parseSlackChannelIdFromTo,
  resolveChannelAndThreadFromConversationRef,
};
