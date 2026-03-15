import {
  resolveThreadBindingFarewellText,
  resolveThreadBindingThreadName,
} from "../../../../src/channels/thread-bindings-messages.js";
import { logVerbose } from "../../../../src/globals.js";
import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  type BindingTargetKind,
  type SessionBindingRecord,
} from "../../../../src/infra/outbound/session-binding-service.js";
import {
  normalizeAccountId,
  resolveAgentIdFromSessionKey,
} from "../../../../src/routing/session-key.js";
import { createSlackWebClient } from "../client.js";
import {
  BINDINGS_BY_BINDING_KEY,
  forgetSlackThreadBindingToken,
  getSlackThreadBindingToken,
  MANAGERS_BY_ACCOUNT_ID,
  PERSIST_BY_ACCOUNT_ID,
  ensureBindingsLoaded,
  rememberSlackThreadBindingToken,
  normalizeTargetKind,
  normalizeThreadBindingDurationMs,
  normalizeThreadId,
  removeBindingRecord,
  resolveBindingIdsForSession,
  resolveBindingRecordKey,
  resolveThreadBindingIdleTimeoutMs,
  resolveThreadBindingInactivityExpiresAt,
  resolveThreadBindingMaxAgeExpiresAt,
  resolveThreadBindingMaxAgeMs,
  saveBindingsToDisk,
  setBindingRecord,
  THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
  shouldDefaultPersist,
  resetSlackThreadBindingsForTests,
  resolveSlackThreadBindingsPath,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  THREAD_BINDINGS_SWEEP_INTERVAL_MS,
  type ThreadBindingManager,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

function registerManager(manager: ThreadBindingManager) {
  MANAGERS_BY_ACCOUNT_ID.set(manager.accountId, manager);
}

function unregisterManager(accountId: string, manager: ThreadBindingManager) {
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing === manager) {
    MANAGERS_BY_ACCOUNT_ID.delete(accountId);
  }
}

function resolveEffectiveBindingExpiresAt(params: {
  record: ThreadBindingRecord;
  defaultIdleTimeoutMs: number;
  defaultMaxAgeMs: number;
}): number | undefined {
  const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
    record: params.record,
    defaultIdleTimeoutMs: params.defaultIdleTimeoutMs,
  });
  const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
    record: params.record,
    defaultMaxAgeMs: params.defaultMaxAgeMs,
  });
  if (inactivityExpiresAt != null && maxAgeExpiresAt != null) {
    return Math.min(inactivityExpiresAt, maxAgeExpiresAt);
  }
  return inactivityExpiresAt ?? maxAgeExpiresAt;
}

function toSessionBindingTargetKind(raw: string): BindingTargetKind {
  return raw === "subagent" ? "subagent" : "session";
}

function toThreadBindingTargetKind(raw: BindingTargetKind): "subagent" | "acp" {
  return raw === "subagent" ? "subagent" : "acp";
}

function toSessionBindingRecord(
  record: ThreadBindingRecord,
  defaults: { idleTimeoutMs: number; maxAgeMs: number },
): SessionBindingRecord {
  const bindingId =
    resolveBindingRecordKey({
      accountId: record.accountId,
      channelId: record.channelId,
      threadId: record.threadId,
    }) ?? `${record.accountId}:${record.channelId}:${record.threadId}`;
  return {
    bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: toSessionBindingTargetKind(record.targetKind),
    conversation: {
      channel: "slack",
      accountId: record.accountId,
      conversationId: record.threadId,
      parentConversationId: record.channelId,
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
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
        record,
        defaultIdleTimeoutMs: defaults.idleTimeoutMs,
      }),
      maxAgeMs: resolveThreadBindingMaxAgeMs({
        record,
        defaultMaxAgeMs: defaults.maxAgeMs,
      }),
    },
  };
}

function resolveThreadIdFromBindingId(params: {
  accountId: string;
  bindingId?: string;
}): { channelId: string; threadId: string } | undefined {
  const bindingId = params.bindingId?.trim();
  if (!bindingId) {
    return undefined;
  }
  const prefix = `${params.accountId}:`;
  if (!bindingId.startsWith(prefix)) {
    return undefined;
  }
  const rest = bindingId.slice(prefix.length).trim();
  // Format: channelId:threadTs
  const colonIdx = rest.indexOf(":");
  if (colonIdx < 0) {
    return undefined;
  }
  const channelId = rest.slice(0, colonIdx).trim();
  const threadId = rest.slice(colonIdx + 1).trim();
  return channelId && threadId ? { channelId, threadId } : undefined;
}

async function maybeSendSlackBindingMessage(params: {
  token?: string;
  channelId: string;
  threadTs: string;
  text: string;
}) {
  const token = params.token?.trim();
  if (!token || !params.channelId || !params.threadTs || !params.text) {
    return;
  }
  try {
    const client = createSlackWebClient(token);
    await client.chat.postMessage({
      channel: params.channelId,
      text: params.text,
      thread_ts: params.threadTs,
    });
  } catch (err) {
    logVerbose(`slack thread binding message failed: ${String(err)}`);
  }
}

export function createSlackThreadBindingManager(
  params: {
    accountId?: string;
    token?: string;
    persist?: boolean;
    enableSweeper?: boolean;
    idleTimeoutMs?: number;
    maxAgeMs?: number;
  } = {},
): ThreadBindingManager {
  ensureBindingsLoaded();
  const accountId = normalizeAccountId(params.accountId);
  const existing = MANAGERS_BY_ACCOUNT_ID.get(accountId);
  if (existing) {
    rememberSlackThreadBindingToken({ accountId, token: params.token });
    return existing;
  }

  rememberSlackThreadBindingToken({ accountId, token: params.token });

  const persist = params.persist ?? shouldDefaultPersist();
  PERSIST_BY_ACCOUNT_ID.set(accountId, persist);
  const idleTimeoutMs = normalizeThreadBindingDurationMs(
    params.idleTimeoutMs,
    DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  );
  const maxAgeMs = normalizeThreadBindingDurationMs(
    params.maxAgeMs,
    DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  );
  const resolveCurrentToken = () => getSlackThreadBindingToken(accountId) ?? params.token;

  let sweepTimer: NodeJS.Timeout | null = null;

  /** Resolve binding key for a given channelId + threadId pair. */
  function resolveKey(channelId: string, threadId: string) {
    return resolveBindingRecordKey({ accountId, channelId, threadId });
  }

  /** Get binding by channelId + threadId for this account. */
  function getByChannelThread(
    channelId: string,
    threadId: string,
  ): ThreadBindingRecord | undefined {
    const key = resolveKey(channelId, threadId);
    if (!key) {
      return undefined;
    }
    const entry = BINDINGS_BY_BINDING_KEY.get(key);
    if (!entry || entry.accountId !== accountId) {
      return undefined;
    }
    return entry;
  }

  const manager: ThreadBindingManager = {
    accountId,
    getIdleTimeoutMs: () => idleTimeoutMs,
    getMaxAgeMs: () => maxAgeMs,
    getByThreadId: (threadId) => {
      const normalizedThreadId = normalizeThreadId(threadId);
      if (!normalizedThreadId) {
        return undefined;
      }
      // For Slack, threadId alone can be ambiguous across channels.
      // Return a binding only when there is a single match for this account.
      let match: ThreadBindingRecord | undefined;
      for (const entry of BINDINGS_BY_BINDING_KEY.values()) {
        if (entry.accountId !== accountId || entry.threadId !== normalizedThreadId) {
          continue;
        }
        if (!match) {
          match = entry;
          continue;
        }
        if (match.channelId !== entry.channelId) {
          logVerbose(
            `slack thread binding: ambiguous thread_ts ${normalizedThreadId} across channels; require channelId`,
          );
          return undefined;
        }
      }
      return match;
    },
    getBySessionKey: (targetSessionKey) => {
      const all = manager.listBySessionKey(targetSessionKey);
      return all[0];
    },
    listBySessionKey: (targetSessionKey) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey,
        accountId,
      });
      return ids
        .map((bindingKey) => BINDINGS_BY_BINDING_KEY.get(bindingKey))
        .filter((entry): entry is ThreadBindingRecord => Boolean(entry));
    },
    listBindings: () =>
      [...BINDINGS_BY_BINDING_KEY.values()].filter((entry) => entry.accountId === accountId),
    touchThread: (touchParams) => {
      const channelId = touchParams.channelId?.trim();
      const binding = channelId
        ? getByChannelThread(channelId, touchParams.threadId)
        : manager.getByThreadId(touchParams.threadId);
      if (!binding) {
        return null;
      }
      const key = resolveKey(binding.channelId, binding.threadId);
      if (!key) {
        return null;
      }
      const now = Date.now();
      const at =
        typeof touchParams.at === "number" && Number.isFinite(touchParams.at)
          ? Math.max(0, Math.floor(touchParams.at))
          : now;
      const nextRecord: ThreadBindingRecord = {
        ...binding,
        lastActivityAt: Math.max(binding.lastActivityAt || 0, at),
      };
      setBindingRecord(nextRecord);
      if (touchParams.persist ?? persist) {
        saveBindingsToDisk({
          minIntervalMs: THREAD_BINDING_TOUCH_PERSIST_MIN_INTERVAL_MS,
        });
      }
      return nextRecord;
    },
    bindTarget: async (bindParams) => {
      let threadId = normalizeThreadId(bindParams.threadId);
      let channelId = bindParams.channelId?.trim() || "";

      if (!threadId && bindParams.createThread) {
        if (!channelId) {
          return null;
        }
        // Create a new thread by posting a root message to the channel
        const token = resolveCurrentToken();
        if (!token) {
          return null;
        }
        const threadName = resolveThreadBindingThreadName({
          agentId: bindParams.agentId,
          label: bindParams.label,
        });
        try {
          const client = createSlackWebClient(token);
          const result = await client.chat.postMessage({
            channel: channelId,
            text: bindParams.threadName?.trim() || threadName,
          });
          threadId = result.ts ?? undefined;
        } catch (err) {
          logVerbose(`slack thread binding: failed to create thread root: ${String(err)}`);
          return null;
        }
      }

      if (!threadId) {
        return null;
      }
      if (!channelId) {
        return null;
      }

      const targetSessionKey = bindParams.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }

      const targetKind = normalizeTargetKind(bindParams.targetKind, targetSessionKey);
      const now = Date.now();
      const record: ThreadBindingRecord = {
        accountId,
        channelId,
        threadId,
        targetKind,
        targetSessionKey,
        agentId: bindParams.agentId?.trim() || resolveAgentIdFromSessionKey(targetSessionKey),
        label: bindParams.label?.trim() || undefined,
        // No webhook fields for Slack
        boundBy: bindParams.boundBy?.trim() || "system",
        boundAt: now,
        lastActivityAt: now,
        idleTimeoutMs,
        maxAgeMs,
      };

      setBindingRecord(record);
      if (persist) {
        saveBindingsToDisk();
      }

      const introText = bindParams.introText?.trim();
      if (introText) {
        void maybeSendSlackBindingMessage({
          token: resolveCurrentToken(),
          channelId,
          threadTs: threadId,
          text: introText,
        });
      }
      return record;
    },
    unbindThread: (unbindParams) => {
      const channelId = unbindParams.channelId?.trim();
      const binding = channelId
        ? getByChannelThread(channelId, unbindParams.threadId)
        : manager.getByThreadId(unbindParams.threadId);
      if (!binding) {
        return null;
      }
      const bindingKey = resolveKey(binding.channelId, binding.threadId);
      if (!bindingKey) {
        return null;
      }
      const removed = removeBindingRecord(bindingKey);
      if (!removed) {
        return null;
      }
      if (persist) {
        saveBindingsToDisk();
      }
      if (unbindParams.sendFarewell !== false) {
        const farewell = resolveThreadBindingFarewellText({
          reason: unbindParams.reason,
          farewellText: unbindParams.farewellText,
          idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
            record: removed,
            defaultIdleTimeoutMs: idleTimeoutMs,
          }),
          maxAgeMs: resolveThreadBindingMaxAgeMs({
            record: removed,
            defaultMaxAgeMs: maxAgeMs,
          }),
        });
        void maybeSendSlackBindingMessage({
          token: resolveCurrentToken(),
          channelId: removed.channelId,
          threadTs: removed.threadId,
          text: farewell,
        });
      }
      return removed;
    },
    unbindBySessionKey: (unbindParams) => {
      const ids = resolveBindingIdsForSession({
        targetSessionKey: unbindParams.targetSessionKey,
        accountId,
        targetKind: unbindParams.targetKind,
      });
      if (ids.length === 0) {
        return [];
      }
      const removed: ThreadBindingRecord[] = [];
      for (const bindingKey of ids) {
        const binding = BINDINGS_BY_BINDING_KEY.get(bindingKey);
        if (!binding) {
          continue;
        }
        const entry = manager.unbindThread({
          channelId: binding.channelId,
          threadId: binding.threadId,
          reason: unbindParams.reason,
          sendFarewell: unbindParams.sendFarewell,
          farewellText: unbindParams.farewellText,
        });
        if (entry) {
          removed.push(entry);
        }
      }
      return removed;
    },
    stop: () => {
      if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      unregisterManager(accountId, manager);
      unregisterSessionBindingAdapter({
        channel: "slack",
        accountId,
      });
      forgetSlackThreadBindingToken(accountId);
    },
  };

  if (params.enableSweeper !== false) {
    sweepTimer = setInterval(() => {
      const bindings = manager.listBindings();
      if (bindings.length === 0) {
        return;
      }
      for (const snapshotBinding of bindings) {
        // Re-read live state to avoid unbinding based on stale snapshot
        const binding = getByChannelThread(snapshotBinding.channelId, snapshotBinding.threadId);
        if (!binding) {
          continue;
        }
        const now = Date.now();
        const inactivityExpiresAt = resolveThreadBindingInactivityExpiresAt({
          record: binding,
          defaultIdleTimeoutMs: idleTimeoutMs,
        });
        const maxAgeExpiresAt = resolveThreadBindingMaxAgeExpiresAt({
          record: binding,
          defaultMaxAgeMs: maxAgeMs,
        });
        const expirationCandidates: Array<{
          reason: "idle-expired" | "max-age-expired";
          at: number;
        }> = [];
        if (inactivityExpiresAt != null && now >= inactivityExpiresAt) {
          expirationCandidates.push({ reason: "idle-expired", at: inactivityExpiresAt });
        }
        if (maxAgeExpiresAt != null && now >= maxAgeExpiresAt) {
          expirationCandidates.push({ reason: "max-age-expired", at: maxAgeExpiresAt });
        }
        if (expirationCandidates.length > 0) {
          expirationCandidates.sort((a, b) => a.at - b.at);
          const reason = expirationCandidates[0]?.reason ?? "idle-expired";
          manager.unbindThread({
            channelId: binding.channelId,
            threadId: binding.threadId,
            reason,
            sendFarewell: true,
            farewellText: resolveThreadBindingFarewellText({
              reason,
              idleTimeoutMs: resolveThreadBindingIdleTimeoutMs({
                record: binding,
                defaultIdleTimeoutMs: idleTimeoutMs,
              }),
              maxAgeMs: resolveThreadBindingMaxAgeMs({
                record: binding,
                defaultMaxAgeMs: maxAgeMs,
              }),
            }),
          });
        }
        // Unlike Discord, we don't probe Slack for thread existence
        // (no equivalent of channel.get — Slack threads don't have an archived state)
      }
    }, THREAD_BINDINGS_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  registerSessionBindingAdapter({
    channel: "slack",
    accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: async (input) => {
      if (input.conversation.channel !== "slack") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const conversationId = input.conversation.conversationId.trim();
      const placement = input.placement === "child" ? "child" : "current";
      const metadata = input.metadata ?? {};
      const label =
        typeof metadata.label === "string" ? metadata.label.trim() || undefined : undefined;
      const threadName =
        typeof metadata.threadName === "string"
          ? metadata.threadName.trim() || undefined
          : undefined;
      const introText =
        typeof metadata.introText === "string" ? metadata.introText.trim() || undefined : undefined;
      const boundBy =
        typeof metadata.boundBy === "string" ? metadata.boundBy.trim() || undefined : undefined;
      const agentId =
        typeof metadata.agentId === "string" ? metadata.agentId.trim() || undefined : undefined;
      let threadId: string | undefined;
      let channelId = input.conversation.parentConversationId?.trim() || undefined;
      let createThread = false;

      if (placement === "child") {
        createThread = true;
        // channelId = parentConversationId (for Slack, this is the channel where the command ran)
        // If no parentConversationId, use conversationId as the channel
        if (!channelId && conversationId) {
          channelId = conversationId;
        }
      } else {
        threadId = conversationId || undefined;
      }
      const bound = await manager.bindTarget({
        threadId,
        channelId,
        createThread,
        threadName,
        targetKind: toThreadBindingTargetKind(input.targetKind),
        targetSessionKey,
        agentId,
        label,
        boundBy,
        introText,
      });
      return bound
        ? toSessionBindingRecord(bound, {
            idleTimeoutMs,
            maxAgeMs,
          })
        : null;
    },
    listBySession: (targetSessionKey) =>
      manager
        .listBySessionKey(targetSessionKey)
        .map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs })),
    resolveByConversation: (ref) => {
      if (ref.channel !== "slack") {
        return null;
      }
      // For Slack, conversationId = thread_ts, parentConversationId = channelId
      const channelId = ref.parentConversationId?.trim() || "";
      const threadId = ref.conversationId.trim();
      if (!threadId) {
        return null;
      }
      const binding = channelId
        ? getByChannelThread(channelId, threadId)
        : manager.getByThreadId(threadId);
      return binding ? toSessionBindingRecord(binding, { idleTimeoutMs, maxAgeMs }) : null;
    },
    touch: (bindingId, at) => {
      const parsed = resolveThreadIdFromBindingId({ accountId, bindingId });
      if (!parsed) {
        return;
      }
      const binding = getByChannelThread(parsed.channelId, parsed.threadId);
      if (!binding) {
        return;
      }
      manager.touchThread({
        channelId: binding.channelId,
        threadId: binding.threadId,
        at,
        persist: true,
      });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        return removed.map((entry) => toSessionBindingRecord(entry, { idleTimeoutMs, maxAgeMs }));
      }
      const parsed = resolveThreadIdFromBindingId({
        accountId,
        bindingId: input.bindingId,
      });
      if (!parsed) {
        return [];
      }
      const binding = getByChannelThread(parsed.channelId, parsed.threadId);
      if (!binding) {
        return [];
      }
      const removed = manager.unbindThread({
        channelId: binding.channelId,
        threadId: binding.threadId,
        reason: input.reason,
      });
      return removed ? [toSessionBindingRecord(removed, { idleTimeoutMs, maxAgeMs })] : [];
    },
  });

  registerManager(manager);
  return manager;
}

export function createNoopSlackThreadBindingManager(accountId?: string): ThreadBindingManager {
  const normalized = normalizeAccountId(accountId);
  return {
    accountId: normalized,
    getIdleTimeoutMs: () => DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    getMaxAgeMs: () => DEFAULT_THREAD_BINDING_MAX_AGE_MS,
    getByThreadId: () => undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    touchThread: () => null,
    bindTarget: async () => null,
    unbindThread: () => null,
    unbindBySessionKey: () => [],
    stop: () => {},
  };
}

export function getSlackThreadBindingManager(accountId?: string): ThreadBindingManager | null {
  const normalized = normalizeAccountId(accountId);
  return MANAGERS_BY_ACCOUNT_ID.get(normalized) ?? null;
}

export const __testing = {
  resolveSlackThreadBindingsPath,
  resolveThreadBindingThreadName,
  resetSlackThreadBindingsForTests,
};
