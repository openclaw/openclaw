import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";

function resolveRoute(
  target: string,
  options: Partial<Parameters<typeof resolveMattermostOutboundSessionRoute>[0]> = {},
) {
  const route = resolveMattermostOutboundSessionRoute({
    cfg: {},
    agentId: "main",
    accountId: "acct-1",
    target,
    ...options,
  });
  if (!route) {
    throw new Error("Expected Mattermost route");
  }
  return route;
}

describe("mattermost session route", () => {
  it("accepts canonical user ids but keeps channel-shaped ids inexact", () => {
    const id = "abcdefghijklmnopqrstuvwxyz";
    expect(resolveRoute(id).recipientSessionExact).toBe(false);
    expect(resolveRoute(`user:${id}`).recipientSessionExact).toBe(true);
    expect(resolveRoute(`channel:${id}`).recipientSessionExact).toBe(false);
  });

  it("keeps explicit replyToId ahead of recovered currentSessionKey thread", () => {
    const route = resolveRoute("mattermost:channel:chan123", {
      replyToId: "explicit-root",
      currentSessionKey: "agent:main:mattermost:channel:chan123:thread:root-post",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:mattermost:channel:chan123:thread:explicit-root",
      threadId: "explicit-root",
    });
  });

  it('does not recover currentSessionKey threads for shared dmScope "main" DMs', () => {
    const route = resolveRoute("@user123", {
      currentSessionKey: "agent:main:main:thread:root-post",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
    });
    expect(route.threadId).toBeUndefined();
  });

  it.each(["directory", "session"] as const)(
    "keys a private channel as group from %s",
    (source) => {
      const route = resolveRoute(
        "mattermost:channel:priv123",
        source === "directory"
          ? { resolvedTarget: { to: "channel:priv123", kind: "group", source: "directory" } }
          : { currentSessionKey: "agent:main:mattermost:group:priv123:thread:root-post" },
      );
      expect(route).toMatchObject({
        peer: { kind: "group", id: "priv123" },
        chatType: "group",
        from: "mattermost:group:priv123",
        to: "channel:priv123",
        baseSessionKey: "agent:main:mattermost:group:priv123",
      });
      if (source === "session") {
        expect(route).toMatchObject({
          sessionKey: "agent:main:mattermost:group:priv123:thread:root-post",
          threadId: "root-post",
        });
      }
    },
  );

  it("keeps a public channel as channel when an unrelated group session key exists", () => {
    const route = resolveRoute("mattermost:channel:pub999", {
      // A group session key for a DIFFERENT peer must not leak onto this channel.
      currentSessionKey: "agent:main:mattermost:group:priv123:thread:root-post",
    });

    expect(route).toMatchObject({
      peer: { kind: "channel" },
      chatType: "channel",
      baseSessionKey: "agent:main:mattermost:channel:pub999",
    });
  });

  it("lets an authoritative public channel override a stale same-peer group session", () => {
    const route = resolveRoute("mattermost:channel:pub999", {
      resolvedTarget: {
        to: "channel:pub999",
        kind: "channel",
        source: "directory",
      },
      currentSessionKey: "agent:main:mattermost:group:pub999:thread:stale-root",
    });

    expect(route.peer).toEqual({ kind: "channel", id: "pub999" });
    expect(route.baseSessionKey).toBe("agent:main:mattermost:channel:pub999");
    expect(route.sessionKey).not.toContain("mattermost:group:pub999");
  });

  it("ignores a non-canonical session key containing an embedded Mattermost route", () => {
    const route = resolveRoute("mattermost:channel:priv123", {
      currentSessionKey: "agent:main:other:group:peer:mattermost:group:priv123:thread:root-post",
    });

    expect(route.peer.kind).toBe("channel");
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
});
