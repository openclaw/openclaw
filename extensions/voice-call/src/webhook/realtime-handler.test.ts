import http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord } from "../types.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

/** Extract the stream token from a TwiML body string. */
function extractStreamToken(twiml: string): string | null {
  const match = twiml.match(/\/voice\/stream\/realtime\/([^"&\s]+)/);
  return match?.[1] ?? null;
}

// Minimal realtime config used across tests
const baseRealtimeConfig = {
  enabled: true,
  voice: "ash" as const,
  tools: [] as never[],
};

// Fake CallRecord for manager stubs
function makeCallRecord(overrides: Partial<CallRecord> = {}): CallRecord {
  return {
    callId: "call-rt-1",
    providerCallId: "CA_test",
    provider: "twilio",
    direction: "inbound",
    state: "answered",
    from: "+15550001234",
    to: "+15550005678",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {
      initialMessage: "Hello! How can I help you today?",
    },
    ...overrides,
  };
}

function makeManager(record?: CallRecord): CallManager {
  const storedRecord = record ?? makeCallRecord();
  return {
    processEvent: vi.fn(),
    getCallByProviderCallId: vi.fn(() => storedRecord),
    getCall: vi.fn(() => storedRecord),
  } as unknown as CallManager;
}

function makeProvider(): VoiceCallProvider {
  return {
    name: "twilio",
    verifyWebhook: vi.fn(() => ({ ok: true, verifiedRequestKey: "mock:key" })),
    parseWebhookEvent: vi.fn(() => ({ events: [] })),
    initiateCall: vi.fn(async () => ({ providerCallId: "CA_test", status: "initiated" as const })),
    hangupCall: vi.fn(async () => {}),
    playTts: vi.fn(async () => {}),
    startListening: vi.fn(async () => {}),
    stopListening: vi.fn(async () => {}),
    getCallStatus: vi.fn(async () => ({ status: "in-progress" as const, isTerminal: false })),
  };
}

function makeRequest(url: string, host = "example.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = { host };
  return req;
}

describe("RealtimeCallHandler", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // ---------------------------------------------------------------------------
  // buildTwiMLPayload
  // ---------------------------------------------------------------------------

  describe("buildTwiMLPayload", () => {
    it("returns TwiML <Connect><Stream> with wss URL derived from request host", () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );
      const req = makeRequest("/voice/webhook", "gateway.ts.net");
      const payload = handler.buildTwiMLPayload(req);

      expect(payload.statusCode).toBe(200);
      expect(payload.headers?.["Content-Type"]).toBe("text/xml");
      expect(payload.body).toContain("<Connect>");
      expect(payload.body).toContain("<Stream");
      expect(payload.body).toMatch(
        /wss:\/\/gateway\.ts\.net\/voice\/stream\/realtime\/[0-9a-f-]{36}/,
      );
    });

    it("falls back to localhost when no host header is present", () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );
      const req = makeRequest("/voice/webhook", "");
      const payload = handler.buildTwiMLPayload(req);

      expect(payload.body).toMatch(
        /wss:\/\/localhost:8443\/voice\/stream\/realtime\/[0-9a-f-]{36}/,
      );
    });

    it("embeds a unique token on each call", () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );
      const req = makeRequest("/voice/webhook", "host.example.com");
      const token1 = extractStreamToken(handler.buildTwiMLPayload(req).body);
      const token2 = extractStreamToken(handler.buildTwiMLPayload(req).body);
      expect(token1).toBeTruthy();
      expect(token2).toBeTruthy();
      expect(token1).not.toBe(token2);
    });
  });

  // ---------------------------------------------------------------------------
  // Stream token (nonce) validation
  // ---------------------------------------------------------------------------

  describe("stream token (nonce)", () => {
    it("issueStreamToken + consumeStreamToken: valid token accepted once then rejected", () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );
      const issue = (handler as unknown as { issueStreamToken: () => string }).issueStreamToken;
      const consume = (
        handler as unknown as {
          consumeStreamToken: (t: string) => { from?: string; to?: string } | null;
        }
      ).consumeStreamToken;
      const token = issue.call(handler);
      expect(consume.call(handler, token)).not.toBeNull();
      expect(consume.call(handler, token)).toBeNull();
    });

    it("rejects unknown tokens", () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );
      const consume = (
        handler as unknown as {
          consumeStreamToken: (t: string) => { from?: string; to?: string } | null;
        }
      ).consumeStreamToken;
      expect(consume.call(handler, "not-a-real-token")).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // registerCallInManager — greeting suppression
  // ---------------------------------------------------------------------------

  describe("registerCallInManager (via handleCall)", () => {
    it("clears metadata.initialMessage so the inboundGreeting TTS path is skipped", () => {
      const callRecord = makeCallRecord({
        metadata: { initialMessage: "Hello from config!" },
      });
      const manager = makeManager(callRecord);

      const handler = new RealtimeCallHandler(baseRealtimeConfig, manager, makeProvider(), null);

      // Access private method via type assertion for unit testing
      (
        handler as unknown as { registerCallInManager: (sid: string) => string }
      ).registerCallInManager("CA_test");

      // call.initiated + call.answered should both have been emitted
      expect(vi.mocked(manager.processEvent)).toHaveBeenCalledTimes(2);
      const eventTypes = vi
        .mocked(manager.processEvent)
        .mock.calls.map(([e]) => (e as { type: string }).type);
      expect(eventTypes).toEqual(["call.initiated", "call.answered"]);

      // initialMessage must be cleared before call.answered fires
      expect(callRecord.metadata?.initialMessage).toBeUndefined();
    });

    it("returns callId from the manager-created call record", () => {
      const callRecord = makeCallRecord({ callId: "manager-gen-id" });
      const manager = makeManager(callRecord);

      const handler = new RealtimeCallHandler(baseRealtimeConfig, manager, makeProvider(), null);

      const result = (
        handler as unknown as { registerCallInManager: (sid: string) => string }
      ).registerCallInManager("CA_test");

      expect(result).toBe("manager-gen-id");
    });

    it("falls back to providerCallId when manager has no record", () => {
      const manager = {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => undefined),
      } as unknown as CallManager;

      const handler = new RealtimeCallHandler(baseRealtimeConfig, manager, makeProvider(), null);

      const result = (
        handler as unknown as { registerCallInManager: (sid: string) => string }
      ).registerCallInManager("CA_fallback");

      expect(result).toBe("CA_fallback");
    });
  });

  // ---------------------------------------------------------------------------
  // Tool handler framework
  // ---------------------------------------------------------------------------

  describe("registerToolHandler", () => {
    it("routes tool calls to registered handlers and returns their result", async () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );

      handler.registerToolHandler("get_time", async () => ({ utc: "2026-03-10T00:00:00Z" }));

      const fakeSubmit = vi.fn();
      const fakeBridge = { submitToolResult: fakeSubmit } as never;

      await (
        handler as unknown as {
          executeToolCall: (
            bridge: never,
            callId: string,
            bridgeCallId: string,
            name: string,
            args: unknown,
          ) => Promise<void>;
        }
      ).executeToolCall(fakeBridge, "call-1", "bridge-call-1", "get_time", {});

      expect(fakeSubmit).toHaveBeenCalledWith("bridge-call-1", { utc: "2026-03-10T00:00:00Z" });
    });

    it("returns an error result for unregistered tool names", async () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );

      const fakeSubmit = vi.fn();
      const fakeBridge = { submitToolResult: fakeSubmit } as never;

      await (
        handler as unknown as {
          executeToolCall: (
            bridge: never,
            callId: string,
            bridgeCallId: string,
            name: string,
            args: unknown,
          ) => Promise<void>;
        }
      ).executeToolCall(fakeBridge, "call-1", "bridge-call-1", "unknown_tool", {});

      expect(fakeSubmit).toHaveBeenCalledWith("bridge-call-1", {
        error: 'Tool "unknown_tool" not available',
      });
    });

    it("returns an error result when a handler throws", async () => {
      const handler = new RealtimeCallHandler(
        baseRealtimeConfig,
        makeManager(),
        makeProvider(),
        null,
      );

      handler.registerToolHandler("boom", async () => {
        throw new Error("handler blew up");
      });

      const fakeSubmit = vi.fn();
      const fakeBridge = { submitToolResult: fakeSubmit } as never;

      await (
        handler as unknown as {
          executeToolCall: (
            bridge: never,
            callId: string,
            bridgeCallId: string,
            name: string,
            args: unknown,
          ) => Promise<void>;
        }
      ).executeToolCall(fakeBridge, "call-1", "bridge-call-1", "boom", {});

      expect(fakeSubmit).toHaveBeenCalledWith("bridge-call-1", { error: "handler blew up" });
    });
  });
});
