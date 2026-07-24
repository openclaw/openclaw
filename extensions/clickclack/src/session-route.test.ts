import { describe, expect, it } from "vitest";
import { clickClackPlugin } from "./channel.js";

describe("ClickClack outbound session routing", () => {
  it("claims exact sessions only for canonical DM user ids", async () => {
    const dmRoute = await clickClackPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "dm:usr_1",
    });
    const channelRoute = await clickClackPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "channel:general",
    });

    expect(dmRoute?.recipientSessionExact).toBe(true);
    expect(channelRoute?.recipientSessionExact).toBe(false);
  });

  it("routes provider-prefixed mixed-case targets to canonical sessions", async () => {
    const dmRoute = await clickClackPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "cc:DM:usr_1",
    });
    const channelRoute = await clickClackPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: {},
      agentId: "main",
      target: "ClickClack:Channel:General",
    });

    expect(dmRoute).toMatchObject({
      to: "dm:usr_1",
      chatType: "direct",
      recipientSessionExact: true,
      peer: { kind: "direct", id: "dm:usr_1" },
    });
    expect(channelRoute).toMatchObject({
      to: "channel:General",
      chatType: "group",
      recipientSessionExact: false,
      peer: { kind: "channel", id: "channel:General" },
    });
  });

  it("keeps threaded DMs on the inbound base session", async () => {
    const route = await clickClackPlugin.messaging?.resolveOutboundSessionRoute?.({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "dm:usr_1",
      threadId: "msg_thread_root",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:clickclack:direct:dm:usr_1",
      baseSessionKey: "agent:main:clickclack:direct:dm:usr_1",
      recipientSessionExact: true,
      threadId: "msg_thread_root",
    });
  });
});
