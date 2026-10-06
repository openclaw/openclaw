import type http from "node:http";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];

afterEach(() => {
  vi.useRealTimers();
});

function makeCall(providerCallId: string, overrides: Partial<CallRecord> = {}): CallRecord {
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

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
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

function makeHandler(params: {
  call: CallRecord;
  createBridge: RealtimeVoiceProviderPlugin["createBridge"];
  endCall?: CallManager["endCall"];
  idleHangupMs?: number;
  nativeConsult?: boolean;
}) {
  const config = {
    enabled: true,
    streamPath: "/voice/stream/realtime",
    instructions: "Be helpful.",
    toolPolicy: "safe-read-only",
    consultPolicy: "auto",
    tools: [],
    fastContext: {
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    },
    agentContext: {
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    },
    providers: {},
    ...(params.idleHangupMs ? { idleHangupMs: params.idleHangupMs } : {}),
  } satisfies VoiceCallRealtimeConfig;
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
  const manager = {
    processEvent: vi.fn(async () => ({ kind: "processed" })),
    updateCallMetadata: vi.fn(async (call: CallRecord, update) => {
      call.metadata = update(call.metadata);
    }),
    endCall: params.endCall ?? vi.fn(async () => ({ success: true })),
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
    undefined,
  );
  handler.setPublicUrl("https://public.example/voice/webhook");
  return { handler, manager };
}

async function openCall(params: {
  call: CallRecord;
  handler: RealtimeCallHandler;
  providerCallId: string;
}) {
  const stream = params.handler.issueStreamSession({
    providerName: "twilio",
    callId: params.call.callId,
    direction: params.call.direction,
  });
  const server = await startUpgradeWsServer({
    urlPath: new URL(stream.streamUrl).pathname,
    onUpgrade: (request: http.IncomingMessage, socket, head) => {
      params.handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
  const ws = await connectWs(server.url);
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
  ws.send(
    JSON.stringify({
      event: "start",
      start: { streamSid: `MZ-${params.providerCallId}`, callSid: params.providerCallId },
    }),
  );
  return { server, ws };
}

async function closeCall(
  handler: RealtimeCallHandler,
  server: { close: () => Promise<void> },
  ws: WebSocket,
) {
  if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
    const closed = waitForClose(ws);
    ws.close();
    await closed;
  }
  await handler.close();
  await server.close();
}

describe("realtime call control over the Twilio stream", () => {
  it("keeps a native consult running when far-side speech arrives during silent model output", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const receivedAudio = createDeferred<void>();
    const consultStarted = createDeferred<AbortSignal | undefined>();
    const consultResult = createDeferred<{ text: string }>();
    const handleBargeIn = vi.fn();
    const call = makeCall("CA-silent-consult");
    let inputFrames = 0;
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({
        handleBargeIn,
        sendAudio: () => {
          if (++inputFrames === 4) {
            receivedAudio.resolve();
          }
        },
      });
    });
    const { handler } = makeHandler({ call, createBridge, nativeConsult: true });
    handler.registerToolHandler("openclaw_agent_consult", (_args, _callId, context) => {
      consultStarted.resolve(context?.abortSignal);
      return consultResult.promise;
    });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-silent-consult" });
    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      vi.useFakeTimers();
      const pending = callbacks?.runAgentConsult?.({ prompt: "Check reservation availability" });
      const signal = await consultStarted.promise;
      callbacks?.onAudio?.(Buffer.alloc(160, 0xff));
      for (let i = 0; i < 4; i += 1) {
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
          }),
        );
      }
      await receivedAudio.promise;
      expect(handleBargeIn).not.toHaveBeenCalled();
      expect(signal?.aborted).toBe(false);
      consultResult.resolve({ text: "Reservations are available" });
      await expect(pending).resolves.toEqual({ text: "Reservations are available" });
    } finally {
      consultResult.resolve({ text: "Finished" });
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("pauses speech-idle hang-up while an agent consult is in flight", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const endCall = vi.fn(async () => ({ success: true }));
    const call = makeCall("CA-idle");
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge();
    });
    const { handler } = makeHandler({ call, createBridge, endCall, idleHangupMs: 1_000 });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-idle" });

    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      const consulted = createDeferred<{ text: string }>();
      handler.registerToolHandler("openclaw_agent_consult", () => consulted.promise);
      vi.useFakeTimers();
      callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      callbacks?.onToolCall?.({
        itemId: "consult-idle",
        callId: "consult-idle",
        name: "openclaw_agent_consult",
        args: { question: "Check it" },
      } satisfies RealtimeVoiceToolCallEvent);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(endCall).not.toHaveBeenCalled();
      consulted.resolve({ text: "Done" });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(endCall).toHaveBeenCalledWith("call-1", { reason: "timeout" });
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("keeps the call alive while buffered assistant audio is still playing out", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const endCall = vi.fn(async () => ({ success: true }));
    const call = makeCall("CA-playout");
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge();
    });
    const { handler } = makeHandler({ call, createBridge, endCall, idleHangupMs: 1_000 });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-playout" });

    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      vi.useFakeTimers();
      // Three seconds of loud 8 kHz mu-law arrive at once; the pacer plays them out over time.
      const loud = Buffer.alloc(24_000);
      for (let index = 0; index < loud.length; index += 2) {
        loud[index] = 0x00;
        loud[index + 1] = 0x80;
      }
      callbacks?.onAudio(loud);
      await vi.advanceTimersByTimeAsync(2_500);
      expect(endCall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(endCall).toHaveBeenCalledWith("call-1", { reason: "timeout" });
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("keeps the call alive during sustained caller speech and ends after silence", async () => {
    let receivedFrame = createDeferred<void>();
    const endCall = vi.fn(async () => ({ success: true }));
    const call = makeCall("CA-sustained-speech");
    const createBridge = vi.fn((_request: RealtimeBridgeRequest) =>
      makeBridge({
        sendAudio: () => receivedFrame.resolve(),
      }),
    );
    const { handler } = makeHandler({ call, createBridge, endCall, idleHangupMs: 1_000 });
    const { server, ws } = await openCall({
      call,
      handler,
      providerCallId: "CA-sustained-speech",
    });

    try {
      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledOnce());
      vi.useFakeTimers();
      const loudFrame = Buffer.alloc(160, 0x00).toString("base64");
      for (let index = 0; index < 5; index += 1) {
        receivedFrame = createDeferred<void>();
        ws.send(JSON.stringify({ event: "media", media: { payload: loudFrame } }));
        await receivedFrame.promise;
        await vi.advanceTimersByTimeAsync(600);
        expect(endCall).not.toHaveBeenCalled();
      }

      await vi.advanceTimersByTimeAsync(399);
      expect(endCall).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1", { reason: "timeout" });
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("waits for outbound speech and cancels the independent greeting fallback", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const triggerGreeting = vi.fn();
    const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
    const call = makeCall("CA-opening", {
      direction: "outbound",
      metadata: { initialMessage: opening },
    });
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ triggerGreeting });
    });
    const { handler } = makeHandler({ call, createBridge, nativeConsult: true });
    const { server, ws } = await openCall({ call, handler, providerCallId: "CA-opening" });

    try {
      await vi.waitFor(() => expect(callbacks).toBeDefined());
      expect(createBridge.mock.calls[0]?.[0].instructions).toContain(
        `Answer: ${JSON.stringify(opening)}`,
      );
      vi.useFakeTimers();
      callbacks?.onReady?.();
      callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
      await vi.advanceTimersByTimeAsync(3_000);
      expect(triggerGreeting).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      await closeCall(handler, server, ws);
    }
  });

  it("keeps function-tool outbound greetings immediate with the original instructions", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const triggerGreeting = vi.fn();
    const opening = "Buenas tardes. ¿A qué hora cierran hoy?";
    const call = makeCall("CA-function-tool-opening", {
      direction: "outbound",
      metadata: { initialMessage: opening },
    });
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ triggerGreeting });
    });
    const { handler } = makeHandler({ call, createBridge });
    const { server, ws } = await openCall({
      call,
      handler,
      providerCallId: "CA-function-tool-opening",
    });

    try {
      await vi.waitFor(() => expect(createBridge).toHaveBeenCalledOnce());
      const request = createBridge.mock.calls[0]?.[0];
      expect(request?.instructions).toBe("Be helpful.");
      callbacks?.onReady?.();
      expect(triggerGreeting).toHaveBeenCalledExactlyOnceWith(
        `Be helpful.\n\nStart the call by greeting the caller naturally. Include this greeting in your first spoken reply: "${opening}"`,
      );
    } finally {
      await closeCall(handler, server, ws);
    }
  });
});
