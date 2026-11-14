import {
  consumeChannelAdmissionEvidence,
  readChannelContextAdmissionEvidence,
  withRegisteredChannelIngress,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
}));

const groupChatId = -1001234567890;
const participantId = "42";
const groupConfig = { allowFrom: [participantId], groupPolicy: "allowlist" as const };
const telegram = {
  groupPolicy: "allowlist" as const,
  groupAllowFrom: [participantId],
  groups: { [String(groupChatId)]: groupConfig },
};
const cfg: OpenClawConfig = { channels: { telegram } };
beforeEach(() => setRuntimeConfigSnapshot(cfg));
afterEach(clearRuntimeConfigSnapshot);
afterEach(clearTelegramRuntimeForTest);

it.each([
  { isGroup: true, topicId: 99 },
  { isGroup: false, topicId: 99 },
  { isGroup: false, topicId: undefined },
])("binds conversation admission (group=$isGroup, topic=$topicId)", ({ isGroup, topicId }) =>
  withRegisteredChannelIngress(
    { plugin: telegramPlugin, config: cfg, setRuntime: setTelegramRuntime },
    async (runtime) => {
      const chatId = isGroup ? groupChatId : Number(participantId);
      const authorization = createTelegramHandlerAuthorization({
        accountId: "default",
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
        resolveTelegramGroupConfig: () => ({ groupConfig, topicConfig: undefined }),
        shouldSkipUpdate: () => false,
        processMessage: async () => ({ kind: "completed" }),
      });
      const gate = await authorization.authorizeInboundMessage({
        msg: {
          message_id: 7,
          date: 1_700_000_000,
          chat: isGroup
            ? { id: chatId, type: "supergroup", title: "Forum", is_forum: true }
            : { id: chatId, type: "private", first_name: "Pat" },
          from: { id: Number(participantId), is_bot: false, first_name: "Pat" },
          message_thread_id: topicId,
          text: "hello",
        },
        chatId,
        isGroup,
        isForum: isGroup,
        senderId: participantId,
        requireConfiguredGroup: false,
        dmAccess: "silent",
      });
      if (!gate.allowed) {
        throw new Error("expected message admission");
      }
      const sessionKey = `agent:main:telegram:${isGroup ? "group" : "direct"}:${chatId}${topicId == null ? "" : `:topic:${topicId}`}`;
      const ingress = await gate.resolveChannelIngress({
        agentId: "main",
        sessionKey,
        messageId: "7",
        inboundEventKind: "user_request",
      });
      const context = runtime.channel.inbound.buildContext({
        channel: "telegram",
        accountId: "default",
        messageId: "7",
        from: isGroup ? `telegram:group:${chatId}:topic:${topicId}` : `telegram:${chatId}`,
        sender: { id: participantId },
        conversation: {
          kind: isGroup ? "group" : "direct",
          id: String(chatId),
          ...(isGroup ? { parentId: String(chatId) } : {}),
          ...(topicId != null ? { threadId: String(topicId) } : {}),
        },
        route: { agentId: "main", routeSessionKey: sessionKey },
        reply: { to: `telegram:${chatId}`, messageThreadId: topicId },
        message: { rawBody: "hello", inboundEventKind: "user_request" },
        channelIngress: ingress,
      });

      expect(
        consumeChannelAdmissionEvidence(readChannelContextAdmissionEvidence(context)),
      ).toMatchObject({
        ingressState: "present",
        invoker: { state: "present", kind: "person" },
        decisionCoverage: "enforced",
      });
    },
  ),
);
