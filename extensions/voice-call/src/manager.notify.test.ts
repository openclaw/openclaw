import { describe, expect, it } from "vitest";
import { createManagerHarness, FakeProvider } from "./manager.test-harness.js";

describe("CallManager notify and mapping", () => {
  it("upgrades providerCallId mapping when provider ID changes", async () => {
    const { manager } = await createManagerHarness();

    const { callId, success, error } = await manager.initiateCall("+15550000001");
    expect(success).toBe(true);
    expect(error).toBeUndefined();

    expect(manager.getCall(callId)?.providerCallId).toBe("request-uuid");
    expect(manager.getCallByProviderCallId("request-uuid")?.callId).toBe(callId);

    manager.processEvent({
      id: "evt-1",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    expect(manager.getCall(callId)?.providerCallId).toBe("call-uuid");
    expect(manager.getCallByProviderCallId("call-uuid")?.callId).toBe(callId);
    expect(manager.getCallByProviderCallId("request-uuid")).toBeUndefined();
  });

  it.each(["plivo", "twilio"] as const)(
    "speaks initial message on answered for notify mode (%s)",
    async (providerName) => {
      const { manager, provider } = await createManagerHarness({}, new FakeProvider(providerName));

      const { callId, success } = await manager.initiateCall("+15550000002", undefined, {
        message: "Hello there",
        mode: "notify",
      });
      expect(success).toBe(true);

      manager.processEvent({
        id: `evt-2-${providerName}`,
        type: "call.answered",
        callId,
        providerCallId: "call-uuid",
        timestamp: Date.now(),
      });

      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(provider.playTtsCalls).toHaveLength(1);
      expect(provider.playTtsCalls[0]?.text).toBe("Hello there");
    },
  );

  it("defers initial message on answered for twilio conversation mode with streaming enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true, streamPath: "/voice/stream" } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000003", undefined, {
      message: "Hello there",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-3",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Initial message must not be spoken at answer time — stream is not yet connected.
    // The stream's onConnect handler is responsible for deferred playback.
    expect(provider.playTtsCalls).toHaveLength(0);
  });

  it("still speaks initial message on answered for non-twilio providers with streaming enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true, streamPath: "/voice/stream" } },
      new FakeProvider("plivo"),
    );

    const { callId, success } = await manager.initiateCall("+15550000004", undefined, {
      message: "Hello there",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-4",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Non-Twilio providers have no onConnect stream handler, so must speak at answer time.
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello there");
  });

  it("speaks initial message on answered for twilio notify mode even with streaming enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true, streamPath: "/voice/stream" } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000005", undefined, {
      message: "Hello there",
      mode: "notify",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-5",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Notify mode uses inline TwiML — no stream onConnect fires, so must speak at answer time.
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello there");
  });
});
