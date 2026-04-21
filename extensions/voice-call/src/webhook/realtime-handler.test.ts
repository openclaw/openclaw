import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

function makeRequest(url: string, host = "gateway.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = host ? { host } : {};
  return req;
}

function makeBridge(): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: () => {},
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
    triggerGreeting: () => {},
  };
}

function makeRealtimeProvider(
  createBridge: () => RealtimeVoiceBridge,
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge,
  };
}

function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    provider?: Partial<VoiceCallProvider>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
  },
) {
  return new RealtimeCallHandler(
    {
      enabled: true,
      streamPath: "/voice/stream/realtime",
      instructions: "Be helpful.",
      tools: [],
      providers: {},
      ...overrides,
    },
    {
      processEvent: vi.fn(),
      getCallByProviderCallId: vi.fn(),
      ...deps?.manager,
    } as unknown as CallManager,
    {
      name: "twilio",
      verifyWebhook: vi.fn(),
      parseWebhookEvent: vi.fn(),
      initiateCall: vi.fn(),
      hangupCall: vi.fn(),
      playTts: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      getCallStatus: vi.fn(),
      ...deps?.provider,
    } as unknown as VoiceCallProvider,
    deps?.realtimeProvider ?? makeRealtimeProvider(() => makeBridge()),
    { apiKey: "test-key" },
    "/voice/webhook",
  );
}

const startRealtimeServer = async (
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
    urlPath: match[1],
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
};

describe("RealtimeCallHandler path routing", () => {
  it("uses the request host and stream path in TwiML", () => {
    const handler = makeHandler();
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "gateway.ts.net"));

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toMatch(
      /wss:\/\/gateway\.ts\.net\/voice\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });

  it("preserves a public path prefix ahead of serve.path", () => {
    const handler = makeHandler({ streamPath: "/custom/stream/realtime" });
    handler.setPublicUrl("https://public.example/api/voice/webhook");
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "127.0.0.1:3334"));

    expect(handler.getStreamPathPattern()).toBe("/api/custom/stream/realtime");
    expect(payload.body).toMatch(
      /wss:\/\/public\.example\/api\/custom\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });
});

describe("RealtimeCallHandler initial message injection", () => {
  const waitForReadyCallback = async (
    getReady: () => (() => void) | undefined,
  ): Promise<() => void> => {
    for (let i = 0; i < 50; i += 1) {
      const ready = getReady();
      if (ready) {
        return ready;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Bridge onReady callback never registered");
  };

  it("injects outbound intent as persistent system context when bridge supports it", async () => {
    const sendSystemContext = vi.fn();
    const triggerGreeting = vi.fn();
    let readyCb: (() => void) | undefined;

    const createBridge = vi.fn((req: RealtimeVoiceBridgeCreateRequest) => {
      readyCb = req.onReady;
      const bridge: RealtimeVoiceBridge = {
        connect: async () => {},
        sendAudio: () => {},
        setMediaTimestamp: () => {},
        submitToolResult: () => {},
        acknowledgeMark: () => {},
        close: () => {},
        isConnected: () => true,
        triggerGreeting,
        sendSystemContext,
      };
      return bridge;
    });

    const callRecord: CallRecord = {
      callId: "call-outbound",
      providerCallId: "CA-outbound",
      provider: "twilio",
      direction: "outbound",
      state: "initiated",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: "Tell Nana dinner is at 6pm on Sunday.",
        mode: "conversation",
      },
    };

    const handler = makeHandler(undefined, {
      manager: {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => callRecord),
      },
      realtimeProvider: makeRealtimeProvider((req) => createBridge(req)),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-1", callSid: "CA-outbound" },
          }),
        );

        const ready = await waitForReadyCallback(() => readyCb);
        ready();

        expect(sendSystemContext).toHaveBeenCalledTimes(1);
        const [context, options] = sendSystemContext.mock.calls[0];
        expect(context).toMatch(/Tell Nana dinner is at 6pm on Sunday\./);
        expect(context).toMatch(/You initiated this call/);
        expect(options).toEqual({ speakFirst: true });
        // Verify the legacy fallback path didn't also fire.
        expect(triggerGreeting).not.toHaveBeenCalled();
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("falls back to triggerGreeting for bridges without sendSystemContext", async () => {
    const triggerGreeting = vi.fn();
    let readyCb: (() => void) | undefined;

    const createBridge = vi.fn((req: RealtimeVoiceBridgeCreateRequest) => {
      readyCb = req.onReady;
      const bridge: RealtimeVoiceBridge = {
        connect: async () => {},
        sendAudio: () => {},
        setMediaTimestamp: () => {},
        submitToolResult: () => {},
        acknowledgeMark: () => {},
        close: () => {},
        isConnected: () => true,
        triggerGreeting,
      };
      return bridge;
    });

    const callRecord: CallRecord = {
      callId: "call-inbound",
      providerCallId: "CA-inbound",
      provider: "twilio",
      direction: "inbound",
      state: "initiated",
      from: "+15550003333",
      to: "+15550004444",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {
        initialMessage: "Hello there, thanks for calling.",
        mode: "conversation",
      },
    };

    const handler = makeHandler(undefined, {
      manager: {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => callRecord),
      },
      realtimeProvider: makeRealtimeProvider((req) => createBridge(req)),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-2", callSid: "CA-inbound" },
          }),
        );

        const ready = await waitForReadyCallback(() => readyCb);
        ready();

        expect(triggerGreeting).toHaveBeenCalledTimes(1);
        const [instructions] = triggerGreeting.mock.calls[0];
        expect(instructions).toMatch(/Hello there, thanks for calling\./);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });
});

describe("RealtimeCallHandler websocket hardening", () => {
  it("rejects oversized pre-start frames before bridge setup", async () => {
    const createBridge = vi.fn(() => makeBridge());
    const processEvent = vi.fn();
    const getCallByProviderCallId = vi.fn();
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-oversized",
              callSid: "CA-oversized",
              padding: "A".repeat(300 * 1024),
            },
          }),
        );

        const closed = await waitForClose(ws);

        expect(closed.code).toBe(1009);
        expect(createBridge).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
        expect(getCallByProviderCallId).not.toHaveBeenCalled();
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });
});
