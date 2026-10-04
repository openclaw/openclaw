import "../test-utils/prepare-compiled-subprocesses.js";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, expect, it, vi } from "vitest";
import type { ChannelPlugin } from "../channels/plugins/types.public.js";
import { resolveAndApplyOutboundThreadId } from "../infra/outbound/message-action-threading.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { createTestRegistry } from "../test-utils/channel-plugins.js";
import {
  isDeliveredMessageToolOnlySourceReplyResult,
  isDeliveredMessagingToolResult,
  resolveMessageToolSourceReplyFinal,
} from "./embedded-agent-message-tool-source-reply.js";
import {
  extractMessagingToolSend,
  extractMessagingToolSendResult,
  isDeliveredMessagingToolSendToCurrentSource,
} from "./embedded-agent-messaging-extraction.js";
import { createDirectAnnounceResponseClassifier } from "./subagents/announce/subagent-announce-direct-response.js";

const threadId = "1510164477642014740";
const target = `channel:${threadId}`;
const cfg = { channels: { discord: { token: "synthetic-discord-token" } } };
const { discordPlugin } = await loadBundledPluginFacade<{ discordPlugin: ChannelPlugin }>({
  pluginId: "discord",
  artifactBasename: "channel-plugin-api.js",
});

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("credits a real Discord thread send followed by a silent requester completion", async () => {
  setActivePluginRegistry(
    createTestRegistry([{ pluginId: "discord", plugin: discordPlugin, source: "test" }]),
  );
  vi.stubEnv("DISCORD_API_URL", "");
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === `/api/v10/channels/${threadId}` && init?.method === "GET") {
      return Response.json({ id: threadId, type: 11 });
    }
    if (url.pathname === `/api/v10/channels/${threadId}/messages` && init?.method === "POST") {
      return Response.json({ id: "1510164477642014741", channel_id: threadId });
    }
    throw new Error(`Unexpected fixture request: ${init?.method} ${url.pathname}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  const threading = expectDefined(discordPlugin.threading, "Discord threading adapter");
  const context = expectDefined(
    expectDefined(
      threading.buildToolContext,
      "Discord tool context builder",
    )({
      cfg,
      context: {
        To: target,
        NativeChannelId: threadId,
        MessageThreadId: threadId,
        ChatType: "channel",
      },
      hasRepliedRef: { value: false },
    }),
    "Discord tool context",
  );
  const args: Record<string, unknown> = {
    action: "send",
    channel: "discord",
    target,
    message: "Completed the requested work.",
  };
  const options = {
    config: cfg,
    currentChannelId: context.currentChannelId,
    currentMessagingTarget: context.currentMessagingTarget,
    currentThreadId: threadId,
    replyToMode: "off" as const,
  };
  const pending = expectDefined(
    extractMessagingToolSend("message", args, options),
    "Discord message-tool send",
  );
  const route = resolveAndApplyOutboundThreadId(
    { ...args },
    {
      cfg,
      accountId: "default",
      to: target,
      toolContext: context,
      resolveAutoThreadId: threading.resolveAutoThreadId,
    },
  );
  const sent = await expectDefined(
    discordPlugin.outbound?.sendText,
    "Discord text sender",
  )({
    cfg,
    accountId: "default",
    to: target,
    text: "Completed the requested work.",
    threadId: route,
    silent: true,
  });
  const result = { details: { ok: true, result: sent } };
  const confirmed = extractMessagingToolSendResult(pending, result);
  const delivered = isDeliveredMessagingToolResult({ toolName: "message", args, result });
  const sourceReplyDelivered =
    delivered &&
    isDeliveredMessageToolOnlySourceReplyResult({
      sourceReplyDeliveryMode: "message_tool_only",
      toolName: "message",
      args,
      result,
      deliveryConfirmed: delivered,
      allowExplicitSourceRoute: isDeliveredMessagingToolSendToCurrentSource({
        send: confirmed,
        ...options,
        currentProvider: "discord",
        currentAccountId: "default",
        sessionKey: `agent:main:discord:channel:${threadId}`,
        deliveredPayload: result.details,
      }),
    });
  const origin = { channel: "discord", to: target, accountId: "default", threadId };
  const classify = createDirectAnnounceResponseClassifier({
    params: {
      sourceTool: "subagent_settle",
      expectsCompletionMessage: true,
      requesterIsSubagent: false,
    },
    parentOnly: false,
    requesterSessionBound: true,
    deliveryTarget: origin,
    shouldDeliverAgentFinal: true,
    requiresMessageToolDelivery: true,
    isSubagentCompletion: true,
    hasSuccessfulTrustedSubagentNoOutputCompletion: false,
    hasRequiredSubagentNoOutputCompletion: false,
    subagentDirectMessageCompletionRequiresMessageTool: true,
    effectiveDirectOrigin: origin,
    requesterSessionOrigin: origin,
    textCompletionDirectDeliveryKind: "completed_result",
    tryTextCompletionDirectDelivery: async () => undefined,
  });
  await expect(
    Promise.resolve(
      classify({
        status: "ok",
        result: {
          payloads: [{ text: "NO_REPLY" }],
          didSendViaMessagingTool: delivered,
          didDeliverSourceReplyViaMessageTool: sourceReplyDelivered,
          messagingToolSentTargets: [
            {
              ...confirmed,
              ...(sourceReplyDelivered
                ? { sourceReplyFinal: resolveMessageToolSourceReplyFinal(args) }
                : {}),
            },
          ],
        },
      }),
    ),
  ).resolves.toMatchObject({ delivered: true });
  expect(sent.receipt).toMatchObject({ threadId });
  expect(sourceReplyDelivered).toBe(true);
  for (const send of [
    { ...confirmed, to: "channel:1510164477642014999" },
    { ...confirmed, accountId: "other-account" },
  ]) {
    expect(
      isDeliveredMessagingToolSendToCurrentSource({
        send,
        ...options,
        currentProvider: "discord",
        currentAccountId: "default",
        sessionKey: `agent:main:discord:channel:${threadId}`,
        deliveredPayload: result.details,
      }),
    ).toBe(false);
  }
  expect(
    isDeliveredMessagingToolSendToCurrentSource({
      send: confirmed,
      ...options,
      currentProvider: "discord",
      currentAccountId: "default",
      sessionKey: `agent:main:discord:channel:${threadId}`,
      deliveredPayload: {
        result: { ...sent, receipt: { ...sent.receipt, threadId: "1510164477642014999" } },
      },
    }),
  ).toBe(false);
  expect(
    isDeliveredMessagingToolResult({
      toolName: "message",
      args: { ...args, dryRun: true },
      result,
    }),
  ).toBe(false);
  expect(
    isDeliveredMessagingToolResult({
      toolName: "message",
      args,
      result,
      isError: true,
    }),
  ).toBe(false);
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
