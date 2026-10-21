import { describe, expect, it } from "vitest";
import { telegramPlugin } from "./channel.js";

const messaging = telegramPlugin.messaging!;
type RouteParams = Parameters<NonNullable<typeof messaging.resolveOutboundSessionRoute>>[0];
function resolveRoute(target: string, params: Partial<Omit<RouteParams, "target">> = {}) {
  return messaging.resolveOutboundSessionRoute!({ cfg: {}, agentId: "main", target, ...params });
}

describe("telegram session route", () => {
  it("aligns isolated direct topic sessions with inbound reply routing", async () => {
    const route = await resolveRoute("104506878:topic:174872", {
      cfg: { session: { dmScope: "per-account-channel-peer" } },
      agentId: "finance",
      accountId: "finance",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:finance:telegram:finance:direct:104506878:thread:104506878:174872",
      baseSessionKey: "agent:finance:telegram:finance:direct:104506878",
      threadId: 174872,
      from: "telegram:104506878:topic:174872",
    });
  });

  it.each(["12345", "@alice"])("recovers isolated direct topic routes for %s", async (target) => {
    const baseSessionKey = `agent:main:telegram:direct:${target}`;
    const sessionKey = `${baseSessionKey}:thread:${target}:99`;
    const route = await resolveRoute(target, {
      cfg: { session: { dmScope: "per-channel-peer" } },
      currentSessionKey: sessionKey,
    });
    expect(route).toMatchObject({
      sessionKey,
      baseSessionKey,
      threadId: 99,
      from: `telegram:${target}:topic:99`,
    });
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', async () => {
    const route = await resolveRoute("12345", {
      currentSessionKey: "agent:main:main:thread:12345:99",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      recipientSessionExact: true,
    });
    expect(route?.threadId).toBeUndefined();
  });

  it.each([
    [undefined, "agent:main:telegram:work:direct:12345"],
    ["work", "agent:main:main"],
  ])("classifies direct sessions with defaultAccount=%s", async (defaultAccount, expected) => {
    const route = await resolveRoute("12345", {
      cfg: {
        channels: { telegram: { defaultAccount, accounts: { work: {}, personal: {} } } },
      },
      accountId: "work",
    });
    expect(route).toMatchObject({
      sessionKey: expected,
      baseSessionKey: expected,
      recipientSessionExact: true,
    });
  });

  it.each(["direct-topic", "topic"])("keeps %s group routes distinct", async (scope) => {
    const target = `-100:${scope}:99`;
    expect(await resolveRoute(target)).toMatchObject({
      sessionKey: `agent:main:telegram:group:${target}`,
      from: `telegram:group:${target}`,
      to: `telegram:${target}`,
      threadId: 99,
    });
  });

  it.each([
    ["-1001:Topic:77", "77", "-1001:topic:77"],
    ["-1001:direct-topic:77", "direct-topic:77", "-1001:direct-topic:77"],
  ])("round-trips registered session topic %s", (rawId, expectedThread, target) => {
    const conversation = messaging.resolveSessionConversation!({ kind: "group", rawId });
    expect(conversation).toMatchObject({
      id: "-1001",
      threadId: expectedThread,
      parentConversationCandidates: ["-1001"],
    });
    const { id, threadId } = conversation!;
    expect(messaging.resolveSessionTarget!({ kind: "group", id, threadId })).toBe(target);
  });

  it("keeps topicless sessions and username targets outside topic parsing", () => {
    expect(messaging.resolveSessionConversation!({ kind: "group", rawId: "-1001" })).toBeNull();
    expect(messaging.resolveSessionTarget!({ kind: "channel", id: "@OpenClawTeam" })).toBe(
      "@OpenClawTeam",
    );
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
    const route = await resolveRoute("@team", {
      resolvedTarget: { to: "@team", kind: "group", source: "directory" },
    });

    expect(route).toMatchObject({ peer: { kind: "group" }, recipientSessionExact: false });
  });
});
