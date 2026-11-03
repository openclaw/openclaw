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
  it.each([
    [
      "channel",
      "120363401234567890@newsletter",
      "agent:main:whatsapp:channel:120363401234567890@newsletter",
      {},
    ],
    [
      "direct",
      "+15551234567",
      "agent:main:whatsapp:direct:+15551234567",
      { session: { dmScope: "per-channel-peer" } },
    ],
  ] as const)("routes %s targets", async (kind, target, sessionKey, cfg) => {
    const route = await resolveSessionRoute({
      cfg,
      agentId: "main",
      target,
    });
    expect(route).toEqual({
      sessionKey,
      baseSessionKey: sessionKey,
      recipientSessionExact: true,
      peer: { kind, id: target },
      chatType: kind,
      from: target,
      to: target,
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
  it.each([
    [
      "default account listener",
      { defaultAccount: "work", accounts: { work: { authDir: "/tmp/work" } } },
      "work",
      "ok",
    ],
    ["disabled channel", { enabled: false }, undefined, "whatsapp-disabled"],
    [
      "unstable auth",
      { accounts: { default: { authDir: "/tmp/default" } } },
      undefined,
      WHATSAPP_AUTH_UNSTABLE_CODE,
    ],
  ] as const)("checks %s", async (_name, whatsapp, listenerAccount, reason) => {
    if (reason === WHATSAPP_AUTH_UNSTABLE_CODE) {
      readAuth.mockResolvedValueOnce({ outcome: "unstable" });
    }
    const result = await checkReady({
      cfg: { channels: { whatsapp } },
      deps: {
        hasActiveWebListener: (id) => listenerAccount === undefined || id === listenerAccount,
      },
    });
    expect(result).toEqual({ ok: reason === "ok", reason });
  });
});
