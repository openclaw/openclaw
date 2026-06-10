// Voice Call tests cover realtime route-boundary matching.
import { describe, expect, it, vi } from "vitest";
import {
  VoiceCallConfigSchema,
  type VoiceCallConfig,
  type VoiceCallConfigInput,
} from "./config.js";
import type { CallManager } from "./manager.js";
import type { VoiceCallProvider } from "./providers/base.js";
import { VoiceCallWebhookServer } from "./webhook.js";
import type { RealtimeCallHandler } from "./webhook/realtime-handler.js";

const provider: VoiceCallProvider = {
  name: "mock",
  verifyWebhook: () => ({ ok: true, verifiedRequestKey: "mock:req:base" }),
  parseWebhookEvent: () => ({ events: [] }),
  initiateCall: async () => ({ providerCallId: "provider-call", status: "initiated" }),
  hangupCall: async () => {},
  playTts: async () => {},
  startListening: async () => {},
  stopListening: async () => {},
  getCallStatus: async () => ({ status: "in-progress", isTerminal: false }),
};

const manager = {
  getActiveCalls: () => [],
  endCall: vi.fn(async () => ({ success: true })),
  processEvent: vi.fn(),
} as unknown as CallManager;

const createConfig = (overrides: VoiceCallConfigInput = {}): VoiceCallConfig => {
  const base = VoiceCallConfigSchema.parse({});
  base.serve.port = 0;
  const merged = {
    ...base,
    ...overrides,
    serve: { ...base.serve, ...overrides.serve },
    realtime: {
      ...base.realtime,
      ...overrides.realtime,
      tools: overrides.realtime?.tools ?? base.realtime.tools,
      fastContext: {
        ...base.realtime.fastContext,
        ...overrides.realtime?.fastContext,
        sources: overrides.realtime?.fastContext?.sources ?? base.realtime.fastContext.sources,
      },
      agentContext: {
        ...base.realtime.agentContext,
        ...overrides.realtime?.agentContext,
        files: overrides.realtime?.agentContext?.files ?? base.realtime.agentContext.files,
      },
      providers: overrides.realtime?.providers ?? base.realtime.providers,
    },
  };
  const parsed = VoiceCallConfigSchema.parse({
    ...merged,
    serve: { ...merged.serve, port: merged.serve.port === 0 ? 1 : merged.serve.port },
  });
  parsed.serve.port = merged.serve.port;
  return parsed;
};

type UpgradeRequestDouble = { url?: string };
type RouteProbe = {
  isRealtimeWebSocketUpgrade: (request: UpgradeRequestDouble) => boolean;
};

const routeCases = [
  {
    name: "rejects a sibling path that only shares the same text prefix",
    pattern: "/voice/stream/realtime",
    path: "/voice/stream/realtime-evil/token",
    expected: false,
  },
  {
    name: "accepts a slash-delimited child token path",
    pattern: "/voice/stream/realtime",
    path: "/voice/stream/realtime/token",
    expected: true,
  },
  {
    name: "preserves root realtime stream child paths",
    pattern: "/",
    path: "/token",
    expected: true,
  },
];

describe("VoiceCallWebhookServer realtime route boundary", () => {
  it.each(routeCases)("$name", ({ pattern, path, expected }) => {
    const server = new VoiceCallWebhookServer(
      createConfig({
        serve: { path: "/voice/webhook" },
        realtime: { enabled: true, streamPath: pattern },
      }),
      manager,
      provider,
    );
    const realtimeHandler = {
      getStreamPathPattern: vi.fn(() => pattern),
    } as unknown as RealtimeCallHandler;
    server.setRealtimeHandler(realtimeHandler);

    const actual = (server as unknown as RouteProbe).isRealtimeWebSocketUpgrade({ url: path });

    expect(actual).toBe(expected);
  });
});
