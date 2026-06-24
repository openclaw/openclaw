// Mattermost tests cover session route plugin behavior.
import { describe, expect, it } from "vitest";
import { rememberMattermostChannelKind } from "./mattermost/channel-kind-store.js";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";
function expectRoute(route: ReturnType<typeof resolveMattermostOutboundSessionRoute>) {
  if (!route) {
    throw new Error("Expected Mattermost route");
  }
  return route;
}
describe("mattermost session route", () => {
  it("builds direct-message routes for user targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "@user123",
    });
    const directRoute = expectRoute(route);
    expect(directRoute.peer.kind).toBe("direct");
    expect(directRoute.peer.id).toBe("user123");
    expect(directRoute.from).toBe("mattermost:user123");
    expect(directRoute.to).toBe("user:user123");
  });
  it("builds threaded channel routes for channel targets", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      threadId: "thread456",
    });
    const channelRoute = expectRoute(route);
    expect(channelRoute.peer.kind).toBe("channel");
    expect(channelRoute.peer.id).toBe("chan123");
    expect(channelRoute.from).toBe("mattermost:channel:chan123");
    expect(channelRoute.to).toBe("channel:chan123");
    expect(channelRoute.threadId).toBe("thread456");
    expect(channelRoute.sessionKey).toContain("thread456");
  });
  it("recovers channel thread routes from currentSessionKey", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      currentSessionKey: "agent:main:mattermost:channel:chan123:thread:root-post",
    });
    const recoveredRoute = expectRoute(route);
    expect(recoveredRoute.sessionKey).toBe(
      "agent:main:mattermost:channel:chan123:thread:root-post",
    );
    expect(recoveredRoute.baseSessionKey).toBe("agent:main:mattermost:channel:chan123");
    expect(recoveredRoute.threadId).toBe("root-post");
  });
  it("keeps explicit replyToId ahead of recovered currentSessionKey thread", () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:chan123",
      replyToId: "explicit-root",
      currentSessionKey: "agent:main:mattermost:channel:chan123:thread:root-post",
    });
    const replyRoute = expectRoute(route);
    expect(replyRoute.sessionKey).toBe(
      "agent:main:mattermost:channel:chan123:thread:explicit-root",
    );
    expect(replyRoute.threadId).toBe("explicit-root");
  });
  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', () => {
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "@user123",
      currentSessionKey: "agent:main:main:thread:root-post",
    });
    const dmRoute = expectRoute(route);
    expect(dmRoute.sessionKey).toBe("agent:main:main");
    expect(dmRoute.baseSessionKey).toBe("agent:main:main");
    expect(dmRoute.threadId).toBeUndefined();
  });
  it("returns null when the target is empty after normalization", () => {
    expect(
      resolveMattermostOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "acct-1",
        target: "mattermost:",
      }),
    ).toBeNull();
  });
  it("resolves private-channel group target to chatType group when cache is warm [regression]", () => {
    rememberMattermostChannelKind("grp999", "group");
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:grp999",
      resolvedTarget: { kind: "group" },
    });
    const groupRoute = expectRoute(route);
    expect(groupRoute.chatType).toBe("group");
    expect(groupRoute.peer.kind).toBe("group");
    expect(groupRoute.peer.id).toBe("grp999");
    expect(groupRoute.from).toBe("mattermost:channel:grp999");
    expect(groupRoute.to).toBe("channel:grp999");
  });
  it("group outbound session uses channel routing but group session peer [regression]", () => {
    rememberMattermostChannelKind("grp999", "group");
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:grp999",
      resolvedTarget: { kind: "group" },
    });
    const groupRoute = expectRoute(route);
    expect(groupRoute.chatType).toBe("group");
    expect(groupRoute.peer.kind).toBe("group");
    expect(groupRoute.from).toBe("mattermost:channel:grp999");
    expect(groupRoute.to).toBe("channel:grp999");
    expect(groupRoute.chatType).not.toBe("channel");
    expect(groupRoute.peer.kind).not.toBe("channel");
  });
  it("cold-cache: public channel with directory kind group falls back to channel session [regression]", () => {
    // Do NOT pre-populate cache for pub-cold-123 — simulates a cold/public channel
    // that the Mattermost directory emits as kind:"group" but the cache hasn't confirmed.
    // Without the authoritative cache hit, isGroup must be false → chatType:"channel".
    const route = resolveMattermostOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "acct-1",
      target: "mattermost:channel:pub-cold-123",
      resolvedTarget: { kind: "group" },
    });
    const coldRoute = expectRoute(route);
    expect(coldRoute.chatType).toBe("channel");
    expect(coldRoute.peer.kind).toBe("channel");
    expect(coldRoute.from).toBe("mattermost:channel:pub-cold-123");
    expect(coldRoute.to).toBe("channel:pub-cold-123");
  });
});
