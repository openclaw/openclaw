// Telegram tests cover session route plugin behavior.
import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";

describe("telegram session route", () => {
  it("aligns isolated direct topic sessions with inbound reply routing", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-account-channel-peer" } },
      agentId: "finance",
      accountId: "finance",
      target: "104506878:topic:174872",
    });

    expect(route?.sessionKey).toBe(
      "agent:finance:telegram:finance:direct:104506878:thread:104506878:174872",
    );
    expect(route?.baseSessionKey).toBe("agent:finance:telegram:finance:direct:104506878");
    expect(route?.threadId).toBe(174872);
    expect(route?.from).toBe("telegram:104506878:topic:174872");
  });

  it("recovers direct topic thread routes from currentSessionKey when the DM scope is isolated", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "12345",
      currentSessionKey: "agent:main:telegram:direct:12345:thread:12345:99",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:direct:12345:thread:12345:99");
    expect(route?.baseSessionKey).toBe("agent:main:telegram:direct:12345");
    expect(route?.threadId).toBe(99);
    expect(route?.from).toBe("telegram:12345:topic:99");
  });

  it("recovers username direct topic thread routes from currentSessionKey", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "@alice",
      currentSessionKey: "agent:main:telegram:direct:@alice:thread:@alice:99",
    });

    expect(route?.sessionKey).toBe("agent:main:telegram:direct:@alice:thread:@alice:99");
    expect(route?.baseSessionKey).toBe("agent:main:telegram:direct:@alice");
    expect(route?.threadId).toBe(99);
    expect(route?.from).toBe("telegram:@alice:topic:99");
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "12345",
      currentSessionKey: "agent:main:main:thread:12345:99",
    });

    expect(route?.sessionKey).toBe("agent:main:main");
    expect(route?.baseSessionKey).toBe("agent:main:main");
    expect(route?.threadId).toBeUndefined();
    expect(route?.recipientSessionExact).toBe(true);
  });

  it.each([
    { defaultAccount: undefined, expected: "agent:main:telegram:work:direct:12345" },
    { defaultAccount: "work", expected: "agent:main:main" },
  ])(
    "classifies direct sessions with defaultAccount=$defaultAccount",
    async ({ defaultAccount, expected }) => {
      const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
        cfg: {
          channels: { telegram: { defaultAccount, accounts: { work: {}, personal: {} } } },
        },
        agentId: "main",
        accountId: "work",
        target: "12345",
      });

      expect(route?.sessionKey).toBe(expected);
      expect(route?.baseSessionKey).toBe(expected);
      expect(route?.recipientSessionExact).toBe(true);
    },
  );

  it("keeps direct-message and forum topics with the same id in distinct group routes", async () => {
    const direct = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "-100:direct-topic:99",
    });
    const forum = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "-100:topic:99",
    });

    expect(direct?.sessionKey).toBe("agent:main:telegram:group:-100:direct-topic:99");
    expect(direct?.from).toBe("telegram:group:-100:direct-topic:99");
    expect(direct?.to).toBe("telegram:-100:direct-topic:99");
    expect(direct?.threadId).toBe(99);
    expect(forum?.sessionKey).toBe("agent:main:telegram:group:-100:topic:99");
  });

  it.each([
    { rawId: "-1001:Topic:77", threadId: "77", target: "-1001:topic:77" },
    {
      rawId: "-1001:direct-topic:77",
      threadId: "direct-topic:77",
      target: "-1001:direct-topic:77",
    },
  ])("round-trips registered session topic $rawId", ({ rawId, threadId, target }) => {
    const conversation = telegramPlugin.messaging?.resolveSessionConversation?.({
      kind: "group",
      rawId,
    });
    expect(conversation).toMatchObject({
      id: "-1001",
      threadId,
      parentConversationCandidates: ["-1001"],
    });
    expect(
      telegramPlugin.messaging?.resolveSessionTarget?.({
        kind: "group",
        id: conversation!.id,
        threadId: conversation!.threadId,
      }),
    ).toBe(target);
  });

  it("keeps topicless sessions and username targets outside topic parsing", () => {
    expect(
      telegramPlugin.messaging?.resolveSessionConversation?.({ kind: "group", rawId: "-1001" }),
    ).toBeNull();
    expect(
      telegramPlugin.messaging?.resolveSessionTarget?.({ kind: "channel", id: "@OpenClawTeam" }),
    ).toBe("@OpenClawTeam");
  });

  it("skips unusable command candidates and preserves a later direct topic", () => {
    expect(
      telegramPlugin.bindings?.resolveCommandConversation?.({
        accountId: "default",
        originatingTo: "telegram:-100123",
        commandTo: "telegram:-100123:direct-topic:77",
      }),
    ).toEqual({
      conversationId: "-100123:direct-topic:77",
      parentConversationId: "-100123",
    });
  });

  it("does not treat directory-resolved usernames as canonical session ids", async () => {
    const route = await telegramPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "@team",
      resolvedTarget: { to: "@team", kind: "group", source: "directory" },
    });

    expect(route?.peer.kind).toBe("group");
    expect(route?.recipientSessionExact).toBe(false);
  });
});
