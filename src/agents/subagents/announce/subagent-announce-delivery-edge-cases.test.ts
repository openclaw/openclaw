import { afterEach, expect, it, vi } from "vitest";
import type { ChannelMessagingAdapter } from "../../../channels/plugins/types.public.js";
import type { callGateway as runtimeCallGateway } from "../../../gateway/call.js";
import { sendMessage as runtimeSendMessage } from "../../../infra/outbound/message.js";
import { setActivePluginRegistry } from "../../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../../test-utils/channel-plugins.js";
import { taskCompletionEvents } from "../../subagent-test-fixtures.test-helpers.js";
import { testing, deliverSubagentAnnouncement } from "./subagent-announce-delivery.test-support.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";

function createGatewayMock(response: Record<string, unknown> = {}) {
  return vi.fn(async (opts: Parameters<typeof runtimeCallGateway>[0]) => {
    opts.onAccepted?.({ status: "accepted" });
    return response;
  }) as unknown as typeof runtimeCallGateway;
}

function createSendMessageMock() {
  return vi.fn(async () => ({
    channel: "slack",
    to: "channel:C123",
    via: "direct" as const,
    mediaUrl: null,
    result: { messageId: "msg-1" },
  })) as unknown as typeof runtimeSendMessage;
}

function registerDirectTargetTestChannel(
  channelId: string,
  resolveOutboundSessionRoute?: NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>,
): void {
  setActivePluginRegistry(
    createTestRegistry([
      {
        pluginId: channelId,
        source: "test",
        plugin: {
          ...createChannelTestPluginBase({
            id: channelId,
            capabilities: { chatTypes: ["direct", "channel"] },
          }),
          messaging: {
            inferTargetChatType: ({ to }: { to: string }) =>
              to.startsWith("channel:") || to.startsWith("thread:") ? "channel" : "direct",
            ...(resolveOutboundSessionRoute ? { resolveOutboundSessionRoute } : {}),
          },
        },
      },
    ]),
  );
}

async function deliverDiscordDirectMessageCompletion(params: {
  callGateway: typeof runtimeCallGateway;
  sendMessage?: typeof runtimeSendMessage;
  runtimeConfig?: Record<string, unknown>;
  internalEvents?: ReturnType<typeof taskCompletionEvents>;
}) {
  const origin = {
    channel: "discord",
    to: "dm:U123",
    accountId: "acct-1",
  } as const;
  const requesterSessionKey = "agent:main:discord:dm:U123";
  testing.setDepsForTest({
    callGateway: params.callGateway,
    getRequesterSessionActivity: () => ({
      sessionId: "requester-session-dm",
      isActive: false,
    }),
    getRuntimeConfig: () => (params.runtimeConfig ?? {}) as never,
    sendMessage: params.sendMessage ?? runtimeSendMessage,
  });

  return deliverSubagentAnnouncement({
    requesterSessionKey,
    targetRequesterSessionKey: requesterSessionKey,
    triggerMessage: "child done",
    steerMessage: "child done",
    requesterSessionOrigin: origin,
    completionDirectOrigin: origin,
    directOrigin: origin,
    requesterIsSubagent: false,
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-dm-edge-case",
    internalEvents: params.internalEvents,
    sourceRunId: "run-generated-media",
    sourceTool: "subagent_announce",
  });
}

afterEach(() => {
  setActivePluginRegistry(createTestRegistry());
  testing.setDepsForTest();
});

it("does not direct-fallback after confirmed source progress outlives final verification", async () => {
  const resolveOutboundSessionRoute = vi.fn(
    async ({ target, signal }: { target: string; signal?: AbortSignal }) => {
      if (target === "D000000001") {
        return {
          sessionKey: "agent:main:slack:user:U123",
          baseSessionKey: "agent:main:slack:user:U123",
          recipientSessionExact: true,
          peer: { kind: "direct", id: "U123" },
          chatType: "direct",
          from: "slack:U123",
          to: "user:U123",
        };
      }
      await new Promise<void>((resolve) => {
        if (!signal || signal.aborted) {
          resolve();
          return;
        }
        signal.addEventListener("abort", () => resolve(), { once: true });
      });
      return null;
    },
  );
  registerDirectTargetTestChannel(
    "slack",
    resolveOutboundSessionRoute as unknown as NonNullable<
      ChannelMessagingAdapter["resolveOutboundSessionRoute"]
    >,
  );
  const callGateway = createGatewayMock({
    result: {
      payloads: [{ text: "child done" }],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "slack",
          accountId: "acct-1",
          to: "D000000001",
          sourceReplyFinal: false,
        },
        {
          tool: "message",
          provider: "slack",
          accountId: "acct-1",
          to: "D000000002",
          sourceReplyFinal: true,
        },
      ],
    },
  });
  const sendMessage = createSendMessageMock();
  testing.setDepsForTest({
    callGateway,
    getRequesterSessionActivity: () => ({ sessionId: "requester-session", isActive: false }),
    getRuntimeConfig: () =>
      ({
        session: { dmScope: "main" },
        agents: { defaults: { subagents: { announceTimeoutMs: 25 } } },
      }) as never,
    sendMessage,
  });

  const result = await sendSubagentAnnounceDirectly({
    requesterSessionKey: "agent:main:main",
    targetRequesterSessionKey: "agent:main:main",
    triggerMessage: "child done",
    expectsCompletionMessage: true,
    bestEffortDeliver: true,
    directIdempotencyKey: "announce-progress-timeout-no-fallback",
    directOrigin: { channel: "slack", accountId: "acct-1", to: "user:U123" },
    requesterSessionOrigin: { channel: "slack", accountId: "acct-1", to: "user:U123" },
    requesterIsSubagent: false,
    sourceSessionKey: "agent:main:subagent:child",
    sourceTool: "subagent_announce",
  });

  expect(result).toMatchObject({ delivered: true, path: "direct" });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(resolveOutboundSessionRoute).toHaveBeenCalledWith(
    expect.objectContaining({ target: "D000000001" }),
  );
  const stalledLookup = resolveOutboundSessionRoute.mock.calls.find(
    ([params]) => params.target === "D000000002",
  );
  expect(stalledLookup?.[0].signal?.aborted).toBe(true);
});

it("does not fallback-resend after an exact source final when an unrelated lookup stalls", async () => {
  const resolveOutboundSessionRoute = vi.fn(
    async (
      ..._args: Parameters<NonNullable<ChannelMessagingAdapter["resolveOutboundSessionRoute"]>>
    ) => await new Promise<never>(() => {}),
  );
  registerDirectTargetTestChannel("discord", resolveOutboundSessionRoute);
  const callGateway = createGatewayMock({
    result: {
      payloads: [],
      didSendViaMessagingTool: true,
      messagingToolSentTargets: [
        {
          tool: "message",
          provider: "discord",
          accountId: "acct-1",
          to: "dm:U123",
          sourceReplyFinal: true,
        },
        {
          tool: "message",
          provider: "discord",
          accountId: "acct-1",
          to: "dm:OTHER",
          sourceReplyFinal: true,
        },
      ],
    },
  });
  const sendMessage = createSendMessageMock();
  const result = await deliverDiscordDirectMessageCompletion({
    callGateway,
    sendMessage,
    runtimeConfig: { agents: { defaults: { subagents: { announceTimeoutMs: 25 } } } },
    internalEvents: taskCompletionEvents({ childSessionId: "child-session-id" }),
  });

  expect(result).toMatchObject({ delivered: true, path: "direct" });
  expect(sendMessage).not.toHaveBeenCalled();
  expect(resolveOutboundSessionRoute).not.toHaveBeenCalled();
});
