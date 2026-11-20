import type { Message } from "grammy/types";
import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  withRegisteredChannelIngress,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { resolveCommandAuthorizationAsync } from "openclaw/plugin-sdk/command-auth-native";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { buildTelegramMessageContextForTest } from "./bot-message-context.test-harness.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
}));

// mock-isolation: keep the plugin-state topic-name cache out of the identity handoff fixture.
vi.mock("./forum-topic-metadata.js", () => ({
  resolveTelegramForumTopicMetadata: async () => ({}),
}));

const forumChatId = -1001234567890;
const topicId = 99;
const ownerId = "42";
const forumConfig = { allowFrom: [ownerId], groupPolicy: "allowlist" as const };
const telegram = {
  dmPolicy: "open" as const,
  allowFrom: ["*"],
  groupPolicy: "allowlist" as const,
  groupAllowFrom: [ownerId],
  groups: { [String(forumChatId)]: forumConfig },
  accounts: { default: { botToken: "default-token" }, ops: { botToken: "ops-token" } },
};
const cfg: OpenClawConfig = {
  agents: { defaults: { model: "anthropic/claude-opus-4-5", workspace: "/tmp/openclaw" } },
  commands: { ownerAllowFrom: [`telegram:${ownerId}`] },
  channels: { telegram },
  messages: { groupChat: { mentionPatterns: [] } },
};
const resolveTelegramGroupConfig = (chatId: string | number) => ({
  groupConfig: chatId === forumChatId ? forumConfig : undefined,
  topicConfig: undefined,
});
beforeEach(() => setRuntimeConfigSnapshot(cfg));
afterEach(clearRuntimeConfigSnapshot);
afterEach(clearTelegramRuntimeForTest);

const forumChat = { id: forumChatId, type: "supergroup", title: "Forum", is_forum: true } as const;
const privateChat = { id: Number(ownerId), type: "private", first_name: "Pat" } as const;

// The authorization gate and the context builder each describe the conversation.
// The host binds the sender's identity only when both descriptions agree, so every
// row runs both real producers instead of a hand-written context.
it.each([
  { name: "forum topic", accountId: "default", chat: forumChat, topic: topicId, messageIds: [7] },
  {
    name: "private topic",
    accountId: "default",
    chat: privateChat,
    topic: topicId,
    messageIds: [7],
  },
  { name: "unthreaded DM", accountId: "default", chat: privateChat, messageIds: [7] },
  {
    name: "private topic, second account",
    accountId: "ops",
    chat: privateChat,
    topic: topicId,
    messageIds: [7],
  },
  {
    name: "private topic, buffered pair",
    accountId: "default",
    chat: privateChat,
    topic: topicId,
    messageIds: [7, 8],
  },
])("binds the configured owner for a $name message", ({ accountId, chat, topic, messageIds }) =>
  withRegisteredChannelIngress(
    { plugin: telegramPlugin, config: cfg, setRuntime: setTelegramRuntime },
    async (runtime) => {
      const isGroup = chat.type === "supergroup";
      const authorization = createTelegramHandlerAuthorization({
        accountId,
        ownerAgentId: "main",
        bot: {} as RegisterTelegramHandlerParams["bot"],
        cfg,
        mediaMaxBytes: 1,
        opts: { token: "test-token" },
        runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
        telegramCfg: telegram,
        logger: getChildLogger({ module: "telegram/admission-test" }),
        resolveGroupPolicy: () => ({ allowlistEnabled: true, allowed: true }),
        resolveGroupActivation: () => undefined,
        resolveGroupRequireMention: () => false,
        resolveTelegramGroupConfig,
        shouldSkipUpdate: () => false,
        processMessage: async () => ({ kind: "completed" }),
      });
      const messages = messageIds.map(
        (messageId): Message =>
          ({
            message_id: messageId,
            date: 1_700_000_000,
            chat,
            from: { id: Number(ownerId), is_bot: false, first_name: "Pat" },
            ...(topic === undefined ? {} : { message_thread_id: topic, is_topic_message: true }),
            text: "hello",
          }) as Message,
      );
      const channelIngressResolvers = [];
      for (const msg of messages) {
        const gate = await authorization.authorizeInboundMessage({
          msg,
          chatId: chat.id,
          isGroup,
          isForum: isGroup,
          senderId: ownerId,
          requireConfiguredGroup: false,
          dmAccess: "silent",
        });
        if (!gate.allowed) {
          throw new Error("expected message admission");
        }
        channelIngressResolvers.push(gate.resolveChannelIngress);
      }

      const built = await buildTelegramMessageContextForTest({
        message: messages.at(-1) as unknown as Record<string, unknown>,
        cfg,
        accountId,
        buildContext: runtime.channel.inbound.buildContext,
        options: { channelIngressResolvers },
        resolveTelegramGroupConfig,
      });
      if (!built) {
        throw new Error("expected a message context");
      }
      const context = built.ctxPayload;

      expect(context.MessageThreadId).toBe(topic);
      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
      });
      // Present only when the host bound this sender as the configured owner, which is
      // what an owner turn needs before it can manage automations of other sessions.
      const owner = await resolveCommandAuthorizationAsync({
        cfg,
        ctx: context,
        commandAuthorized: false,
      });
      expect(owner.assertOwnerCurrent).toBeTypeOf("function");
      expect(() => owner.assertOwnerCurrent?.()).not.toThrow();
    },
  ),
);
