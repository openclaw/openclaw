import crypto from "node:crypto";
import type { AddressInfo, Server } from "node:net";
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
  const manager = {
    getActiveCalls: () => calls,
    endCall,
  } as unknown as CallManager;

  return { manager, endCall };
};

function resolveListeningPort(server: VoiceCallWebhookServer): number {
  const internalServer = (server as unknown as { server: Server | null }).server;
  const address = internalServer?.address();
  if (!address || typeof address === "string") {
    throw new Error("voice-call webhook server did not expose a TCP listening address");
  }
  return (address as AddressInfo).port;
}

function createWebhookRequestManager() {
  const processEvent = vi.fn();
  return {
    manager: {
      getActiveCalls: () => [],
      processEvent,
      getCallByProviderCallId: () => undefined,
    } as unknown as CallManager,
    processEvent,
  };
}

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

describe("VoiceCallWebhookServer replay protection", () => {
  it("drops replayed signed webhook requests before event processing", async () => {
    const { manager, processEvent } = createWebhookRequestManager();
    const replaySensitiveProvider: VoiceCallProvider = {
      name: "telnyx",
      verifyWebhook: () => ({ ok: true }),
      parseWebhookEvent: () => ({
        events: [
          {
            id: crypto.randomUUID(),
            type: "call.ringing",
            callId: "call-1",
            providerCallId: "provider-call-1",
            timestamp: Date.now(),
          },
        ],
      }),
      initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
      hangupCall: async () => {},
      playTts: async () => {},
      startListening: async () => {},
      stopListening: async () => {},
    };

    const config = createConfig({
      serve: {
        port: 0,
        bind: "127.0.0.1",
        path: "/voice/webhook",
      },
      staleCallReaperSeconds: 0,
    });

    const server = new VoiceCallWebhookServer(config, manager, replaySensitiveProvider);

    try {
      await server.start();
      const port = resolveListeningPort(server);
      const url = `http://127.0.0.1:${port}/voice/webhook`;
      const headers = {
        "content-type": "application/json",
        "telnyx-signature-ed25519": "signature-replay-test",
        "telnyx-timestamp": "1708041600",
      };
      const body = JSON.stringify({ data: { event_type: "call.ringing" } });

      const first = await fetch(url, { method: "POST", headers, body });
      expect(first.status).toBe(200);

      const second = await fetch(url, { method: "POST", headers, body });
      expect(second.status).toBe(200);

      expect(processEvent).toHaveBeenCalledTimes(1);
    } finally {
      await server.stop();
    }
  });
});
