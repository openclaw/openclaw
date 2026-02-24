import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceCallConfigSchema, type VoiceCallConfig } from "./config.js";
import type { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import type { CallRecord } from "./types.js";
import { VoiceCallWebhookServer } from "./webhook.js";

const provider: VoiceCallProvider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
  hangupCall: async () => {},
  playTts: async () => {},
  startListening: async () => {},
  stopListening: async () => {},
};

const createConfig = (overrides: Partial<VoiceCallConfig> = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({});
  base.serve.port = 0;

  return {
    ...base,
    ...overrides,
    serve: {
      ...base.serve,
      ...(overrides.serve ?? {}),
    },
  };
};

const createCall = (startedAt: number): CallRecord => ({
  callId: "call-1",
  providerCallId: "provider-call-1",
  provider: "mock",
  direction: "outbound",
  state: "initiated",
  from: "+15550001234",
  to: "+15550005678",
  startedAt,
  transcript: [],
  processedEventIds: [],
});

const createManager = (calls: CallRecord[]) => {
  const endCall = vi.fn(async () => ({ success: true }));
  const processEvent = vi.fn();
  const manager = {
    getActiveCalls: () => calls,
    endCall,
    processEvent,
  } as unknown as CallManager;

  return { manager, endCall, processEvent };
};

describe("VoiceCallWebhookServer stale call reaper", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("ends calls older than staleCallReaperSeconds", async () => {
    const now = new Date("2026-02-16T00:00:00Z");
    vi.setSystemTime(now);

    const call = createCall(now.getTime() - 120_000);
    const { manager, endCall } = createManager([call]);
    const config = createConfig({ staleCallReaperSeconds: 60 });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(endCall).toHaveBeenCalledWith(call.callId);
    } finally {
      await server.stop();
    }
  });

  it("skips calls that are younger than the threshold", async () => {
    const now = new Date("2026-02-16T00:00:00Z");
    vi.setSystemTime(now);

    const call = createCall(now.getTime() - 10_000);
    const { manager, endCall } = createManager([call]);
    const config = createConfig({ staleCallReaperSeconds: 60 });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(endCall).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });

  it("does not run when staleCallReaperSeconds is disabled", async () => {
    const now = new Date("2026-02-16T00:00:00Z");
    vi.setSystemTime(now);

    const call = createCall(now.getTime() - 120_000);
    const { manager, endCall } = createManager([call]);
    const config = createConfig({ staleCallReaperSeconds: 0 });
    const server = new VoiceCallWebhookServer(config, manager, provider);

    try {
      await server.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(endCall).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});

describe("VoiceCallWebhookServer replay handling", () => {
  it("acknowledges replayed webhook requests and skips event side effects", async () => {
    const replayProvider: VoiceCallProvider = {
      ...provider,
      verifyWebhook: () => ({ ok: true, isReplay: true }),
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
            isFinal: true,
          },
        ],
        statusCode: 200,
      }),
    };
    const { manager, processEvent } = createManager([]);
    const config = createConfig({ serve: { port: 0, bind: "127.0.0.1", path: "/voice/webhook" } });
    const server = new VoiceCallWebhookServer(config, manager, replayProvider);

    try {
      const baseUrl = await server.start();
      const address = (
        server as unknown as { server?: { address?: () => unknown } }
      ).server?.address?.();
      const requestUrl = new URL(baseUrl);
      if (address && typeof address === "object" && "port" in address && address.port) {
        requestUrl.port = String(address.port);
      }
      const response = await fetch(requestUrl.toString(), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: "CallSid=CA123&SpeechResult=hello",
      });

      expect(response.status).toBe(200);
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.stop();
    }
  });
});
