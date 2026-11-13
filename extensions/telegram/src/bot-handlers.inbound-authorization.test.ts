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
import { prepareInternalGetReplyOptions } from "../../../src/auto-reply/reply/get-reply.types.js";
import { getRequesterProfile } from "../../../src/auto-reply/requester-profile.js";
import { linkUserChannelIdentity } from "../../../src/state/user-channel-identities.js";
import { publishCanonicalUserChannelPolicy } from "../../../src/state/user-channel-identity-operations.js";
import { setUserProfileRole } from "../../../src/state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../../../src/state/user-profiles.js";
import { withOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.js";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { telegramPlugin } from "./channel.js";
import { setTelegramRuntime } from "./runtime.js";
import { clearTelegramRuntimeForTest } from "./runtime.test-support.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
}));

const chatId = -1001234567890;
const topicId = 99;
const participantId = "42";
const groupConfig = { allowFrom: [participantId], groupPolicy: "allowlist" as const };
const telegram = {
  groupPolicy: "allowlist" as const,
  groupAllowFrom: [participantId],
  groups: { [String(chatId)]: groupConfig },
};
const cfg: OpenClawConfig = { channels: { telegram } };
beforeEach(() => setRuntimeConfigSnapshot(cfg));
afterEach(clearRuntimeConfigSnapshot);
afterEach(clearTelegramRuntimeForTest);

it("binds forum admission to the finalized parent and topic", () =>
  withRegisteredChannelIngress(
    { plugin: telegramPlugin, config: cfg, setRuntime: setTelegramRuntime },
    async (runtime) => {
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
          chat: { id: chatId, type: "supergroup", title: "Forum", is_forum: true },
          from: { id: Number(participantId), is_bot: false, first_name: "Pat" },
          message_thread_id: topicId,
          text: "hello",
        },
        chatId,
        isGroup: true,
        isForum: true,
        senderId: participantId,
        requireConfiguredGroup: false,
        dmAccess: "silent",
      });
      if (!gate.allowed) {
        throw new Error("expected forum admission");
      }
      const sessionKey = "agent:main:telegram:group:forum:topic:99";
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
        from: `telegram:group:${chatId}:topic:${topicId}`,
        sender: { id: participantId },
        conversation: {
          kind: "group",
          id: String(chatId),
          parentId: String(chatId),
          threadId: String(topicId),
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
  ));

it.each(["group", "direct"] as const)(
  "passes a verified linked nonowner %s sender's role authority into reply options",
  async (kind) => {
    await withOpenClawTestState({ scenario: "minimal" }, async () => {
      const testConfig: OpenClawConfig = {
        channels: {
          telegram: { ...telegram, dmPolicy: "open", allowFrom: [participantId] },
        },
        gateway: {
          roles: {
            default: "member",
            definitions: {
              member: { scopes: ["operator.write"], agents: "*", sessions: { others: "view" } },
            },
          },
        },
      };
      setRuntimeConfigSnapshot(testConfig);
      await publishCanonicalUserChannelPolicy(testConfig.gateway);
      const profile = ensureProfileForEmail("telegram-linked-reminder@example.test");
      setUserProfileRole(profile.id, "member");
      linkUserChannelIdentity(profile.id, {
        channelId: "telegram",
        accountId: "default",
        senderId: participantId,
      });
      await withRegisteredChannelIngress(
        { plugin: telegramPlugin, config: testConfig, setRuntime: setTelegramRuntime },
        async (runtime) => {
          const isGroup = kind === "group";
          const actualChatId = isGroup ? chatId : Number(participantId);
          const authorization = createTelegramHandlerAuthorization({
            accountId: "default",
            ownerAgentId: "main",
            bot: {} as RegisterTelegramHandlerParams["bot"],
            cfg: testConfig,
            mediaMaxBytes: 1,
            opts: { token: "test-token" },
            runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
            telegramCfg: testConfig.channels!.telegram!,
            logger: getChildLogger({ module: "telegram/linked-role-test" }),
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
                ? { id: actualChatId, type: "supergroup", title: "Forum", is_forum: true }
                : { id: actualChatId, type: "private", first_name: "Pat" },
              from: { id: Number(participantId), is_bot: false, first_name: "Pat" },
              ...(isGroup ? { message_thread_id: topicId } : {}),
              text: "remind me",
            },
            chatId: actualChatId,
            isGroup,
            isForum: isGroup,
            senderId: participantId,
            requireConfiguredGroup: false,
            dmAccess: "silent",
          });
          if (!gate.allowed) {
            throw new Error("expected linked sender admission");
          }
          const sessionKey = isGroup
            ? "agent:main:telegram:group:forum:topic:99"
            : "agent:main:telegram:direct:42";
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
            from: `telegram:${actualChatId}`,
            sender: { id: participantId },
            conversation: {
              kind: isGroup ? "group" : "direct",
              id: String(actualChatId),
              ...(isGroup ? { parentId: String(actualChatId), threadId: String(topicId) } : {}),
            },
            route: { agentId: "main", routeSessionKey: sessionKey },
            reply: {
              to: `telegram:${actualChatId}`,
              ...(isGroup ? { messageThreadId: topicId } : {}),
            },
            message: { rawBody: "remind me", inboundEventKind: "user_request" },
            channelIngress: ingress,
          });
          expect(getRequesterProfile(context)?.id).toBe(profile.id);
          const operator = prepareInternalGetReplyOptions(undefined, context)?.operatorAuthority;
          expect(operator?.profileId).toBe(profile.id);
          expect(operator?.scopes).toContain("operator.write");
          expect(operator?.scopes).not.toContain("operator.admin");
          expect(() => operator?.assertCurrent()).not.toThrow();
        },
      );
    });
  },
);
