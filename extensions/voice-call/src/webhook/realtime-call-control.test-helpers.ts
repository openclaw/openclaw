import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import type { CallManager } from "../manager.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";
import type { CallRecord } from "../types.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

export function makeCall(providerCallId: string, overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-1",
    providerCallId,
    provider: "twilio",
    direction: "inbound",
    state: "ringing",
    from: "+15550001234",
    to: "+15550009999",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
    ...overrides,
  };
}

export function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: vi.fn(),
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
    triggerGreeting: () => {},
    ...overrides,
  };
}

export function makeHandler(params: {
  call: CallRecord;
  createBridge: RealtimeVoiceProviderPlugin["createBridge"];
  endCall?: CallManager["endCall"];
  idleHangupMs?: number;
  nativeConsult?: boolean;
}) {
  const config = {
    ...createVoiceCallBaseConfig().realtime,
    enabled: true,
    instructions: "Be helpful.",
    ...(params.idleHangupMs ? { idleHangupMs: params.idleHangupMs } : {}),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge: params.createBridge,
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
      outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
      supportsBargeIn: true,
      ...(params.nativeConsult ? { handlesAgentConsult: true, supportsToolCalls: false } : {}),
    },
  };
  const processEvent = vi.fn(async () => ({ kind: "processed" }));
  const endCall = params.endCall ?? vi.fn(async () => ({ success: true }));
  const manager = {
    processEvent,
    updateCallMetadata: vi.fn(async (call: CallRecord, update) => {
      call.metadata = update(call.metadata);
    }),
    endCall,
    getCallForStream: vi.fn(async () => params.call),
    getCallByProviderCallId: vi.fn(() => params.call),
  } as unknown as CallManager;
  const handler = new RealtimeCallHandler(
    config,
    manager,
    () => ({
      agentId: "main",
      instructions: config.instructions,
      provider,
      providerConfig: { apiKey: "test-key" },
      capabilities: provider.capabilities,
    }),
    "/voice/webhook",
    { connect: () => {}, disconnect: () => {}, retire: () => {} },
  );
  handler.setPublicUrl("https://public.example/voice/webhook");
  return { handler, manager, processEvent, endCall };
}
