import {
  registerSessionBindingAdapter,
  resolveRuntimeConversationBindingRoute,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it, vi } from "vitest";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";

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

  async function dispatch(messageId: string, cfg = createBroadcastConfig(), botMentioned = true) {
    await handleFeishuMessage({
      cfg,
      event: createBroadcastEvent({ messageId, text: "hello", botMentioned }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });
  }

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

        await dispatch("msg-broadcast-bound-route", cfg);

        expect(mockDispatchReply).toHaveBeenCalledTimes(2);
        expect(
          builtInboundContextCalls
            .map((ctx) => ({ agentId: ctx.AgentId, sessionKey: ctx.SessionKey }))
            .toSorted((left, right) => String(left.agentId).localeCompare(String(right.agentId))),
        ).toEqual([
          { agentId: "main", sessionKey: targetSessionKey },
          { agentId: "susan", sessionKey: observerSessionKey },
        ]);
        const recordCalls = vi.mocked(runtimeStub.channel.session.recordInboundSession).mock.calls;
        expect(
          recordCalls
            .map(([call]) => call.updateLastRoute?.sessionKey)
            .toSorted((left, right) => String(left).localeCompare(String(right))),
        ).toEqual([targetSessionKey, observerSessionKey].toSorted());
        for (const [call] of recordCalls) {
          expect(call.updateLastRoute).toMatchObject({
            channel: "feishu",
            to: "chat:oc-broadcast-group",
          });
        }
        expect(mockGetChatInfo).toHaveBeenCalledTimes(1);
        expect(mockCreateFeishuReplyDispatcher).toHaveBeenCalledTimes(1);
        expect(mockCreateFeishuReplyDispatcher.mock.calls[0]?.[0]).toMatchObject({
          agentId: "main",
        });
        const routeMetadataKeys = Object.getOwnPropertySymbols(route);
        expect(routeMetadataKeys).not.toHaveLength(0);
        for (const ctx of builtInboundContextCalls) {
          expect(ctx).toMatchObject({
            GroupSubject: "Broadcast Team",
            ConversationLabel: "Broadcast Team",
          });
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
    await dispatch("msg-broadcast-not-mentioned", createBroadcastConfig(), false);

    expect(mockDispatchReply).not.toHaveBeenCalled();
    expect(mockCreateFeishuReplyDispatcher).not.toHaveBeenCalled();
    expect(mockGetChatInfo).not.toHaveBeenCalled();
  });

  it("skips unknown agents not in agents.list", async () => {
    await dispatch("msg-broadcast-unknown-agent", {
      ...createBroadcastConfig(),
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
    });

    expect(mockDispatchReply).toHaveBeenCalledTimes(1);
    expect(builtInboundContextCalls[0]?.SessionKey).toBe(
      "agent:susan:feishu:group:oc-broadcast-group",
    );
  });
});
