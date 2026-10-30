import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { onTestFinished, vi } from "vitest";
import type { CallManager } from "../manager.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";
import type { CallRecord } from "../types.js";
import { RealtimeCallHandler, type ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import { StreamDisconnectGrace } from "./stream-disconnect-grace.js";
export const updateCallMetadata: CallManager["updateCallMetadata"] = async (call, update) => {
  call.metadata = update(call.metadata);
};
export const createRealtimeConfig = () => ({
  ...createVoiceCallBaseConfig().realtime,
  enabled: true,
  instructions: "Be helpful.",
});
export const makeRealtimeProvider = (
  createBridge: RealtimeVoiceProviderPlugin["createBridge"],
  overrides: Partial<RealtimeVoiceProviderPlugin> = {},
): RealtimeVoiceProviderPlugin => ({
  id: "openai",
  label: "OpenAI",
  isConfigured: () => true,
  createBridge,
  ...overrides,
});

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
export function managedHandler(
  config: ConstructorParameters<typeof RealtimeCallHandler>[0],
  manager: CallManager,
  resolve: ResolveRealtimeCallRegistration,
  lifecycle = new StreamDisconnectGrace(() => {}),
) {
  const handler = new RealtimeCallHandler(config, manager, resolve, "/voice/webhook", lifecycle);
  onTestFinished(async () => {
    try {
      await handler.close();
    } finally {
      lifecycle.close();
    }
  });
  return handler;
}
export function makeHandler(params: {
  call: CallRecord;
  createBridge: RealtimeVoiceProviderPlugin["createBridge"];
  endCall?: CallManager["endCall"];
  idleHangupMs?: number;
  nativeConsult?: boolean;
}) {
  const config = {
    ...createRealtimeConfig(),
    ...(params.idleHangupMs ? { idleHangupMs: params.idleHangupMs } : {}),
  };
  const provider = makeRealtimeProvider(params.createBridge, {
    capabilities: {
      transports: ["gateway-relay"],
      inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
      outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
      supportsBargeIn: true,
      ...(params.nativeConsult ? { handlesAgentConsult: true, supportsToolCalls: false } : {}),
    },
  });
  const processEvent = vi.fn(async () => ({ kind: "processed" }));
  const endCall = params.endCall ?? vi.fn(async () => ({ success: true }));
  const manager = {
    processEvent,
    updateCallMetadata: vi.fn(updateCallMetadata),
    endCall,
    getCallForStream: vi.fn(async () => params.call),
    getCallByProviderCallId: vi.fn(() => params.call),
  } as unknown as CallManager;
  const handler = managedHandler(config, manager, () => ({
    agentId: "main",
    instructions: config.instructions,
    provider,
    providerConfig: { apiKey: "test-key" },
    capabilities: provider.capabilities,
  }));
  handler.setPublicUrl("https://public.example/voice/webhook");
  return { handler, manager, processEvent, endCall };
}
