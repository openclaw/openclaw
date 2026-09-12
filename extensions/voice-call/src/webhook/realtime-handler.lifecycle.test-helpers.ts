import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { vi } from "vitest";
import type { CallManager } from "../manager.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";
import type { CallRecord, HangupCallInput } from "../types.js";
import { connectWs, startUpgradeWsServer } from "../websocket-test-support.js";
import { RealtimeCallHandler, type ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import type { StreamDisconnectLifecycle } from "./stream-disconnect-grace.js";

export const updateCallMetadata: CallManager["updateCallMetadata"] = async (call, update) => {
  call.metadata = update(call.metadata);
};

export const createRealtimeConfig = () => ({
  ...createVoiceCallBaseConfig().realtime,
  enabled: true,
  instructions: "Be helpful.",
});

export const noOpStreamDisconnectLifecycle: StreamDisconnectLifecycle = {
  connect: () => {},
  disconnect: () => {},
  retire: () => {},
};

export function createBridge(
  close: RealtimeVoiceBridge["close"],
  overrides: Partial<RealtimeVoiceBridge> = {},
): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: () => {},
    acknowledgeMark: () => {},
    close,
    isConnected: () => true,
    triggerGreeting: () => {},
    ...overrides,
  };
}

export function makeRealtimeProvider(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge: createBridgeForCall,
  };
}

export function makeCallRegistrationResolver(
  provider: RealtimeVoiceProviderPlugin,
): ResolveRealtimeCallRegistration {
  return (call) => ({
    agentId: call.agentId ?? "main",
    instructions: "Be helpful.",
    provider,
    providerConfig: { apiKey: "test-key" },
  });
}

export function createCarrierLifecycleHarness(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
  options: {
    endCall?: CallManager["endCall"];
    initialMessage?: string;
    resolveCallRegistration?: ResolveRealtimeCallRegistration;
    streamDisconnectLifecycle?: StreamDisconnectLifecycle;
  } = {},
) {
  const realtimeProvider = makeRealtimeProvider(createBridgeForCall);
  const call: CallRecord = {
    callId: "call-startup",
    providerCallId: "CA-startup",
    provider: "twilio",
    direction: "inbound",
    state: "ringing",
    from: "+15550001111",
    to: "+15550002222",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...(options.initialMessage ? { metadata: { initialMessage: options.initialMessage } } : {}),
  };
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const hangupCall = vi.fn(async (_input: HangupCallInput) => {});
  const endCall = vi.fn(
    options.endCall ??
      (async (callId: string, endOptions?: { reason?: "completed" | "error" | "timeout" }) => {
        const reason = endOptions?.reason ?? "hangup-bot";
        try {
          await hangupCall({ callId, providerCallId: call.providerCallId!, reason });
          await processEvent({
            id: `manager-ended-${call.providerCallId}`,
            type: "call.ended",
            callId,
            providerCallId: call.providerCallId,
            timestamp: Date.now(),
            reason,
          });
          return { success: true };
        } catch (error) {
          return { success: false, error: error instanceof Error ? error.message : String(error) };
        }
      }),
  );
  const handler = new RealtimeCallHandler(
    createRealtimeConfig(),
    {
      processEvent,
      updateCallMetadata,
      endCall,
      getCallByProviderCallId: vi.fn(() => call),
    } as unknown as CallManager,
    options.resolveCallRegistration ?? makeCallRegistrationResolver(realtimeProvider),
    "/voice/webhook",
    options.streamDisconnectLifecycle ?? noOpStreamDisconnectLifecycle,
  );
  return { call, endCall, handler, hangupCall, processEvent };
}

export async function connectCarrierStream(handler: RealtimeCallHandler) {
  const { streamUrl } = handler.issueStreamSession();
  const server = await startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
  return { server, ws: await connectWs(server.url) };
}
