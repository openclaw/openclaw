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

  it("defers initial TTS until media stream connects when streaming is enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true, openaiApiKey: "sk-test" } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000002", undefined, {
      message: "Hello there",
      mode: "notify",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-2-streaming",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Streaming: TTS must NOT fire on call.answered - media stream isn't connected yet
    expect(provider.playTtsCalls).toHaveLength(0);

    // Simulate media stream connect calling speakInitialMessage
    await manager.speakInitialMessage("call-uuid");

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello there");
  });

  it("speaks initial message on answered for non-streaming providers", async () => {
    const { manager, provider } = await createManagerHarness({}, new FakeProvider("plivo"));

    const { callId, success } = await manager.initiateCall("+15550000002", undefined, {
      message: "Hello there",
      mode: "notify",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-2-non-streaming",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    // Non-streaming: TTS fires immediately on call.answered
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello there");
  });
});
