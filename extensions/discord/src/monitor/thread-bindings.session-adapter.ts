import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import type { OpenClawConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  createAccountScopedBindingAdapterV2,
  projectThreadBindingRecord,
  registerSessionBindingAdapterV2,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapterV2,
  type SessionBindingRecord,
} from "openclaw/plugin-sdk/thread-bindings-session-runtime";
import {
  normalizeDiscordBindingChannelId,
  resolveChannelIdForBinding,
} from "./thread-bindings.discord-api.js";
import { snapshotThreadBindingMetadata } from "./thread-bindings.persistence.js";
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

export function createThreadBindingSessionAdapter(params: {
  accountId: string;
  manager: ThreadBindingManager;
  defaults: { idleTimeoutMs: number; maxAgeMs: number };
  resolveCurrentCfg: () => OpenClawConfig;
  resolveCurrentToken: () => string | undefined;
  assertCurrent: () => void;
}): SessionBindingAdapterV2 {
  const serializeBinding = (record: ThreadBindingRecord): SessionBindingRecord => {
    const defaults = params.defaults;
    const bindingId = resolveBindingRecordKey(record) ?? `${record.accountId}:${record.threadId}`;
    const lifecycle = resolvePreparedThreadBindingLifecycle({ record, ...defaults });
    return projectThreadBindingRecord(record, {
      conversation: {
        channel: "discord",
        conversationId: record.threadId,
        parentConversationId: record.channelId,
      },
      bindingId,
      targetKind: record.targetKind === "subagent" ? "subagent" : "session",
      lifecycle,
      metadata: (lifecycleMetadata) => ({
        ...lifecycleMetadata,
        webhookId: record.webhookId,
        webhookToken: record.webhookToken,
        ...record.metadata,
      }),
    });
  };

  return createAccountScopedBindingAdapterV2({
    assertCurrent: params.assertCurrent,
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
      const createThread = input.placement === "child";
      const metadata = snapshotThreadBindingMetadata(input) ?? {};
      const targetKind = input.targetKind === "subagent" ? "subagent" : "acp";
      const threadId = createThread ? undefined : conversationId || undefined;
      let channelId: string | undefined;

      if (createThread) {
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
      }

      const bound = await params.manager.bindTarget({
        threadId,
        channelId,
        createThread,
        threadName: normalizeOptionalString(metadata.threadName),
        targetKind,
        targetSessionKey,
        agentId: normalizeOptionalString(metadata.agentId),
        label: normalizeOptionalString(metadata.label),
        boundBy: normalizeOptionalString(metadata.boundBy),
        introText: normalizeOptionalString(metadata.introText),
        metadata,
        ...(assertCurrent ? { assertCurrent } : {}),
      });
      return bound ? serializeBinding(bound) : null;
    },
    project: serializeBinding,
    // The manager publishes its worker commits into these SQL-free owner projections.
    listBySessionKeyAsync: async (key) => params.manager.listBySessionKey(key),
    getByConversationAsync: async (ref) => params.manager.getByThreadId(ref.conversationId),
    inspectByConversationAsync: async (ref) => params.manager.getByThreadId(ref.conversationId),
    inspectByConversations: (refs) => {
      const records = refs.map((ref) => params.manager.getByThreadId(ref.conversationId));
      return {
        records,
        assertCurrent: () => {
          params.assertCurrent();
          if (
            refs.some(
              (ref, index) => params.manager.getByThreadId(ref.conversationId) !== records[index],
            )
          ) {
            throw new Error("Discord thread binding selection changed");
          }
        },
      };
    },
    listBySessionKey: params.manager.listBySessionKey,
    getByConversation: (ref) => params.manager.getByThreadId(ref.conversationId),
    touchConversation: (threadId, at) =>
      params.manager.touchThreadSync({ threadId, at, persist: true }),
    touchConversationAsync: (threadId, at) =>
      params.manager.touchThread({ threadId, at, persist: true }),
    unbindConversation: (threadId, reason) => params.manager.unbindThread({ threadId, reason }),
    unbindBySessionKey: (targetSessionKey, reason) =>
      params.manager.unbindBySessionKey({ targetSessionKey, reason }),
  });
}

/** Disabled bindings have a live empty owner; retirement still makes that owner unavailable. */
export function createNoopThreadBindingManager(accountIdRaw?: string): ThreadBindingManager {
  const accountId = normalizeAccountId(accountIdRaw);
  let stopped = false;
  const adapter: SessionBindingAdapterV2 = {
    version: 2,
    assertCurrent: () => {
      if (stopped) {
        throw new Error("Discord thread binding manager was retired");
      }
    },
    channel: "discord",
    accountId,
    capabilities: { bindSupported: false, unbindSupported: false, placements: [] },
    touchAsync: async () => {},
    listBySessionAsync: async () => [],
    resolveByConversationAsync: async () => null,
    inspectByConversationAsync: async () => null,
    inspectByConversationsAsync: async (refs) => ({
      bindings: refs.map(() => null),
      assertCurrent: () => adapter.assertCurrent(),
    }),
    listBySession: () => [],
    resolveByConversation: () => null,
  };
  registerSessionBindingAdapterV2(adapter);
  return {
    accountId,
    isStopping: () => stopped,
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
    stop: async () => {
      stopped = true;
      unregisterSessionBindingAdapter({ channel: "discord", accountId, adapter });
    },
  };
}
