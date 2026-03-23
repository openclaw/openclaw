import { describe, expect, it } from "vitest";
import { resolveMSTeamsOutboundSessionRoute } from "./session-route.js";

describe("msteams session route", () => {
  it("builds direct routes for explicit user targets", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:user:alice-id",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "direct",
        id: "alice-id",
      },
      from: "msteams:alice-id",
      to: "user:alice-id",
    });
  });

  it("builds channel routes for thread conversations and strips suffix metadata", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "teams:19:abc123@thread.tacv2;messageid=42",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "channel",
        id: "19:abc123@thread.tacv2",
      },
      from: "msteams:channel:19:abc123@thread.tacv2",
      to: "conversation:19:abc123@thread.tacv2",
    });
  });

  it("returns group routes for non-user, non-channel conversations", () => {
    const route = resolveMSTeamsOutboundSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "default",
      target: "msteams:conversation:19:groupchat",
    });

    expect(route).toMatchObject({
      peer: {
        kind: "group",
        id: "19:groupchat",
      },
      from: "msteams:group:19:groupchat",
      to: "conversation:19:groupchat",
    });
  });

  it("returns null when the target cannot be normalized", () => {
    expect(
      resolveMSTeamsOutboundSessionRoute({
        cfg: {},
        agentId: "main",
        accountId: "default",
        target: "msteams:",
      }),
    ).toBeNull();
  });
});
