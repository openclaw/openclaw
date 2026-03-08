import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { CallRecord } from "./types.js";

function createProvider(overrides: Partial<VoiceCallProvider> = {}): VoiceCallProvider {
  return {
    name: "mock",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [] }),
    initiateCall: async () => ({ providerCallId: "provider-call-id", status: "initiated" }),
    hangupCall: async () => {},
    playTts: async () => {},
    startListening: async () => {},
    stopListening: async () => {},
    getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
    ...overrides,
  };
}

describe("initial TTS timing", () => {
  it("does not fire TTS on call.answered (before media stream connects)", async () => {
    const storePath = path.join(os.tmpdir(), `openclaw-voice-tts-timing-${Date.now()}`);
    fs.mkdirSync(storePath, { recursive: true });

    const playTts = vi.fn(async () => {});
    const provider = createProvider({ playTts });

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      fromNumber: "+15550001234",
    });

    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "http://localhost:4000/webhook");

    // Simulate an outbound call with an initial message already in state
    // (this mirrors what initiateCall sets up before the provider answers)
    const call: CallRecord = {
      callId: "call-tts-race",
      providerCallId: "provider-tts-race",
      provider: "mock",
      direction: "outbound",
      state: "ringing",
      from: "+15550001234",
      to: "+15550009999",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: { initialMessage: "Hello, this is a test call." },
    };

    // Inject the call into the manager's active calls via processEvent
    // to set up the providerCallIdMap correctly
    const activeCalls = (manager as unknown as { activeCalls: Map<string, CallRecord> })
      .activeCalls;
    const providerCallIdMap = (manager as unknown as { providerCallIdMap: Map<string, string> })
      .providerCallIdMap;
    activeCalls.set(call.callId, call);
    providerCallIdMap.set(call.providerCallId!, call.callId);

    // Process call.answered event - this should NOT trigger TTS
    manager.processEvent({
      id: "evt-answered",
      type: "call.answered",
      callId: call.callId,
      providerCallId: call.providerCallId!,
      timestamp: Date.now(),
    });

    // Give any async/void calls a chance to settle
    await new Promise((resolve) => setTimeout(resolve, 50));

    // TTS must not have been called - the media stream hasn't connected yet
    expect(playTts).not.toHaveBeenCalled();

    // The initial message must still be present (not consumed prematurely)
    const updatedCall = manager.getCall(call.callId);
    expect(updatedCall?.metadata?.initialMessage).toBe("Hello, this is a test call.");
  });

  it("fires TTS when speakInitialMessage is called after media stream connects", async () => {
    const storePath = path.join(os.tmpdir(), `openclaw-voice-tts-connect-${Date.now()}`);
    fs.mkdirSync(storePath, { recursive: true });

    const playTts = vi.fn(async () => {});
    const provider = createProvider({ playTts });

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      fromNumber: "+15550001234",
    });

    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "http://localhost:4000/webhook");

    const call: CallRecord = {
      callId: "call-tts-connect",
      providerCallId: "provider-tts-connect",
      provider: "mock",
      direction: "outbound",
      state: "answered",
      from: "+15550001234",
      to: "+15550009999",
      startedAt: Date.now(),
      answeredAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: { initialMessage: "Hello, this is a test call." },
    };

    const activeCalls = (manager as unknown as { activeCalls: Map<string, CallRecord> })
      .activeCalls;
    const providerCallIdMap = (manager as unknown as { providerCallIdMap: Map<string, string> })
      .providerCallIdMap;
    activeCalls.set(call.callId, call);
    providerCallIdMap.set(call.providerCallId!, call.callId);

    // This is the path webhook.ts onConnect takes - call speakInitialMessage
    // after the media stream is connected
    await manager.speakInitialMessage(call.providerCallId!);

    expect(playTts).toHaveBeenCalled();
  });
});
