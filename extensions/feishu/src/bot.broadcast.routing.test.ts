import {
  registerSessionBindingAdapter,
  resolveRuntimeConversationBindingRoute,
  unregisterSessionBindingAdapter,
  type SessionBindingAdapter,
} from "openclaw/plugin-sdk/conversation-runtime";
import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { describe, expect, it } from "vitest";
import { createRuntimeEnv, setupFeishuBroadcastTestHarness } from "./bot.broadcast.test-support.js";

const channelAccount = { channel: "feishu", accountId: "default" };
const groupLabels = { GroupSubject: "Broadcast Team", ConversationLabel: "Broadcast Team" };

describe("broadcast routing", () => {
  const {
    builtInboundContextCalls: contexts,
    createBroadcastConfig,
    createBroadcastEvent,
    handleFeishuMessage,
    mockDispatchReply: dispatchReply,
    mockRecordInboundSession: recordSession,
    mockResolveAgentRoute: routeMock,
  } = setupFeishuBroadcastTestHarness();

  async function dispatch(messageId: string, cfg = createBroadcastConfig()) {
    await handleFeishuMessage({
      cfg,
      event: createBroadcastEvent({ messageId, text: "hello", botMentioned: true }),
      botOpenId: "bot-open-id",
      runtime: createRuntimeEnv(),
    });
  }

  it.each([
    ["agent:main:acp:feishu-bound", "agent:susan:acp:feishu-bound"],
    ["global", "global"],
  ])(
    "keeps bound route metadata on the matching broadcast agent for %s",
    async (targetSessionKey, observerSessionKey) => {
      const cfg = {
        ...createBroadcastConfig(),
        bindings: [{ agentId: "main", match: channelAccount }],
      };
      const conversation = { ...channelAccount, conversationId: "oc-broadcast-group" };
      const adapter: SessionBindingAdapter = {
        ...channelAccount,
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
            ...channelAccount,
            peer: { kind: "group", id: conversation.conversationId },
          }),
          conversation,
        });
        routeMock.mockReturnValue(route);

        await dispatch("msg-broadcast-bound-route", cfg);

        expect(
          contexts.toSorted((a, b) => String(a.AgentId).localeCompare(String(b.AgentId))),
        ).toMatchObject([
          { AgentId: "main", SessionKey: targetSessionKey, ...groupLabels },
          { AgentId: "susan", SessionKey: observerSessionKey, ...groupLabels },
        ]);
        const recordedRoutes = recordSession.mock.calls
          .map(([{ updateLastRoute: last }]) => [last?.sessionKey, last?.channel, last?.to])
          .toSorted((a, b) => String(a[0]).localeCompare(String(b[0])));
        expect(recordedRoutes).toEqual(
          [targetSessionKey, observerSessionKey]
            .map((key) => [key, "feishu", "chat:oc-broadcast-group"])
            .toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
        );
        const routeMetadataKeys = Object.getOwnPropertySymbols(route);
        expect(routeMetadataKeys).not.toHaveLength(0);
        for (const ctx of contexts) {
          for (const key of routeMetadataKeys) {
            expect(Reflect.get(ctx, key)).toBe(
              ctx.AgentId === "main" ? Reflect.get(route, key) : undefined,
            );
          }
        }
      } finally {
        unregisterSessionBindingAdapter({ ...channelAccount, adapter });
      }
    },
  );

  it("skips unknown agents not in agents.entries", async () => {
    await dispatch("msg-broadcast-unknown-agent", {
      ...createBroadcastConfig(),
      broadcast: { "oc-broadcast-group": ["susan", "unknown-agent"] },
    });

    expect(dispatchReply).toHaveBeenCalledTimes(1);
    expect(contexts[0]?.SessionKey).toBe("agent:susan:feishu:group:oc-broadcast-group");
  });
});
