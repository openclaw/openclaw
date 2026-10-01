import {
  registerSessionBindingAdapter,
  unregisterSessionBindingAdapter,
  resolveThreadBindingConversationIdFromBindingId,
  type SessionBindingAdapter,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  asOptionalObjectRecord,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  normalizeDiscordBindingChannelId,
  resolveChannelIdForBinding,
} from "./thread-bindings.discord-api.js";
import { snapshotThreadBindingJson } from "./thread-bindings.persistence.js";
import {
  resolveBindingRecordKey,
  resolvePreparedThreadBindingLifecycle,
} from "./thread-bindings.state.js";
import {
  DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
  DEFAULT_THREAD_BINDING_MAX_AGE_MS,
  type ThreadBindingManager,
  type ThreadBindingRecord,
} from "./thread-bindings.types.js";

type ThreadBindingDefaults = {
  idleTimeoutMs: number;
  maxAgeMs: number;
};

function toSessionBindingRecord(
  record: ThreadBindingRecord,
  defaults: ThreadBindingDefaults,
): SessionBindingRecord {
  const bindingId =
    resolveBindingRecordKey({
      accountId: record.accountId,
      threadId: record.threadId,
    }) ?? `${record.accountId}:${record.threadId}`;
  const lifecycle = resolvePreparedThreadBindingLifecycle({ record, ...defaults });
  return {
    bindingId,
    targetSessionKey: record.targetSessionKey,
    targetKind: record.targetKind === "subagent" ? "subagent" : "session",
    conversation: {
      channel: "discord",
      accountId: record.accountId,
      conversationId: record.threadId,
      parentConversationId: record.channelId,
    },
    status: "active",
    boundAt: record.boundAt,
    expiresAt: lifecycle.expiresAt,
    metadata: {
      agentId: record.agentId,
      label: record.label,
      webhookId: record.webhookId,
      webhookToken: record.webhookToken,
      boundBy: record.boundBy,
      lastActivityAt: record.lastActivityAt,
      idleTimeoutMs: lifecycle.idleTimeoutMs,
      maxAgeMs: lifecycle.maxAgeMs,
      ...record.metadata,
    },
  };
}

export function createThreadBindingSessionAdapter(params: {
  accountId: string;
  manager: ThreadBindingManager;
  defaults: ThreadBindingDefaults;
  resolveCurrentCfg: () => OpenClawConfig;
  resolveCurrentToken: () => string | undefined;
}): SessionBindingAdapter {
  const serializeBinding = (entry: ThreadBindingRecord) =>
    toSessionBindingRecord(entry, params.defaults);

  return {
    channel: "discord",
    accountId: params.accountId,
    capabilities: {
      placements: ["current", "child"],
    },
    bind: async (input) => {
      const assertCurrent = input.assertCurrent;
      if (input.conversation.channel !== "discord") {
        return null;
      }
      const targetSessionKey = input.targetSessionKey.trim();
      if (!targetSessionKey) {
        return null;
      }
      const conversationId = normalizeOptionalString(input.conversation.conversationId) ?? "";
      const placement = input.placement === "child" ? "child" : "current";
      const metadata =
        asOptionalObjectRecord(
          snapshotThreadBindingJson(input.metadata ? { ...input.metadata } : undefined),
        ) ?? {};
      const targetKind = input.targetKind === "subagent" ? "subagent" : "acp";
      const label = normalizeOptionalString(metadata.label);
      const threadName = normalizeOptionalString(metadata.threadName);
      const introText = normalizeOptionalString(metadata.introText);
      const boundBy = normalizeOptionalString(metadata.boundBy);
      const agentId = normalizeOptionalString(metadata.agentId);
      let threadId: string | undefined;
      let channelId: string | undefined;
      let createThread = false;

      if (placement === "child") {
        createThread = true;
        channelId =
          normalizeDiscordBindingChannelId(input.conversation.parentConversationId) ?? undefined;
        if (!channelId && conversationId) {
          channelId =
            (await resolveChannelIdForBinding({
              cfg: params.resolveCurrentCfg(),
              accountId: params.accountId,
              token: params.resolveCurrentToken(),
              threadId: conversationId,
            })) ?? undefined;
        }
      } else {
        threadId = conversationId || undefined;
      }

      const bound = await params.manager.bindTarget({
        threadId,
        channelId,
        createThread,
        threadName,
        targetKind,
        targetSessionKey,
        agentId,
        label,
        boundBy,
        introText,
        metadata,
        ...(assertCurrent ? { assertCurrent } : {}),
      });
      return bound ? serializeBinding(bound) : null;
    },
    listBySession: (targetSessionKey) =>
      params.manager.listBySessionKey(targetSessionKey).map(serializeBinding),
    resolveByConversation: (ref) => {
      if (ref.channel !== "discord") {
        return null;
      }
      const binding = params.manager.getByThreadId(ref.conversationId);
      return binding ? serializeBinding(binding) : null;
    },
    touch: (bindingId, at) => {
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId: params.accountId,
        bindingId,
      });
      if (threadId) {
        params.manager.touchThreadSync({ threadId, at, persist: true });
      }
    },
    touchAsync: async (bindingId, at) => {
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId: params.accountId,
        bindingId,
      });
      if (!threadId) {
        return;
      }
      await params.manager.touchThread({ threadId, at, persist: true });
    },
    unbind: async (input) => {
      if (input.targetSessionKey?.trim()) {
        const removed = await params.manager.unbindBySessionKey({
          targetSessionKey: input.targetSessionKey,
          reason: input.reason,
        });
        return removed.map(serializeBinding);
      }
      const threadId = resolveThreadBindingConversationIdFromBindingId({
        accountId: params.accountId,
        bindingId: input.bindingId,
      });
      if (!threadId) {
        return [];
      }
      const removed = await params.manager.unbindThread({
        threadId,
        reason: input.reason,
      });
      return removed ? [serializeBinding(removed)] : [];
    },
  };
}

/** Disabled bindings have a live empty owner; retirement still makes that owner unavailable. */
export function createNoopThreadBindingManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  const adapter: SessionBindingAdapter = {
    channel: "discord",
    accountId,
    capabilities: { bindSupported: false, unbindSupported: false, placements: [] },
    listBySession: () => [],
    resolveByConversation: () => null,
  };
  registerSessionBindingAdapter(adapter);
  return {
    accountId,
    isStopping: () => false,
    getIdleTimeoutMs: () => DEFAULT_THREAD_BINDING_IDLE_TIMEOUT_MS,
    getMaxAgeMs: () => DEFAULT_THREAD_BINDING_MAX_AGE_MS,
    getByThreadId: () => undefined,
    getBySessionKey: () => undefined,
    listBySessionKey: () => [],
    listBindings: () => [],
    touchThread: async () => null,
    touchThreadSync: () => null,
    bindTarget: async () => null,
    unbindThread: async () => null,
    unbindBySessionKey: async () => [],
    notifyUnbound: () => {},
    stop: async () => unregisterSessionBindingAdapter({ channel: "discord", accountId, adapter }),
  };
}
