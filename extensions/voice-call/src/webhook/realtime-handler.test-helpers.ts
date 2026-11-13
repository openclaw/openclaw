import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { rawDataToString } from "openclaw/plugin-sdk/webhook-ingress";
import { WebSocket, type RawData } from "openclaw/plugin-sdk/websocket-runtime";
import { expect, onTestFinished, vi } from "vitest";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { CallRecord } from "../types.js";
import {
  connectWs as openWebSocket,
  startUpgradeWsServer as openUpgradeServer,
  waitForClose,
} from "../websocket-test-support.js";
import { makeBridge, makeCall as makeCallRecord } from "./realtime-call-control.test-helpers.js";
import { RealtimeCallHandler } from "./realtime-handler.js";
import {
  createRealtimeConfig,
  makeRequest,
  makeRealtimeProvider,
  updateCallMetadata,
  sendCarrierStart,
} from "./realtime-handler.lifecycle.test-helpers.js";
import { StreamDisconnectGrace } from "./stream-disconnect-grace.js";

const cleanup: Array<() => void | Promise<void>> = [];
export async function closeCallHarnessTransports() {
  for (const close of cleanup.splice(0).toReversed()) {
    await close();
  }
}

export async function connectWs(url: string) {
  const ws = await openWebSocket(url);
  cleanup.push(async () => {
    if (ws.readyState !== WebSocket.CLOSED) {
      const closed = waitForClose(ws);
      ws.close();
      await closed;
    }
  });
  return ws;
}

async function startUpgradeWsServer(params: Parameters<typeof openUpgradeServer>[0]) {
  const server = await openUpgradeServer(params);
  cleanup.push(server.close);
  return server;
}

export async function startRealtimeServer(handler: RealtimeCallHandler, params?: URLSearchParams) {
  const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook"), params);
  const streamUrl = expectDefined(payload.body.match(/wss:\/\/[^" ]+/)?.[0], "realtime stream URL");
  return startStreamSessionServer(handler, streamUrl);
}

export async function startStreamSessionServer(handler: RealtimeCallHandler, streamUrl: string) {
  return startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => handler.handleWebSocketUpgrade(request, socket, head),
  });
}

export async function waitFor(
  callback: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
) {
  await vi.waitFor(callback, { interval: 1, ...options });
}

export async function waitForCalls(mock: unknown, count = 1) {
  await waitFor(() => expect(mock).toHaveBeenCalledTimes(count));
}

export type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
export function makeCallHarness(
  bridge:
    | Partial<RealtimeVoiceBridge>
    | ((request: RealtimeBridgeRequest, index: number) => RealtimeVoiceBridge) = {},
  options: {
    call?: CallRecord;
    config?: Partial<VoiceCallRealtimeConfig>;
    deps?: {
      manager?: Partial<CallManager>;
      providerConfig?: Record<string, unknown>;
      realtimeProvider?: RealtimeVoiceProviderPlugin;
      resolveInstructions?: (call: CallRecord) => string;
      streamDisconnectLifecycle?: StreamDisconnectGrace;
    };
  } = {},
) {
  const call = options.call ?? makeCallRecord("CA-test");
  const calls = new Map([[call.providerCallId, call]]);
  const getCallByProviderCallId = (id: string) => {
    if (options.call) {
      return options.call;
    }
    const record = calls.get(id) ?? makeCallRecord(id);
    calls.set(id, record);
    return record;
  };
  const callbacks: RealtimeBridgeRequest[] = [];
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const endCall = vi.fn(async () => ({ success: true }));
  const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
    callbacks.push(request);
    return typeof bridge === "function"
      ? bridge(request, callbacks.length - 1)
      : makeBridge(bridge);
  });
  const config = { ...createRealtimeConfig(), ...options.config };
  const streamDisconnectLifecycle =
    options.deps?.streamDisconnectLifecycle ?? new StreamDisconnectGrace(() => {});
  const provider = {
    ...makeRealtimeProvider(createBridge),
    ...options.deps?.realtimeProvider,
    createBridge,
  };
  const handler = new RealtimeCallHandler(
    config,
    {
      processEvent,
      endCall,
      updateCallMetadata,
      getCallForStream: vi.fn<CallManager["getCallForStream"]>(async () => undefined),
      getCallByProviderCallId,
      ...options.deps?.manager,
    } as unknown as CallManager,
    (record) => ({
      agentId: record.agentId ?? "main",
      provider,
      providerConfig: options.deps?.providerConfig ?? { apiKey: "test-key" },
      instructions: options.deps?.resolveInstructions?.(record) ?? config.instructions,
    }),
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
  async function start(streamId = "MZ-test", providerCallId = call.providerCallId) {
    const count = callbacks.length;
    const ws = await connectWs((await startRealtimeServer(handler)).url);
    sendCarrierStart(ws, streamId, providerCallId);
    await waitFor(() => expect(callbacks).toHaveLength(count + 1));
    return { ws, callbacks: expectDefined(callbacks[count], "provider callbacks") };
  }
  return { call, handler, callbacks, createBridge, processEvent, endCall, start };
}

export function resetContinuity(callbacks: RealtimeBridgeRequest | undefined) {
  expectDefined(callbacks, "provider callbacks").onEvent?.({
    direction: "client",
    type: "session.continuity.reset",
  });
}

export function parseWebSocketMessage(data: RawData): Record<string, unknown> {
  return JSON.parse(rawDataToString(data, "utf8")) as Record<string, unknown>;
}
