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

function injectCall(manager: CallManager, call: CallRecord): void {
  const activeCalls = (manager as unknown as { activeCalls: Map<string, CallRecord> }).activeCalls;
  const providerCallIdMap = (manager as unknown as { providerCallIdMap: Map<string, string> })
    .providerCallIdMap;
  activeCalls.set(call.callId, call);
  providerCallIdMap.set(call.providerCallId!, call.callId);
}

describe("initial TTS timing", () => {
  it("fires TTS on call.answered even when streaming is enabled (fallback for non-streaming providers)", async () => {
    const storePath = path.join(os.tmpdir(), `openclaw-voice-tts-timing-${Date.now()}`);
    fs.mkdirSync(storePath, { recursive: true });

    const playTts = vi.fn(async () => {});
    const provider = createProvider({ playTts });

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "mock",
      fromNumber: "+15550001234",
      streaming: { enabled: true, openaiApiKey: "sk-test" },
    });

    const manager = new CallManager(config, storePath);
    await manager.initialize(provider, "http://localhost:4000/webhook");

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

    injectCall(manager, call);

    // TTS fires on call.answered as fallback (works for all providers including non-streaming)
    manager.processEvent({
      id: "evt-answered",
      type: "call.answered",
      callId: call.callId,
      providerCallId: call.providerCallId!,
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(playTts).toHaveBeenCalledTimes(1);

    // If onConnect also calls speakInitialMessage, it's a no-op (dedup via metadata deletion)
    await manager.speakInitialMessage(call.providerCallId!);
    expect(playTts).toHaveBeenCalledTimes(1);
  });

  it("fires TTS on call.answered when streaming is disabled", async () => {
    const storePath = path.join(os.tmpdir(), `openclaw-voice-tts-nonstream-${Date.now()}`);
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
      callId: "call-tts-nonstream",
      providerCallId: "provider-tts-nonstream",
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

    injectCall(manager, call);

    manager.processEvent({
      id: "evt-answered-nonstream",
      type: "call.answered",
      callId: call.callId,
      providerCallId: call.providerCallId!,
      timestamp: Date.now(),
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Non-streaming: TTS fires immediately on call.answered
    expect(playTts).toHaveBeenCalled();
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

    injectCall(manager, call);

    // This is the path webhook.ts onConnect takes - call speakInitialMessage
    // after the media stream is connected
    await manager.speakInitialMessage(call.providerCallId!);

    expect(playTts).toHaveBeenCalled();
  });
});
