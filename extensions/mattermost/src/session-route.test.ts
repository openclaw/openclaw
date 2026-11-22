import { describe, expect, it } from "vitest";
import { resolveMattermostOutboundSessionRoute } from "./session-route.js";

type RouteOptions = Partial<Parameters<typeof resolveMattermostOutboundSessionRoute>[0]>;
const defaults = { cfg: {}, agentId: "main", accountId: "acct-1" };
const sessionKey = (path: string) => `agent:main:mattermost:${path}`;

function resolveRoute(target: string, options: RouteOptions = {}) {
  const route = resolveMattermostOutboundSessionRoute({ ...defaults, target, ...options });
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

  it("keeps explicit replyToId ahead of the recovered thread", () => {
    expect(
      resolveRoute("mattermost:channel:chan123", {
        replyToId: "explicit-root",
        currentSessionKey: sessionKey("channel:chan123:thread:root-post"),
      }),
    ).toMatchObject({
      sessionKey: sessionKey("channel:chan123:thread:explicit-root"),
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

  it("keys a private channel as group from the current session", () => {
    const currentSessionKey = sessionKey("group:priv123:thread:root-post");
    expect(resolveRoute("mattermost:channel:priv123", { currentSessionKey })).toMatchObject({
      peer: { kind: "group", id: "priv123" },
      chatType: "group",
      from: "mattermost:group:priv123",
      to: "channel:priv123",
      baseSessionKey: sessionKey("group:priv123"),
      sessionKey: currentSessionKey,
      threadId: "root-post",
    });
  });

  it.each([
    ["unrelated peer", sessionKey("group:other:thread:root-post"), undefined],
    ["directory override", sessionKey("group:pub999:thread:stale-root"), "channel"],
    [
      "embedded route",
      "agent:main:other:group:peer:mattermost:group:pub999:thread:root-post",
      undefined,
    ],
  ] as const)("keeps public routing for %s", (_name, currentSessionKey, kind) => {
    const route = resolveRoute("mattermost:channel:pub999", {
      currentSessionKey,
      ...(kind
        ? { resolvedTarget: { to: "channel:pub999", kind, source: "directory" as const } }
        : {}),
    });
    expect(route.peer).toEqual({ kind: "channel", id: "pub999" });
    expect(route).toMatchObject({
      chatType: "channel",
      baseSessionKey: "agent:main:mattermost:channel:pub999",
    });
    expect(route.sessionKey).not.toContain("mattermost:group:pub999");
  });

  it("returns null when the target is empty after normalization", () => {
    expect(
      resolveMattermostOutboundSessionRoute({ cfg: {}, agentId: "main", target: "mattermost:" }),
    ).toBeNull();
  });
});
