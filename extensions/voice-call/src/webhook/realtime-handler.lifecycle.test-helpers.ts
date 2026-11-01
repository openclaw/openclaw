import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import type { WebSocket } from "openclaw/plugin-sdk/websocket-runtime";
import { onTestFinished, vi } from "vitest";
import type { CallManager } from "../manager.js";
import { connectWs, startUpgradeWsServer } from "../websocket-test-support.js";
import {
  createRealtimeConfig,
  makeBridge,
  makeCall,
  makeRealtimeProvider,
  managedHandler,
  updateCallMetadata,
} from "./realtime-call-control.test-helpers.js";
import type { RealtimeCallHandler, ResolveRealtimeCallRegistration } from "./realtime-handler.js";
import type { StreamDisconnectGrace } from "./stream-disconnect-grace.js";
export { createRealtimeConfig, makeRealtimeProvider, updateCallMetadata };
export function makeRequest(url: string, host = "gateway.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = host ? { host } : {};
  return req;
}
export function createBridge(
  close: RealtimeVoiceBridge["close"],
  overrides: Partial<RealtimeVoiceBridge> = {},
): RealtimeVoiceBridge {
  return makeBridge({ submitToolResult: () => {}, close, ...overrides });
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
  const handler = managedHandler(
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
    options.streamDisconnectLifecycle,
  );
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
