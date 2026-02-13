import { describe, it, expect, vi } from "vitest";
import type { VoiceCallConfig } from "../config.js";
import { AsteriskAriProvider, buildEndpoint } from "./asterisk-ari.js";

function createProvider() {
  const config = {
    enabled: true,
    provider: "asterisk-ari",
    outbound: { defaultMode: "conversation" },
    asteriskAri: {
      baseUrl: "http://127.0.0.1:8088",
      username: "user",
      password: "pass",
      app: "openclaw",
      rtpHost: "127.0.0.1",
      rtpPort: 12000,
      codec: "ulaw",
    },
  } as unknown as VoiceCallConfig;

  const managerStub = {
    processEvent: vi.fn(),
    getCallByProviderCallId: () => undefined,
    getCall: () => undefined,
  } as any;

  const provider = new AsteriskAriProvider({
    config,
    manager: managerStub,
    connectWs: false,
  });

  return { provider, managerStub };
}

describe("AsteriskAriProvider", () => {
  it("verifyWebhook returns ok", () => {
    const { provider } = createProvider();
    const result = provider.verifyWebhook({
      headers: {},
      rawBody: "",
      url: "http://localhost",
      method: "POST",
    });
    expect(result.ok).toBe(true);
  });

  it("parseWebhookEvent returns empty events", () => {
    const { provider } = createProvider();
    const result = provider.parseWebhookEvent({
      headers: {},
      rawBody: "",
      url: "http://localhost",
      method: "POST",
    });
    expect(result.events).toHaveLength(0);
  });

  it("emits call.dtmf on ChannelDtmfReceived", async () => {
    const { provider, managerStub } = createProvider();
    const anyProvider = provider as any;

    anyProvider.calls.set("call-1", {
      callId: "internal-1",
      providerCallId: "call-1",
      sipChannelId: "sip-1",
      speaking: false,
    });

    await anyProvider.onAriEvent({
      type: "ChannelDtmfReceived",
      channel: { id: "sip-1" },
      digit: "5",
    });

    expect(managerStub.processEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "call.dtmf",
        callId: "internal-1",
        providerCallId: "call-1",
        digits: "5",
      }),
    );
  });

  it("guards against duplicate call.ended when StasisEnd races with cleanup", async () => {
    const { provider, managerStub } = createProvider();
    const anyProvider = provider as any;

    const deferred: { resolve: () => void; promise: Promise<void> } = (() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { resolve, promise };
    })();

    anyProvider.client.safeHangupChannel = vi.fn(() => deferred.promise);

    // Simulate an inbound call where providerCallId === sipChannelId.
    anyProvider.calls.set("sip-1", {
      callId: "internal-1",
      providerCallId: "sip-1",
      sipChannelId: "sip-1",
      speaking: false,
    });

    managerStub.getCallByProviderCallId = vi.fn(() => ({
      callId: "internal-1",
      providerCallId: "sip-1",
      state: "active",
    }));

    // Start cleanup, but block at the first await.
    const cleanupPromise = anyProvider.cleanup("sip-1", "hangup-user");
    await Promise.resolve();

    // StasisEnd arrives while cleanup() is in-flight, after local state was removed.
    await anyProvider.onAriEvent({
      type: "StasisEnd",
      channel: { id: "sip-1" },
    });

    deferred.resolve();
    await cleanupPromise;

    const endedEvents = managerStub.processEvent.mock.calls
      .map((c: any[]) => c[0])
      .filter((e: any) => e?.type === "call.ended");

    expect(endedEvents).toHaveLength(1);
    expect(endedEvents[0]).toEqual(
      expect.objectContaining({
        type: "call.ended",
        callId: "internal-1",
        providerCallId: "sip-1",
        reason: "hangup-user",
      }),
    );
  });
});

describe("asterisk-ari buildEndpoint", () => {
  it("keeps explicit dialstrings", () => {
    expect(buildEndpoint("PJSIP/1000")).toBe("PJSIP/1000");
    expect(buildEndpoint("SIP/1234")).toBe("SIP/1234");
  });

  it("builds PJSIP endpoint without trunk", () => {
    expect(buildEndpoint("1000")).toBe("PJSIP/1000");
  });

  it("builds PJSIP endpoint with trunk", () => {
    expect(buildEndpoint("1000", "trunk-1")).toBe("PJSIP/trunk-1/1000");
  });
});
