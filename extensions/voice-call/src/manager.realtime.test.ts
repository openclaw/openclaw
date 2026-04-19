import { describe, expect, it, vi } from "vitest";
import { createManagerHarness, FakeProvider } from "./manager.test-harness.js";

/**
 * Regression test for issue #68713:
 * Realtime voice bridge fails on outbound calls — status callback race
 * overwrites <Connect><Stream> TwiML.
 *
 * When realtime.enabled is true, the regular call path's speakInitialMessage
 * should be skipped because the realtime handler manages its own greeting
 * via onReady → triggerGreeting. Speaking here would overwrite the
 * TwiML <Connect><Stream> with a REST API <Say>, breaking the realtime bridge.
 */
describe("CallManager realtime mode", () => {
  it("should skip speakInitialMessage when realtime is enabled", async () => {
    const provider = new FakeProvider("twilio");
    const { manager } = await createManagerHarness(
      {
        enabled: true,
        provider: "twilio",
        fromNumber: "+15555555555",
        realtime: { enabled: true },
        streaming: { enabled: false },
      },
      provider,
    );

    const speakInitialMessageSpy = vi.spyOn(manager as any, "speakInitialMessage");

    // Simulate an answered call with initial message
    const callRecord = {
      callId: "test-call-id",
      providerCallId: "twilio-call-id",
      status: "answered" as const,
      direction: "outbound" as const,
      from: "+15555555555",
      to: "+15555555556",
      createdAt: Date.now(),
      metadata: {
        mode: "conversation",
        initialMessage: "Hello, this is a test message",
      },
    };

    // Access the private method for testing
    (manager as any).maybeSpeakInitialMessageOnAnswered(callRecord);

    // speakInitialMessage should NOT be called when realtime is enabled
    expect(speakInitialMessageSpy).not.toHaveBeenCalled();
  });

  it("should call speakInitialMessage when realtime is disabled", async () => {
    const provider = new FakeProvider("twilio");
    const { manager } = await createManagerHarness(
      {
        enabled: true,
        provider: "twilio",
        fromNumber: "+15555555555",
        realtime: { enabled: false },
        streaming: { enabled: false },
      },
      provider,
    );

    const speakInitialMessageSpy = vi.spyOn(manager as any, "speakInitialMessage");

    // Simulate an answered call with initial message
    const callRecord = {
      callId: "test-call-id",
      providerCallId: "twilio-call-id",
      status: "answered" as const,
      direction: "outbound" as const,
      from: "+15555555555",
      to: "+15555555556",
      createdAt: Date.now(),
      metadata: {
        mode: "conversation",
        initialMessage: "Hello, this is a test message",
      },
    };

    // Access the private method for testing
    (manager as any).maybeSpeakInitialMessageOnAnswered(callRecord);

    // speakInitialMessage should be called when realtime is disabled
    expect(speakInitialMessageSpy).toHaveBeenCalledWith("twilio-call-id");
  });

  it("should call speakInitialMessage when realtime config uses default (disabled)", async () => {
    const provider = new FakeProvider("twilio");
    const { manager } = await createManagerHarness(
      {
        enabled: true,
        provider: "twilio",
        fromNumber: "+15555555555",
        // realtime not specified — defaults to { enabled: false }
        streaming: { enabled: false },
      },
      provider,
    );

    const speakInitialMessageSpy = vi.spyOn(manager as any, "speakInitialMessage");

    // Simulate an answered call with initial message
    const callRecord = {
      callId: "test-call-id",
      providerCallId: "twilio-call-id",
      status: "answered" as const,
      direction: "outbound" as const,
      from: "+15555555555",
      to: "+15555555556",
      createdAt: Date.now(),
      metadata: {
        mode: "conversation",
        initialMessage: "Hello, this is a test message",
      },
    };

    // Access the private method for testing
    (manager as any).maybeSpeakInitialMessageOnAnswered(callRecord);

    // speakInitialMessage should be called when realtime is not enabled
    expect(speakInitialMessageSpy).toHaveBeenCalledWith("twilio-call-id");
  });
});
