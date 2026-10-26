import { buildChannelInboundEventContext } from "openclaw/plugin-sdk/channel-inbound";
import {
  consumeChannelAdmissionEvidence,
  createChannelAdmissionAudit,
  createHostChannelInboundEventContextBuilder,
  createHostChannelIngressRuntime,
  readChannelContextAdmissionEvidence,
} from "openclaw/plugin-sdk/channel-ingress-test-runtime";
import { createPluginRuntimeMock } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { GatewayRequestHandlerOptions } from "openclaw/plugin-sdk/gateway-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { getChildLogger } from "openclaw/plugin-sdk/runtime-env";
import { expect, it, vi } from "vitest";
import { createTelegramHandlerAuthorization } from "./bot-handlers.inbound-authorization.js";
import type { RegisterTelegramHandlerParams } from "./bot-handlers.types.js";
import { setTelegramRuntime } from "./runtime.js";

vi.mock("openclaw/plugin-sdk/conversation-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/conversation-runtime")>()),
  readChannelAllowFromStore: async () => [],
}));

it("binds a Telegram forum admission to the finalized parent and topic scope", async () => {
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
  setRuntimeConfigSnapshot(cfg);
  const audit = createChannelAdmissionAudit({ enabled: true });
  const gatewayContext = {
    channelAdmissionAudit: audit,
    getRuntimeConfig: () => cfg,
  } as GatewayRequestHandlerOptions["context"];
  let live = true;
  const owner = {
    channelId: "telegram",
    record: {},
    epoch: {},
    isLive: () => live,
    resolveGatewayContext: () => gatewayContext,
  };
  const runtime = createPluginRuntimeMock();
  runtime.channel.inbound.ingress = createHostChannelIngressRuntime(owner);
  setTelegramRuntime(runtime);
  try {
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
    const buildContext = createHostChannelInboundEventContextBuilder(
      buildChannelInboundEventContext,
      owner,
    );
    const context = buildContext({
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
  } finally {
    live = false;
    audit.close();
    clearRuntimeConfigSnapshot();
  }
});
