// Irc tests cover normalize plugin behavior.
import { describe, expect, it } from "vitest";
import { createIrcIngressSubject } from "./ingress-identity.js";
import { normalizeIrcAllowEntry, resolveIrcOutboundSessionRoute } from "./normalize.js";

describe("irc normalize", () => {
  it("builds canonical channel and direct session routes", () => {
    const cfg = { session: { dmScope: "per-channel-peer" as const } };
    expect(
      resolveIrcOutboundSessionRoute({
        cfg,
        agentId: "main",
        target: "irc:channel:openclaw",
      }),
    ).toMatchObject({
      sessionKey: "agent:main:irc:group:#openclaw",
      peer: { kind: "group", id: "#openclaw" },
      chatType: "group",
      recipientSessionExact: false,
      to: "#openclaw",
    });
    expect(
      resolveIrcOutboundSessionRoute({ cfg, agentId: "main", target: "user:alice" }),
    ).toMatchObject({
      sessionKey: "agent:main:irc:direct:alice",
      peer: { kind: "direct", id: "alice" },
      chatType: "direct",
      recipientSessionExact: "direct-alias",
      to: "alice",
    });
    expect(resolveIrcOutboundSessionRoute({ cfg, agentId: "main", target: "\n" })).toBeNull();
  });

  it("collapses direct aliases to the configured shared main session", () => {
    expect(
      resolveIrcOutboundSessionRoute({
        cfg: { session: { dmScope: "main", mainKey: "work" } },
        agentId: "ops",
        target: "user:alice",
      }),
    ).toMatchObject({
      sessionKey: "agent:ops:work",
      baseSessionKey: "agent:ops:work",
      recipientSessionExact: "direct-alias",
      chatType: "direct",
    });
  });

  it("normalizes allowlist entries", () => {
    expect(normalizeIrcAllowEntry("IRC:User:Alice!u@h")).toBe("alice!u@h");
  });

  it.each([
    ["ident", "example.org", "alice!ident@example.org", "alice!ident", "alice@example.org"],
    [undefined, "example.org", "alice@example.org", undefined, "alice@example.org"],
    ["ident", undefined, "alice", "alice!ident", undefined],
    [undefined, undefined, "alice", undefined, undefined],
    ["ident", "host!suffix", "alice!ident@host!suffix", "alice!ident", undefined],
  ])(
    "projects sender user=%s host=%s into ingress identities",
    (user, host, stableId, nickUser, nickHost) => {
      const message = {
        messageId: "m1",
        target: "#chan",
        senderNick: "Alice",
        senderUser: user,
        senderHost: host,
        text: "hi",
        timestamp: Date.now(),
        isGroup: true,
      };

      expect(createIrcIngressSubject(message)).toEqual({
        stableId,
        aliases: {
          "irc-id-nick-user": nickUser,
          "irc-id-nick-host": nickHost,
          "irc-nick": "alice",
        },
      });
    },
  );
});
