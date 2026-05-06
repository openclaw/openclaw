import { describe, expect, it } from "vitest";
import { resolveDiscordOutboundSessionRoute } from "./outbound-session-route.js";

describe("resolveDiscordOutboundSessionRoute", () => {
  it("keeps explicit delivery thread ids without adding a session suffix", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      threadId: "thread-1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:discord:channel:123",
      baseSessionKey: "agent:main:discord:channel:123",
      threadId: "thread-1",
    });
  });

  it("does not promote replyToId into Discord delivery thread metadata", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "channel:123",
      replyToId: "message-1",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:discord:channel:123",
      baseSessionKey: "agent:main:discord:channel:123",
    });
    expect(route?.threadId).toBeUndefined();
  });

  it("routes provider-prefixed channel targets as channels", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "discord:channel:123",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:discord:channel:123",
      baseSessionKey: "agent:main:discord:channel:123",
      chatType: "channel",
      from: "discord:channel:123",
      to: "channel:123",
    });
  });

  it("keeps legacy provider-prefixed numeric targets as direct messages", () => {
    const route = resolveDiscordOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      target: "discord:123",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:main",
      baseSessionKey: "agent:main:main",
      chatType: "direct",
      from: "discord:123",
      to: "user:123",
    });
  });
});
