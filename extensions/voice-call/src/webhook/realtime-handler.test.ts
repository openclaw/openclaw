import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
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

const realtimeProvider: RealtimeVoiceProviderPlugin = {
  id: "openai",
  label: "OpenAI",
  isConfigured: () => true,
  createBridge: () => makeBridge(),
};

function makeHandler(overrides?: Partial<VoiceCallRealtimeConfig>) {
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
    } as unknown as VoiceCallProvider,
    realtimeProvider,
    { apiKey: "test-key" },
    "/voice/webhook",
  );
}

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
