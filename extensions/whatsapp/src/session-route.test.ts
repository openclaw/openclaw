// Whatsapp tests cover session route plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store.js";
import { whatsappPlugin } from "./channel.js";

const readAuth = vi.hoisted(() =>
  vi.fn<typeof import("./auth-store.js").readWebAuthExistsForDecision>(),
);

vi.mock("./auth-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./auth-store.js")>()),
  readWebAuthExistsForDecision: readAuth,
}));

const resolveSessionRoute = whatsappPlugin.messaging?.resolveOutboundSessionRoute;
const checkReady = whatsappPlugin.heartbeat?.checkReady;
if (!resolveSessionRoute || !checkReady) {
  throw new Error("Expected WhatsApp routing and heartbeat adapters");
}

beforeEach(() => {
  readAuth.mockReset().mockResolvedValue({ outcome: "stable", exists: true });
});

describe("WhatsApp channel outbound session routing", () => {
  it("routes newsletter JIDs as channel sessions", async () => {
    const route = await resolveSessionRoute({
      cfg: {},
      agentId: "main",
      target: "120363401234567890@newsletter",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:whatsapp:channel:120363401234567890@newsletter",
      baseSessionKey: "agent:main:whatsapp:channel:120363401234567890@newsletter",
      recipientSessionExact: true,
      peer: {
        kind: "channel",
        id: "120363401234567890@newsletter",
      },
      chatType: "channel",
      from: "120363401234567890@newsletter",
      to: "120363401234567890@newsletter",
    });
  });

  it("keeps direct user targets on direct session semantics", async () => {
    const route = await resolveSessionRoute({
      cfg: { session: { dmScope: "per-channel-peer" } },
      agentId: "main",
      target: "+15551234567",
    });

    expect(route).toEqual({
      sessionKey: "agent:main:whatsapp:direct:+15551234567",
      baseSessionKey: "agent:main:whatsapp:direct:+15551234567",
      recipientSessionExact: true,
      peer: {
        kind: "direct",
        id: "+15551234567",
      },
      chatType: "direct",
      from: "+15551234567",
      to: "+15551234567",
    });
  });

  it("uses the inbound account suffix for named-account groups", async () => {
    const route = await resolveSessionRoute({
      cfg: {},
      agentId: "main",
      accountId: "work",
      target: "123@g.us",
    });

    expect(route).toMatchObject({
      sessionKey: "agent:main:whatsapp:group:123@g.us:thread:whatsapp-account-work",
      baseSessionKey: "agent:main:whatsapp:group:123@g.us",
      recipientSessionExact: true,
    });
  });
});

describe("WhatsApp channel heartbeat readiness", () => {
  it("heartbeat readiness uses configured defaultAccount for active listener checks", async () => {
    const result = await checkReady({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: { work: { authDir: "/tmp/work" } },
          },
        },
      },
      deps: {
        hasActiveWebListener: (accountId?: string) => accountId === "work",
      },
    });

    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("heartbeat readiness honors the channel disable flag", async () => {
    const result = await checkReady({
      cfg: { channels: { whatsapp: { enabled: false } } },
      deps: {
        hasActiveWebListener: () => true,
      },
    });

    expect(result).toEqual({ ok: false, reason: "whatsapp-disabled" });
  });

  it("heartbeat readiness returns unstable when auth state timing is unresolved", async () => {
    readAuth.mockResolvedValueOnce({ outcome: "unstable" });
    const result = await checkReady({
      cfg: {
        channels: { whatsapp: { accounts: { default: { authDir: "/tmp/default" } } } },
      },
      deps: {
        hasActiveWebListener: () => true,
      },
    });

    expect(result).toEqual({ ok: false, reason: WHATSAPP_AUTH_UNSTABLE_CODE });
  });
});
