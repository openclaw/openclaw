import http from "node:http";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { expect, onTestFinished, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";
import { StreamDisconnectGrace } from "./stream-disconnect-grace.js";

const updateCallMetadata: CallManager["updateCallMetadata"] = async (call, update) => {
  call.metadata = update(call.metadata);
};

export function makeRequest(url: string, host = "gateway.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = host ? { host } : {};
  return req;
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

export function makeRealtimeProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"],
  overrides: Partial<RealtimeVoiceProviderPlugin> = {},
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge,
    ...overrides,
  };
}

const PROVIDER_BARGE_IN_CAPABILITIES = {
  transports: ["gateway-relay"],
  inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  supportsBargeIn: true,
  handlesInputAudioBargeIn: true,
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;

const PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES = {
  transports: ["gateway-relay"],
  inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  supportsBargeIn: true,
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;

function makeCallRegistrationResolver(params: {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: Record<string, unknown>;
  instructions: string;
  resolveInstructions?: (call: CallRecord) => string;
}) {
  return (call: CallRecord) => ({
    agentId: call.agentId ?? "main",
    provider: params.provider,
    providerConfig: params.providerConfig,
    instructions: params.resolveInstructions?.(call) ?? params.instructions,
  });
}

export function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    providerConfig?: Record<string, unknown>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
    resolveInstructions?: (call: CallRecord) => string;
    streamDisconnectLifecycle?: {
      connect: (providerCallId: string, streamId: string) => void;
      disconnect: (providerCallId: string, streamId: string) => void;
      retire: (providerCallId: string, streamId: string) => void;
    };
  },
) {
  const config: VoiceCallRealtimeConfig = {
    enabled: true,
    streamPath: overrides?.streamPath ?? "/voice/stream/realtime",
    instructions: overrides?.instructions ?? "Be helpful.",
    toolPolicy: overrides?.toolPolicy ?? "safe-read-only",
    consultPolicy: overrides?.consultPolicy ?? "auto",
    tools: overrides?.tools ?? [],
    fastContext: overrides?.fastContext ?? {
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    },
    agentContext: overrides?.agentContext ?? {
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    },
    providers: overrides?.providers ?? {},
    ...(overrides?.provider ? { provider: overrides.provider } : {}),
  };
  const realtimeProvider = deps?.realtimeProvider ?? makeRealtimeProvider(() => makeBridge());
  const providerConfig = deps?.providerConfig ?? { apiKey: "test-key" };
  const handler = new RealtimeCallHandler(
    config,
    {
      processEvent: vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" })),
      updateCallMetadata,
      endCall: vi.fn(async () => ({ success: true })),
      getCallForStream: vi.fn<CallManager["getCallForStream"]>(async () => undefined),
      getCallByProviderCallId: vi.fn(),
      ...deps?.manager,
    } as unknown as CallManager,
    makeCallRegistrationResolver({
      provider: realtimeProvider,
      providerConfig,
      instructions: config.instructions,
      resolveInstructions: deps?.resolveInstructions,
    }),
    "/voice/webhook",
    deps?.streamDisconnectLifecycle ?? {
      connect: () => {},
      disconnect: () => {},
      retire: () => {},
    },
    undefined,
  );
  onTestFinished(() => handler.close());
  return handler;
}

export const startRealtimeServer = async (
  handler: RealtimeCallHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook"));
  const match = payload.body.match(/wss:\/\/[^/]+(\/[^"]+)/);
  if (!match) {
    throw new Error("Failed to extract realtime stream path");
  }

  return await startUpgradeWsServer({
    urlPath: expectDefined(match[1], "realtime stream path"),
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
};

export const startStreamSessionServer = async (
  handler: RealtimeCallHandler,
  streamUrl: string,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  return await startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
};

export async function waitForRealtimeTest(
  callback: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
) {
  await vi.waitFor(callback, { interval: 1, ...options });
}

export type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
type RecentTalkEvent = { turnId?: string; type: string };

export function makeCallRecord(providerCallId: string): CallRecord {
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
  };
}

export function createCallRecordLookup() {
  const calls = new Map<string, CallRecord>();
  return vi.fn((providerCallId: string) => {
    let call = calls.get(providerCallId);
    if (!call) {
      call = makeCallRecord(providerCallId);
      calls.set(providerCallId, call);
    }
    return call;
  });
}

export function createFinalizingStreamGrace(
  processEvent: CallManager["processEvent"],
  eventId: string,
) {
  let finalization: ReturnType<CallManager["processEvent"]> | undefined;
  onTestFinished(async () => {
    await finalization;
  });
  return new StreamDisconnectGrace(({ providerCallId }) => {
    finalization = processEvent({
      id: eventId,
      type: "call.ended",
      callId: "call-1",
      providerCallId,
      timestamp: Date.now(),
      reason: "completed",
    });
    void finalization.catch(() => {});
  });
}

export function parseWebSocketMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

export async function withBargeInHarness(
  params: {
    bridgeHandlesInputAudioBargeIn?: boolean;
    handlesProviderBargeIn?: boolean;
    interruptResponseOnInputAudio?: boolean;
    providerCallId: string;
  },
  run: (harness: {
    callbacks: RealtimeBridgeRequest;
    call: CallRecord;
    createBridge: ReturnType<typeof vi.fn>;
    handleBargeIn: ReturnType<typeof vi.fn>;
    outboundMessages: Array<Record<string, unknown>>;
    processEvent: ReturnType<typeof vi.fn>;
    handler: RealtimeCallHandler;
    sendAudio: ReturnType<typeof vi.fn>;
    ws: WebSocket;
  }) => Promise<void>,
): Promise<void> {
  let callbacks: RealtimeBridgeRequest | undefined;
  const sendAudio = vi.fn();
  const handleBargeIn = vi.fn();
  const processEvent = vi.fn<CallManager["processEvent"]>(async () => ({ kind: "processed" }));
  const call = makeCallRecord(params.providerCallId);
  const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
    callbacks = request;
    return makeBridge({
      handleBargeIn,
      sendAudio,
      ...(params.bridgeHandlesInputAudioBargeIn === undefined
        ? {}
        : { handlesInputAudioBargeIn: params.bridgeHandlesInputAudioBargeIn }),
    });
  });
  const capabilities = params.handlesProviderBargeIn
    ? PROVIDER_BARGE_IN_CAPABILITIES
    : PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES;
  const handler = makeHandler(undefined, {
    manager: {
      getCallByProviderCallId: vi.fn((): CallRecord => call),
      processEvent,
    },
    providerConfig: {
      apiKey: "test-key",
      ...(params.interruptResponseOnInputAudio === undefined
        ? {}
        : { interruptResponseOnInputAudio: params.interruptResponseOnInputAudio }),
    },
    realtimeProvider: makeRealtimeProvider(createBridge, {
      capabilities,
      id: params.handlesProviderBargeIn ? "openai" : "test",
    }),
  });
  const server = await startRealtimeServer(handler);

  try {
    const ws = await connectWs(server.url);
    const outboundMessages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => outboundMessages.push(parseWebSocketMessage(data)));
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: `MZ-${params.providerCallId}`, callSid: params.providerCallId },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalled());
      if (!callbacks) {
        throw new Error("expected realtime bridge callbacks");
      }
      await run({
        callbacks,
        call,
        createBridge,
        handleBargeIn,
        outboundMessages,
        processEvent,
        handler,
        sendAudio,
        ws,
      });
    } finally {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
    }
  } finally {
    await server.close();
  }
}

export function recentTalkEvents(call: CallRecord): RecentTalkEvent[] {
  return (call.metadata?.recentTalkEvents as RecentTalkEvent[] | undefined) ?? [];
}

export function requireCancelledTurn(call: CallRecord): RecentTalkEvent & { turnId: string } {
  const cancelled = recentTalkEvents(call).find((event) => event.type === "turn.cancelled");
  if (!cancelled?.turnId) {
    throw new Error("expected barge-in to cancel the active turn");
  }
  return cancelled as RecentTalkEvent & { turnId: string };
}
