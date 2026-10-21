import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { onTestFinished, vi } from "vitest";
import type { CallManager } from "../manager.js";
import { createVoiceCallBaseConfig } from "../test-fixtures.js";
import { connectWs, startUpgradeWsServer } from "../websocket-test-support.js";
import { makeBridge, makeCall } from "./realtime-call-control.test-helpers.js";
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

export function createBridge(
  close: RealtimeVoiceBridge["close"],
  overrides: Partial<RealtimeVoiceBridge> = {},
): RealtimeVoiceBridge {
  return makeBridge({ submitToolResult: () => {}, close, ...overrides });
}

export function makeRealtimeProvider(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
  overrides: Partial<RealtimeVoiceProviderPlugin> = {},
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge: createBridgeForCall,
    ...overrides,
  };
}

export function createCarrierLifecycleHarness(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
  options: {
    endCall?: CallManager["endCall"];
    initialMessage?: string;
    toolPolicy?: ReturnType<typeof createRealtimeConfig>["toolPolicy"];
    resolveCallRegistration?: ResolveRealtimeCallRegistration;
    streamDisconnectLifecycle?: StreamDisconnectGrace;
  } = {},
) {
  const realtimeProvider = makeRealtimeProvider(createBridgeForCall);
  const call = makeCall("CA-startup", {
    callId: "call-startup",
    metadata: options.initialMessage ? { initialMessage: options.initialMessage } : undefined,
  });
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const endCall = vi.fn(
    options.endCall ??
      (async (callId: string, endOptions?: { reason?: "completed" | "error" | "timeout" }) => {
        const reason = endOptions?.reason ?? "hangup-bot";
        try {
          // Preserve the carrier-settlement tick before publishing the terminal event.
          await Promise.resolve();
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
  const streamDisconnectLifecycle =
    options.streamDisconnectLifecycle ?? new StreamDisconnectGrace(() => {});
  const handler = new RealtimeCallHandler(
    {
      ...createRealtimeConfig(),
      ...(options.toolPolicy ? { toolPolicy: options.toolPolicy } : {}),
    },
    {
      processEvent,
      updateCallMetadata,
      endCall,
      getCallByProviderCallId: vi.fn(() => call),
    } as unknown as CallManager,
    options.resolveCallRegistration ??
      ((record) => ({
        agentId: record.agentId ?? "main",
        instructions: "Be helpful.",
        provider: realtimeProvider,
        providerConfig: { apiKey: "test-key" },
      })),
    "/voice/webhook",
    streamDisconnectLifecycle,
  );
  onTestFinished(async () => {
    try {
      await handler.close();
    } finally {
      streamDisconnectLifecycle.close();
    }
  });
  return { call, endCall, handler, processEvent };
}

export async function connectCarrierStream(handler: RealtimeCallHandler) {
  const { streamUrl } = handler.issueStreamSession();
  const server = await startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => handler.handleWebSocketUpgrade(request, socket, head),
  });
  const ws = await connectWs(server.url);
  onTestFinished(async () => {
    ws.terminate();
    await handler.close();
    await server.close();
  });
  return { server, ws };
}

export function sendCarrierStart(ws: WebSocket, streamSid: string, callSid: string | undefined) {
  ws.send(JSON.stringify({ event: "start", start: { streamSid, callSid } }));
}
