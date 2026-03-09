import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  normalizeAccountId,
  type BindingTargetKind,
  type ClawdbotConfig,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk";
import { sendMessageFeishu } from "./send.js";
import {
  BINDINGS_BY_KEY,
  ensureBindingsLoaded,
  parseConversationId,
  removeBindingRecord,
  resolveBindingKeysForSession,
  saveBindingsToDisk,
  setBindingRecord,
  setPersistEnabled,
  shouldDefaultPersist,
  toBindingKey,
  toConversationId,
} from "./thread-bindings.state.js";
import {
  DEFAULT_FEISHU_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_FEISHU_THREAD_BINDING_MAX_AGE_MS,
  FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  type FeishuThreadBindingRecord,
  type FeishuThreadBindingTargetKind,
} from "./thread-bindings.types.js";

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

function resolveAgentIdFromSessionKey(sessionKey: string): string {
  // agent:<agentId>:<channel>:<peerKind>:<peerId>
  const parts = sessionKey.split(":");
  return parts.length >= 2 ? parts[1] : "default";
}

function normalizeTargetKind(
  raw: unknown,
  targetSessionKey: string,
): FeishuThreadBindingTargetKind {
  if (raw === "subagent" || raw === "acp") return raw;
  return targetSessionKey.includes(":subagent:") ? "subagent" : "acp";
}

function toSessionBindingTargetKind(raw: string): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toFeishuTargetKind(raw: BindingTargetKind): FeishuThreadBindingTargetKind {
  return raw === "subagent" ? "subagent" : "acp";
}

function normalizeDurationMs(raw: unknown, fallback: number): number {
  if (typeof raw === "number" && Number.isFinite(raw) && raw >= 0) {
    return Math.floor(raw);
  }
  return fallback;
}

function resolveIdleTimeoutMs(record: FeishuThreadBindingRecord, defaultMs: number): number {
  return normalizeDurationMs(record.idleTimeoutMs, defaultMs);
}

function resolveMaxAgeMs(record: FeishuThreadBindingRecord, defaultMs: number): number {
  return normalizeDurationMs(record.maxAgeMs, defaultMs);
}

function resolveInactivityExpiresAt(
  record: FeishuThreadBindingRecord,
  defaultMs: number,
): number | undefined {
  const idle = resolveIdleTimeoutMs(record, defaultMs);
  if (idle <= 0) return undefined;
  return record.lastActivityAt + idle;
}

function resolveMaxAgeExpiresAt(
  record: FeishuThreadBindingRecord,
  defaultMs: number,
): number | undefined {
  const maxAge = resolveMaxAgeMs(record, defaultMs);
  if (maxAge <= 0) return undefined;
  return record.boundAt + maxAge;
}

function resolveEffectiveExpiresAt(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): number | undefined {
  const inactivity = resolveInactivityExpiresAt(record, defaults.idleTimeoutMs);
  const maxAge = resolveMaxAgeExpiresAt(record, defaults.maxAgeMs);
  if (inactivity != null && maxAge != null) return Math.min(inactivity, maxAge);
  return inactivity ?? maxAge;
}

function toSessionBindingRecord(
  record: FeishuThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const bindingId = toBindingKey(record.accountId, record.chatId, record.rootId);
  return {
    bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "feishu",
      accountId: record.accountId,
      conversationId: toConversationId(record.chatId, record.rootId),
      parentConversationId: record.chatId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: resolveEffectiveExpiresAt(record, defaults),
    metadata: {
      agentId: record.agentId,
      label: record.label,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: resolveIdleTimeoutMs(record, defaults.idleTimeoutMs),
      maxAgeMs: resolveMaxAgeMs(record, defaults.maxAgeMs),
    },
  };
}

function parseBindingIdParts(
  accountId: string,
  bindingId: string,
): { chatId: string; rootId: string } | null {
  const prefix = `${accountId}:`;
  if (!bindingId.startsWith(prefix)) return null;
  const rest = bindingId.slice(prefix.length);
  return parseConversationId(rest);
}

// ---------------------------------------------------------------------------
// Manager registry (prevents duplicate managers for the same account)
// Stored on globalThis so ESM and jiti loader paths share one registry.
// ---------------------------------------------------------------------------

const MANAGERS_KEY = "__openclawFeishuThreadBindingManagers";

function resolveManagersMap(): Map<string, FeishuThreadBindingManager> {
  const g = globalThis as typeof globalThis & {
    [MANAGERS_KEY]?: Map<string, FeishuThreadBindingManager>;
  };
  if (!g[MANAGERS_KEY]) {
    g[MANAGERS_KEY] = new Map();
  }
  return g[MANAGERS_KEY];
}

const MANAGERS_BY_ACCOUNT = resolveManagersMap();

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export type FeishuThreadBindingManager = {
  accountId: string;
  getByKey: (chatId: string, rootId: string) => FeishuThreadBindingRecord | undefined;
  listBySessionKey: (sessionKey: string) => FeishuThreadBindingRecord[];
  listBindings: () => FeishuThreadBindingRecord[];
  touch: (chatId: string, rootId: string, at?: number) => FeishuThreadBindingRecord | null;
  bind: (params: FeishuBindParams) => Promise<FeishuThreadBindingRecord | null>;
  unbind: (
    chatId: string,
    rootId: string,
    opts?: { reason?: string; sendFarewell?: boolean; farewellText?: string },
  ) => FeishuThreadBindingRecord | null;
  unbindBySessionKey: (
    sessionKey: string,
    opts?: { reason?: string; sendFarewell?: boolean },
  ) => FeishuThreadBindingRecord[];
  stop: () => void;
};

type FeishuBindParams = {
  chatId: string;
  targetKind: FeishuThreadBindingTargetKind;
  targetSessionKey: string;
  agentId?: string;
  label?: string;
  boundBy?: string;
  introText?: string;
};

type CreateManagerParams = {
  accountId?: string;
  cfg: ClawdbotConfig;
  persist?: boolean;
  enableSweeper?: boolean;
  idleTimeoutMs?: number;
  maxAgeMs?: number;
};

export function createFeishuThreadBindingManager(
  params: CreateManagerParams,
): FeishuThreadBindingManager {
  ensureBindingsLoaded();

  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT.get(accountId);
  if (existing) return existing;

  const { cfg } = params;
  const persist = params.persist ?? shouldDefaultPersist();
  setPersistEnabled(accountId, persist);

  const idleTimeoutMs = normalizeDurationMs(
    params.idleTimeoutMs,
    DEFAULT_FEISHU_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeDurationMs(params.maxAgeMs, DEFAULT_FEISHU_THREAD_BINDING_MAX_AGE_MS);
  const defaults = { idleTimeoutMs, maxAgeMs };

  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  // -- farewell helper --
  const sendFarewellInThread = (record: FeishuThreadBindingRecord, text: string) => {
    void sendMessageFeishu({
      cfg,
      to: `chat:${record.chatId}`,
      text,
      replyToMessageId: record.rootId,
      replyInThread: true,
      accountId,
    }).catch(() => {});
  };

  const manager: FeishuThreadBindingManager = {
    accountId,

    getByKey: (chatId, rootId) => {
      const key = toBindingKey(accountId, chatId, rootId);
      const entry = BINDINGS_BY_KEY.get(key);
      return entry?.accountId === accountId ? entry : undefined;
    },

    listBySessionKey: (sessionKey) => {
      const keys = resolveBindingKeysForSession({ targetSessionKey: sessionKey, accountId });
      return keys
        .map((k) => BINDINGS_BY_KEY.get(k))
        .filter((e): e is FeishuThreadBindingRecord => Boolean(e));
    },

    listBindings: () => [...BINDINGS_BY_KEY.values()].filter((e) => e.accountId === accountId),

    touch: (chatId, rootId, at) => {
      const key = toBindingKey(accountId, chatId, rootId);
      const existing = BINDINGS_BY_KEY.get(key);
      if (!existing || existing.accountId !== accountId) return null;
      const now = Date.now();
      const touchAt =
        typeof at === "number" && Number.isFinite(at) ? Math.max(0, Math.floor(at)) : now;
      const updated: FeishuThreadBindingRecord = {
        ...existing,
        lastActivityAt: Math.max(existing.lastActivityAt || 0, touchAt),
      };
      setBindingRecord(updated);
      if (persist) {
        saveBindingsToDisk({ minIntervalMs: FEISHU_THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS });
      }
      return updated;
    },

    bind: async (bindParams) => {
      const chatId = bindParams.chatId?.trim();
      if (!chatId) return null;
      const targetSessionKey = bindParams.targetSessionKey.trim();
      if (!targetSessionKey) return null;

      const introText = bindParams.introText?.trim();

      // Send intro message to create the thread anchor
      let rootId: string | undefined;
      try {
        const result = await sendMessageFeishu({
          cfg,
          to: `chat:${chatId}`,
          text: introText || "Thread created.",
          accountId,
        });
        rootId = result.messageId;
      } catch {
        return null;
      }
      if (!rootId || rootId === "unknown") return null;

      // Reply in-thread to activate topic thread in Feishu UI
      try {
        await sendMessageFeishu({
          cfg,
          to: `chat:${chatId}`,
          text: "Listening in this thread.",
          replyToMessageId: rootId,
          replyInThread: true,
          accountId,
        });
      } catch {
        // Thread activation is best-effort; binding still works
      }

      const now = Date.now();
      const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
      const record: FeishuThreadBindingRecord = {
        accountId,
        chatId,
        rootId,
        targetKind,
        targetSessionKey,
        agentId: bindParams.agentId?.trim() || resolveAgentIdFromSessionKey(targetSessionKey),
        label: bindParams.label?.trim() || undefined,
        boundBy: bindParams.boundBy?.trim() || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs,
        maxAgeMs,
      };
      setBindingRecord(record);
      if (persist) saveBindingsToDisk();
      return record;
    },

    unbind: (chatId, rootId, opts) => {
      const key = toBindingKey(accountId, chatId, rootId);
      const removed = removeBindingRecord(key);
      if (!removed) return null;
      if (persist) saveBindingsToDisk();
      if (opts?.sendFarewell !== false) {
        const text = opts?.farewellText || opts?.reason || "Thread binding ended.";
        sendFarewellInThread(removed, text);
      }
      return removed;
    },

    unbindBySessionKey: (sessionKey, opts) => {
      const keys = resolveBindingKeysForSession({ targetSessionKey: sessionKey, accountId });
      const removed: FeishuThreadBindingRecord[] = [];
      for (const key of keys) {
        const binding = BINDINGS_BY_KEY.get(key);
        if (!binding) continue;
        const entry = manager.unbind(binding.chatId, binding.rootId, {
          reason: opts?.reason,
          sendFarewell: opts?.sendFarewell,
        });
        if (entry) removed.push(entry);
      }
      return removed;
    },

    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      const current = MANAGERS_BY_ACCOUNT.get(accountId);
      if (current === manager) MANAGERS_BY_ACCOUNT.delete(accountId);
      unregisterSessionBindingAdapter({ channel: "feishu", accountId });
    },
  };

  // -- sweeper --
  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      const bindings = manager.listBindings();
      for (const snapshot of bindings) {
        const binding = manager.getByKey(snapshot.chatId, snapshot.rootId);
        if (!binding) continue;
        const now = Date.now();
        const inactivityAt = resolveInactivityExpiresAt(binding, idleTimeoutMs);
        const maxAgeAt = resolveMaxAgeExpiresAt(binding, maxAgeMs);
        const candidates: Array<{ reason: string; at: number }> = [];
        if (inactivityAt != null && now >= inactivityAt) {
          candidates.push({ reason: "idle-expired", at: inactivityAt });
        }
        if (maxAgeAt != null && now >= maxAgeAt) {
          candidates.push({ reason: "max-age-expired", at: maxAgeAt });
        }
        if (candidates.length > 0) {
          candidates.sort((a, b) => a.at - b.at);
          manager.unbind(binding.chatId, binding.rootId, {
            reason: candidates[0].reason,
            sendFarewell: true,
            farewellText: `Thread binding ended: ${candidates[0].reason}.`,
          });
        }
      }
    }, FEISHU_THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  MANAGERS_BY_ACCOUNT.set(accountId, manager);

  // -- register session binding adapter --
  registerSessionBindingAdapter({
    channel: "feishu",
    accountId,
    capabilities: { placements: ["current", "child"] },

    bind: async (input) => {
      if (input.conversation.channel !== "feishu") return null;
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) return null;

      const metadata = input.metadata ?? {};
      const label =
        typeof metadata.label === "string" ? metadata.label.trim() || undefined : undefined;
      const introText =
        typeof metadata.introText === "string" ? metadata.introText.trim() || undefined : undefined;
      const boundBy =
        typeof metadata.boundBy === "string" ? metadata.boundBy.trim() || undefined : undefined;
      const agentId =
        typeof metadata.agentId === "string" ? metadata.agentId.trim() || undefined : undefined;
      const placement = input.placement === "child" ? "child" : "current";

      if (placement === "child") {
        // Create a new thread in the specified chat.
        // parentConversationId is the preferred source for the chat ID.
        // If only conversationId is provided and it's a composite "chatId:rootId",
        // extract just the chatId portion.
        let chatId = input.conversation.parentConversationId?.trim();
        if (!chatId) {
          const raw = input.conversation.conversationId?.trim();
          const parsed = raw ? parseConversationId(raw) : null;
          chatId = parsed ? parsed.chatId : raw;
        }
        if (!chatId) return null;
        const bound = await manager.bind({
          chatId,
          targetKind: toFeishuTargetKind(input.targetKind),
          targetSessionKey,
          agentId,
          label,
          boundBy,
          introText,
        });
        return bound ? toSessionBindingRecord(bound, defaults) : null;
      }

      // placement === "current": bind to existing thread
      const parsed = parseConversationId(input.conversation.conversationId);
      if (!parsed) return null;
      const { chatId, rootId } = parsed;

      const now = Date.now();
      const record: FeishuThreadBindingRecord = {
        accountId,
        chatId,
        rootId,
        targetKind: toFeishuTargetKind(input.targetKind),
        targetSessionKey,
        agentId: agentId || resolveAgentIdFromSessionKey(targetSessionKey),
        label,
        boundBy: boundBy || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs,
        maxAgeMs,
      };
      setBindingRecord(record);
      if (persist) saveBindingsToDisk();
      return toSessionBindingRecord(record, defaults);
    },

    listBySession: (targetSessionKey) =>
      manager.listBySessionKey(targetSessionKey).map((e) => toSessionBindingRecord(e, defaults)),

    resolveByConversation: (ref) => {
      if (ref.channel !== "feishu") return null;
      const parsed = parseConversationId(ref.conversationId);
      if (!parsed) return null;
      const binding = manager.getByKey(parsed.chatId, parsed.rootId);
      return binding ? toSessionBindingRecord(binding, defaults) : null;
    },

    touch: (bindingId, at) => {
      const parts = parseBindingIdParts(accountId, bindingId);
      if (!parts) return;
      manager.touch(parts.chatId, parts.rootId, at);
    },

    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey(input.targetSessionKey, {
          reason: input.reason,
        });
        return removed.map((e) => toSessionBindingRecord(e, defaults));
      }
      if (input.bindingId) {
        const parts = parseBindingIdParts(accountId, input.bindingId);
        if (!parts) return [];
        const removed = manager.unbind(parts.chatId, parts.rootId, { reason: input.reason });
        return removed ? [toSessionBindingRecord(removed, defaults)] : [];
      }
      return [];
    },
  });

  return manager;
}

export function resetManagersForTests(): void {
  for (const m of MANAGERS_BY_ACCOUNT.values()) {
    m.stop();
  }
  MANAGERS_BY_ACCOUNT.clear();
}
