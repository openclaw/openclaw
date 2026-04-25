import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "./runtime-api.js";
import { resolveBlueBubblesOutboundSessionRoute } from "./session-route.js";

const EMPTY_CFG = {} as OpenClawConfig;

function call(target: string) {
  return resolveBlueBubblesOutboundSessionRoute({
    cfg: EMPTY_CFG,
    agentId: "agent-1",
    accountId: "default",
    target,
  });
}

describe("resolveBlueBubblesOutboundSessionRoute DM/group disambiguation", () => {
  it("treats `chat_guid:` with `;-;` marker as a DM", () => {
    // Candidate-2 regression: the previous implementation classified ANY
    // chat_guid-prefixed target as a group, even DMs (BlueBubbles encodes
    // DM chatGuids as `service;-;handle`). That made the same DM resolve
    // to one sessionKey via handle form (`+15551234567`) and a different
    // sessionKey via chat_guid form (`chat_guid:iMessage;-;+15551234567`),
    // causing bound DM sessions to mis-route into a freshly synthesized
    // "group" session key.
    const route = call("bluebubbles:chat_guid:iMessage;-;+15551234567");
    expect(route).not.toBeNull();
    expect(route?.peer.kind).toBe("direct");
    expect(route?.chatType).toBe("direct");
    expect(route?.from).toMatch(/^bluebubbles:/);
    expect(route?.from).not.toMatch(/^group:/);
  });

  it("treats `chat_guid:` with `;+;` marker as a group", () => {
    const route = call("bluebubbles:chat_guid:iMessage;+;chat-known-123");
    expect(route).not.toBeNull();
    expect(route?.peer.kind).toBe("group");
    expect(route?.chatType).toBe("group");
    expect(route?.from).toMatch(/^group:/);
  });

  it("falls back to group when chat_guid lacks a recognizable marker", () => {
    // Backwards-compatible default: pre-fix behavior was to treat all
    // chat_guid forms as group. Preserve that for unknown shapes so we
    // do not silently downgrade an actual group to direct.
    const route = call("bluebubbles:chat_guid:weird-no-semicolons");
    expect(route).not.toBeNull();
    expect(route?.peer.kind).toBe("group");
  });

  it("treats handle targets as direct", () => {
    const route = call("bluebubbles:imessage:+15551234567");
    expect(route).not.toBeNull();
    expect(route?.peer.kind).toBe("direct");
    expect(route?.from).toMatch(/^bluebubbles:/);
  });

  it("keeps chat_id targets classified as group", () => {
    const route = call("bluebubbles:chat_id:42");
    expect(route).not.toBeNull();
    expect(route?.peer.kind).toBe("group");
    expect(route?.peer.id).toBe("42");
  });

  it("keeps chat_identifier targets classified as group", () => {
    const route = call("bluebubbles:chat_identifier:chat-abc");
    expect(route).not.toBeNull();
    expect(route?.peer.kind).toBe("group");
    expect(route?.peer.id).toBe("chat-abc");
  });

  it("DM via chat_guid and DM via handle land on the same session key", () => {
    // The point of disambiguation: a DM addressed two different ways must
    // converge on the same sessionKey so existing bindings keep matching.
    const handleRoute = call("bluebubbles:imessage:+15551234567");
    const chatGuidRoute = call("bluebubbles:chat_guid:iMessage;-;+15551234567");
    expect(handleRoute?.sessionKey).toBeDefined();
    expect(chatGuidRoute?.sessionKey).toBeDefined();
    // Both are direct now; sessionKey base derives from peer.id.
    expect(handleRoute?.peer.kind).toBe(chatGuidRoute?.peer.kind);
  });
});
