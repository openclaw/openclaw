import {
  registerSessionBindingAdapter,
  resolveRuntimeConversationBindingRoute,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";
import type { FeishuMessageEvent } from "./bot.js";

describe("broadcast routing", () => {
  const {
    builtInboundContextCalls,
    createBroadcastConfig,
    createBroadcastEvent,
    handleFeishuMessage,
    mockCreateFeishuReplyDispatcher,
    mockDispatchReply,
    mockGetChatInfo,
    mockResolveAgentRoute,
    runtimeStub,
  } = setupFeishuBroadcastTestHarness();

  it("dispatches to all broadcast agents when bot is mentioned", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-mentioned",
      text: "hello @bot",
      botMentioned: true,
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(2);
    const sessionKeys = builtInboundContextCalls.map((call) => call.SessionKey);
    expect(sessionKeys).toContain("agent:susan:feishu:group:oc-broadcast-group");
    expect(sessionKeys).toContain("agent:main:feishu:group:oc-broadcast-group");
    const recordCalls = (
      runtimeStub.channel.session.recordInboundSession as unknown as {
        mock: {
          calls: Array<
            [
              {
                updateLastRoute?: {
                  sessionKey?: unknown;
                  channel?: unknown;
                  to?: unknown;
                };
              },
            ]
          >;
        };
      }
    ).mock.calls;
    expect(
      recordCalls
        .map(([call]) => ({
          sessionKey: call.updateLastRoute?.["sessionKey"],
          channel: call.updateLastRoute?.["channel"],
          to: call.updateLastRoute?.["to"],
        }))
        .toSorted((left, right) => String(left.sessionKey).localeCompare(String(right.sessionKey))),
    ).toEqual([
      {
        sessionKey: "agent:main:feishu:group:oc-broadcast-group",
        channel: "feishu",
        to: "chat:oc-broadcast-group",
      },
      {
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        channel: "feishu",
        to: "chat:oc-broadcast-group",
      },
    ]);
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
    expect(
      builtInboundContextCalls
        .map((call) => ({
          sessionKey: call.SessionKey,
          groupSubject: call.GroupSubject,
          conversationLabel: call.ConversationLabel,
        }))
        .toSorted((left, right) => String(left.sessionKey).localeCompare(String(right.sessionKey))),
    ).toEqual([
      {
        sessionKey: "agent:main:feishu:group:oc-broadcast-group",
        groupSubject: "Broadcast Team",
        conversationLabel: "Broadcast Team",
      },
      {
        sessionKey: "agent:susan:feishu:group:oc-broadcast-group",
        groupSubject: "Broadcast Team",
        conversationLabel: "Broadcast Team",
      },
    ]);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    const dispatcherParams = mockCreateFeishuReplyDispatcher.mock.calls.at(0)?.[0] as
      | { agentId?: string }
      | undefined;
    expect(dispatcherParams?.agentId).toBe("main");
  });

  it.each([
    {
      targetSessionKey: "agent:main:acp:feishu-bound",
      observerSessionKey: "agent:susan:acp:feishu-bound",
    },
    { targetSessionKey: "global", observerSessionKey: "global" },
  ])(
    "keeps bound route metadata on the matching broadcast agent for $targetSessionKey",
    async ({ targetSessionKey, observerSessionKey }) => {
      const cfg = {
        ...createBroadcastConfig(),
        bindings: [{ agentId: "main", match: { channel: "feishu", accountId: "default" } }],
      };
      const conversation = {
        channel: "feishu",
        accountId: "default",
        conversationId: "oc-broadcast-group",
      };
      const adapter: SessionBindingAdapter = {
        channel: "feishu",
        accountId: "default",
        listBySession: () => [],
        resolveByConversation: () => ({
          bindingId: "feishu-broadcast-binding",
          targetSessionKey,
          targetKind: "session",
          conversation,
          status: "active",
          boundAt: 1,
          metadata: { agentId: "main" },
        }),
      };
      registerSessionBindingAdapter(adapter);
      try {
        const { route } = resolveRuntimeConversationBindingRoute({
          route: resolveAgentRoute({
            cfg,
            channel: "feishu",
            accountId: "default",
            peer: { kind: "group", id: conversation.conversationId },
          }),
          conversation,
        });
        mockResolveAgentRoute.mockReturnValue(route);

        await handleFeishuMessage({
          cfg,
          event: createBroadcastEvent({
            messageId: "msg-broadcast-bound-route",
            text: "hello @bot",
            botMentioned: true,
          }),
          botOpenId: "bot-open-id",
          runtime: createRuntimeEnv(),
        });

        expect(
          builtInboundContextCalls
            .map((ctx) => ({ agentId: ctx.AgentId, sessionKey: ctx.SessionKey }))
            .toSorted((left, right) => String(left.agentId).localeCompare(String(right.agentId))),
        ).toEqual([
          { agentId: "main", sessionKey: targetSessionKey },
          { agentId: "susan", sessionKey: observerSessionKey },
        ]);
        const routeMetadataKeys = Object.getOwnPropertySymbols(route);
        expect(routeMetadataKeys).not.toHaveLength(0);
        for (const ctx of builtInboundContextCalls) {
          for (const key of routeMetadataKeys) {
            expect(Reflect.get(ctx, key)).toBe(
              ctx.AgentId === "main" ? Reflect.get(route, key) : undefined,
            );
          }
        }
      } finally {
        unregisterSessionBindingAdapter({ channel: "feishu", accountId: "default", adapter });
      }
    },
  );

  it("skips broadcast dispatch when bot is NOT mentioned (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-not-mentioned",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      botOpenId: "ou_known_bot",
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("skips broadcast dispatch when bot identity is unknown (requireMention=true)", async () => {
    const cfg = createBroadcastConfig();
    const event = createBroadcastEvent({
      messageId: "msg-broadcast-unknown-bot-id",
      text: "hello everyone",
    });

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("preserves single-agent dispatch when no broadcast config", async () => {
    const cfg: ClawdbotConfig = {
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-no-broadcast",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
    expect(builtInboundContextCalls).toHaveLength(1);
    expect(builtInboundContextCalls[0]?.SessionKey).toBe(
      "agent:main:feishu:group:oc-broadcast-group",
    );
    expect(builtInboundContextCalls[0]?.GroupSubject).toBe("Broadcast Team");
    expect(builtInboundContextCalls[0]?.ConversationLabel).toBe("Broadcast Team");
    expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
  });

  it("skips unknown agents not in agents.list", async () => {
    const cfg: ClawdbotConfig = {
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
      agents: { list: [{ id: "main" }, { id: "susan" }] },
      channels: {
        feishu: {
          appId: "cli_test",
          appSecret: "sec_test", // pragma: allowlist secret
          groups: {
            "oc-broadcast-group": {
              requireMention: false,
            },
          },
        },
      },
    };

    const event: FeishuMessageEvent = {
      sender: { sender_id: { open_id: "ou-sender" } },
      message: {
        message_id: "msg-broadcast-unknown-agent",
        chat_id: "oc-broadcast-group",
        chat_type: "group",
        message_type: "text",
        content: JSON.stringify({ text: "hello" }),
      },
    };

    await handleFeishuMessage({
      cfg,
      event,
      runtime: createRuntimeEnv(),
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    const sessionKey =
      typeof builtInboundContextCalls[0]?.SessionKey === "string"
        ? builtInboundContextCalls[0].SessionKey
        : "";
    expect(sessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
