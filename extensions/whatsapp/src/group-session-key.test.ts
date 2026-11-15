// Whatsapp tests cover group session key plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveWhatsAppGroupSessionRoute } from "./group-session-key.js";

describe("resolveWhatsAppGroupSessionRoute", () => {
  it("keeps default-account group routes unchanged", () => {
    const route = {
      agentId: "main",
      channel: "whatsapp",
      accountId: "default",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    } as const;

    expect(resolveWhatsAppGroupSessionRoute(route)).toEqual(route);
  });

  it("scopes named-account group routes through an account-specific thread suffix", () => {
    const route = {
      agentId: "main",
      channel: "whatsapp",
      accountId: "work",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      mainSessionKey: "agent:main:main",
      lastRoutePolicy: "session",
      matchedBy: "default",
    } as const;

    expect(resolveWhatsAppGroupSessionRoute(route)).toEqual({
      ...route,
      sessionKey: "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work",
    });
  });
});
