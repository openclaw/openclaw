import { describe, expect, it } from "vitest";
import { createManagerHarness, FakeProvider } from "./manager.test-harness.js";

class FailFirstPlayTtsProvider extends FakeProvider {
  private failed = false;

  override async playTts(input: Parameters<FakeProvider["playTts"]>[0]): Promise<void> {
    this.playTtsCalls.push(input);
    if (!this.failed) {
      this.failed = true;
      throw new Error("synthetic tts failure");
    }
  }
}

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

  it("speaks initial message on answered for conversation mode with non-stream provider", async () => {
    const { manager, provider } = await createManagerHarness({}, new FakeProvider("plivo"));

    const { callId, success } = await manager.initiateCall("+15550000003", undefined, {
      message: "Hello from conversation",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-plivo",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Hello from conversation");
  });

  it("speaks initial message on answered for conversation mode when Twilio streaming is disabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: false } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000004", undefined, {
      message: "Twilio non-stream",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-twilio-no-stream",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Twilio non-stream");
  });

  it("waits for stream connect in conversation mode when Twilio streaming is enabled", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000005", undefined, {
      message: "Twilio stream",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-conversation-twilio-stream",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(provider.playTtsCalls).toHaveLength(0);
  });

  it("preserves initialMessage after a failed first playback and retries on next trigger", async () => {
    const provider = new FailFirstPlayTtsProvider("plivo");
    const { manager } = await createManagerHarness({}, provider);

    const { callId, success } = await manager.initiateCall("+15550000006", undefined, {
      message: "Retry me",
      mode: "notify",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-retry-1",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterFailure = manager.getCall(callId);
    expect(provider.playTtsCalls).toHaveLength(1);
    expect(afterFailure?.metadata?.initialMessage).toBe("Retry me");
    expect(afterFailure?.state).toBe("listening");

    manager.processEvent({
      id: "evt-retry-2",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const afterSuccess = manager.getCall(callId);
    expect(provider.playTtsCalls).toHaveLength(2);
    expect(afterSuccess?.metadata?.initialMessage).toBeUndefined();
  });

  it("speaks initial message only once on repeated stream-connect triggers", async () => {
    const { manager, provider } = await createManagerHarness(
      { streaming: { enabled: true } },
      new FakeProvider("twilio"),
    );

    const { callId, success } = await manager.initiateCall("+15550000007", undefined, {
      message: "Stream hello",
      mode: "conversation",
    });
    expect(success).toBe(true);

    manager.processEvent({
      id: "evt-stream-answered",
      type: "call.answered",
      callId,
      providerCallId: "call-uuid",
      timestamp: Date.now(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(provider.playTtsCalls).toHaveLength(0);

    await manager.speakInitialMessage("call-uuid");
    await manager.speakInitialMessage("call-uuid");

    expect(provider.playTtsCalls).toHaveLength(1);
    expect(provider.playTtsCalls[0]?.text).toBe("Stream hello");
  });
});
