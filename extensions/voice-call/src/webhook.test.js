import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { VoiceCallWebhookServer } from "./webhook.js";
const provider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:base" }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
  hangupCall: async () => {
  },
  playTts: async () => {
  },
  startListening: async () => {
  },
  stopListening: async () => {
  },
  getCallStatus: async () => ({ status: "in-progress", isTerminal: false })
};
const createConfig = (overrides = {}) => {
  const base = VoiceCallConfigSchema.parse({});
  base.serve.port = 0;
  return {
    ...base,
    ...overrides,
    serve: {
      ...base.serve,
      ...overrides.serve ?? {}
    }
  };
};
const createCall = (startedAt) => ({
  callId: "call-1",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt,
  transcript: [],
  processedEventIds: []
});
const createManager = (calls) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn();
  const manager = {
    getActiveCalls: () => calls,
    endCall,
    processEvent
  };
  return { manager, endCall, processEvent };
};
async function runStaleCallReaperCase(params) {
  const now = /* @__PURE__ */ new Date("2026-02-16T00:00:00Z");
  vi.setSystemTime(now);
  const call = createCall(now.getTime() - params.callAgeMs);
  const { manager, endCall } = createManager([call]);
  const config = createConfig({ staleCallReaperSeconds: params.staleCallReaperSeconds });
  const server = new VoiceCallWebhookServer(config, manager, provider);
  try {
    await server.start();
    await vi.advanceTimersByTimeAsync(params.advanceMs);
    return { call, endCall };
  } finally {
    await server.stop();
  }
}
async function postWebhookForm(server, baseUrl, body) {
  const address = server.server?.address?.();
  const requestUrl = new URL(baseUrl);
  if (address && typeof address === "object" && "port" in address && address.port) {
    requestUrl.port = String(address.port);
  }
  return await fetch(requestUrl.toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body
  });
}
describe("VoiceCallWebhookServer stale call reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it("ends calls older than staleCallReaperSeconds", async () => {
    const { call, endCall } = await runStaleCallReaperCase({
      callAgeMs: 12e4,
      staleCallReaperSeconds: 60,
      advanceMs: 3e4
    });
    expect(endCall).toHaveBeenCalledWith(call.callId);
  });
  it("skips calls that are younger than the threshold", async () => {
    const { endCall } = await runStaleCallReaperCase({
      callAgeMs: 1e4,
      staleCallReaperSeconds: 60,
      advanceMs: 3e4
    });
    expect(endCall).not.toHaveBeenCalled();
  });
  it("does not run when staleCallReaperSeconds is disabled", async () => {
    const now = /* @__PURE__ */ new Date("2026-02-16T00:00:00Z");
    vi.setSystemTime(now);
    const call = createCall(now.getTime() - 12e4);
    const { manager, endCall } = createManager([call]);
    const config = createConfig({ staleCallReaperSeconds: 0 });
    const server = new VoiceCallWebhookServer(config, manager, provider);
    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(6e4);
      expect(endCall).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
describe("VoiceCallWebhookServer path matching", () => {
  it("rejects lookalike webhook paths that only match by prefix", async () => {
    const verifyWebhook = vi.fn(() => ({ ok: true, verifiedRequestKey: "verified:req:prefix" }));
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const strictProvider = {
      ...provider,
      verifyWebhook,
      parseWebhookEvent
    };
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, strictProvider);
    try {
      const baseUrl = await server.start();
      const address = server.server?.address?.();
      const requestUrl = new URL(baseUrl);
      if (address && typeof address === "object" && "port" in address && address.port) {
        requestUrl.port = String(address.port);
      }
      requestUrl.pathname = "/voice/webhook-evil";
      const response = await fetch(requestUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "CallSid=CA123&SpeechResult=hello"
      });
      expect(response.status).toBe(404);
      expect(verifyWebhook).not.toHaveBeenCalled();
      expect(parseWebhookEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
describe("VoiceCallWebhookServer replay handling", () => {
  it("acknowledges replayed webhook requests and skips event side effects", async () => {
    const replayProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true, isReplay: true, verifiedRequestKey: "mock:req:replay" }),
      parseWebhookEvent: () => ({
        events: [
          {
            id: "evt-replay",
            dedupeKey: "stable-replay",
            type: "call.speech",
            callId: "call-1",
            providerCallId: "provider-call-1",
            timestamp: Date.now(),
            transcript: "hello",
            isFinal: true
          }
        ],
        statusCode: 200
      })
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, replayProvider);
    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");
      expect(response.status).toBe(200);
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
  it("passes verified request key from verifyWebhook into parseWebhookEvent", async () => {
    const parseWebhookEvent = vi.fn((_ctx, options) => ({
      events: [
        {
          id: "evt-verified",
          dedupeKey: options?.verifiedRequestKey,
          type: "call.speech",
          callId: "call-1",
          providerCallId: "provider-call-1",
          timestamp: Date.now(),
          transcript: "hello",
          isFinal: true
        }
      ],
      statusCode: 200
    }));
    const verifiedProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true, verifiedRequestKey: "verified:req:123" }),
      parseWebhookEvent
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, verifiedProvider);
    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");
      expect(response.status).toBe(200);
      expect(parseWebhookEvent).toHaveBeenCalledTimes(1);
      expect(parseWebhookEvent.mock.calls[0]?.[1]).toEqual({
        verifiedRequestKey: "verified:req:123"
      });
      expect(processEvent).toHaveBeenCalledTimes(1);
      expect(processEvent.mock.calls[0]?.[0]?.dedupeKey).toBe("verified:req:123");
    } finally {
      await server.stop();
    }
  });
  it("rejects requests when verification succeeds without a request key", async () => {
    const parseWebhookEvent = vi.fn(() => ({ events: [], statusCode: 200 }));
    const badProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true }),
      parseWebhookEvent
    };
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, badProvider);
    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");
      expect(response.status).toBe(401);
      expect(parseWebhookEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
describe("VoiceCallWebhookServer response normalization", () => {
  it("preserves explicit empty provider response bodies", async () => {
    const responseProvider = {
      ...provider,
      parseWebhookEvent: () => ({
        events: [],
        statusCode: 204,
        providerResponseBody: ""
      })
    };
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, responseProvider);
    try {
      const baseUrl = await server.start();
      const response = await postWebhookForm(server, baseUrl, "CallSid=CA123&SpeechResult=hello");
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
    } finally {
      await server.stop();
    }
  });
});
describe("VoiceCallWebhookServer start idempotency", () => {
  it("returns existing URL when start() is called twice without stop()", async () => {
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, provider);
    try {
      const firstUrl = await server.start();
      const secondUrl = await server.start();
      expect(firstUrl).toContain("/voice/webhook");
      expect(firstUrl).not.toContain(":0/");
      expect(secondUrl).toBe(firstUrl);
      expect(secondUrl).toContain("/voice/webhook");
    } finally {
      await server.stop();
    }
  });
  it("can start again after stop()", async () => {
    const { manager } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, provider);
    const firstUrl = await server.start();
    expect(firstUrl).toContain("/voice/webhook");
    await server.stop();
    const secondUrl = await server.start();
    expect(secondUrl).toContain("/voice/webhook");
    await server.stop();
  });
  it("stop() is safe to call when server was never started", async () => {
    const { manager } = createManager([]);
    const config = createConfig();
    const server = new VoiceCallWebhookServer(config, manager, provider);
    await server.stop();
  });
});
