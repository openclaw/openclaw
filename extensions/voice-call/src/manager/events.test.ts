import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";

function createContext(overrides: Partial<CallManagerContext> = {}): CallManagerContext {
  const storePath = path.join(os.tmpdir(), `openclaw-voice-call-events-test-${Date.now()}`);
  fs.mkdirSync(storePath, { recursive: true });
  return {
    activeCalls: new Map(),
    providerCallIdMap: new Map(),
    processedEventIds: new Set(),
    rejectedProviderCallIds: new Set(),
    provider: null,
    config: VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    }),
    storePath,
    webhookUrl: null,
    activeTurnCalls: new Set(),
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    ...overrides,
  };
}

function createProvider(overrides: Partial<VoiceCallProvider> = {}): VoiceCallProvider {
  return {
    name: "plivo",
    verifyWebhook: () => ({ ok: true }),
    parseWebhookEvent: () => ({ events: [] }),
    initiateCall: async () => ({ providerCallId: "provider-call-id", status: "initiated" }),
    hangupCall: async () => {},
    playTts: async () => {},
    startListening: async () => {},
    stopListening: async () => {},
    ...overrides,
  };
}

function createInboundDisabledConfig() {
  return VoiceCallConfigSchema.parse({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    inboundPolicy: "disabled",
  });
}

function createInboundInitiatedEvent(params: {
  id: string;
  providerCallId: string;
  from: string;
}): NormalizedEvent {
  return {
    id: params.id,
    type: "call.initiated",
    callId: params.providerCallId,
    providerCallId: params.providerCallId,
    timestamp: Date.now(),
    direction: "inbound",
    from: params.from,
    to: "+15550000000",
  };
}

function createRejectingInboundContext(): {
  ctx: CallManagerContext;
  hangupCalls: HangupCallInput[];
} {
  const hangupCalls: HangupCallInput[] = [];
  const provider = createProvider({
    hangupCall: async (input: HangupCallInput): Promise<void> => {
      hangupCalls.push(input);
    },
  });
  const ctx = createContext({
    config: createInboundDisabledConfig(),
    provider,
  });
  return { ctx, hangupCalls };
}

describe("processEvent (functional)", () => {
  it("calls provider hangup when rejecting inbound call", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event = createInboundInitiatedEvent({
      id: "evt-1",
      providerCallId: "prov-1",
      from: "+15559999999",
    });

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
    expect(hangupCalls).toHaveLength(1);
    expect(hangupCalls[0]).toEqual({
      callId: "prov-1",
      providerCallId: "prov-1",
      reason: "hangup-bot",
    });
  });

  it("does not call hangup when provider is null", () => {
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider: null,
    });
    const event = createInboundInitiatedEvent({
      id: "evt-2",
      providerCallId: "prov-2",
      from: "+15551111111",
    });

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
  });

  it("calls hangup only once for duplicate events for same rejected call", () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event1 = createInboundInitiatedEvent({
      id: "evt-init",
      providerCallId: "prov-dup",
      from: "+15552222222",
    });
    const event2: NormalizedEvent = {
      id: "evt-ring",
      type: "call.ringing",
      callId: "prov-dup",
      providerCallId: "prov-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    };

    processEvent(ctx, event1);
    processEvent(ctx, event2);

    expect(ctx.activeCalls.size).toBe(0);
    expect(hangupCalls).toHaveLength(1);
    expect(hangupCalls[0]?.providerCallId).toBe("prov-dup");
  });

  it("updates providerCallId map when provider ID changes", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-1", {
      callId: "call-1",
      providerCallId: "request-uuid",
      provider: "plivo",
      direction: "outbound",
      state: "initiated",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("request-uuid", "call-1");

    processEvent(ctx, {
      id: "evt-provider-id-change",
      type: "call.answered",
      callId: "call-1",
      providerCallId: "call-uuid",
      timestamp: now + 1,
    });

    expect(ctx.activeCalls.get("call-1")?.providerCallId).toBe("call-uuid");
    expect(ctx.providerCallIdMap.get("call-uuid")).toBe("call-1");
    expect(ctx.providerCallIdMap.has("request-uuid")).toBe(false);
  });

  it("invokes onCallAnswered hook for answered events", () => {
    const now = Date.now();
    let answeredCallId: string | null = null;
    const ctx = createContext({
      onCallAnswered: (call) => {
        answeredCallId = call.callId;
      },
    });
    ctx.activeCalls.set("call-2", {
      callId: "call-2",
      providerCallId: "call-2-provider",
      provider: "plivo",
      direction: "inbound",
      state: "ringing",
      from: "+15550000002",
      to: "+15550000000",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("call-2-provider", "call-2");

    processEvent(ctx, {
      id: "evt-answered-hook",
      type: "call.answered",
      callId: "call-2",
      providerCallId: "call-2-provider",
      timestamp: now + 1,
    });

    expect(answeredCallId).toBe("call-2");
  });

  it("when hangup throws, logs and does not throw", () => {
    const provider = createProvider({
      hangupCall: async (): Promise<void> => {
        throw new Error("provider down");
      },
    });
    const ctx = createContext({
      config: createInboundDisabledConfig(),
      provider,
    });
    const event = createInboundInitiatedEvent({
      id: "evt-fail",
      providerCallId: "prov-fail",
      from: "+15553333333",
    });

    expect(() => processEvent(ctx, event)).not.toThrow();
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("deduplicates by dedupeKey even when event IDs differ", () => {
    const now = Date.now();
    const ctx = createContext();
    ctx.activeCalls.set("call-dedupe", {
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      provider: "plivo",
      direction: "outbound",
      state: "answered",
      from: "+15550000000",
      to: "+15550000001",
      startedAt: now,
      transcript: [],
      processedEventIds: [],
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-dedupe", "call-dedupe");

    processEvent(ctx, {
      id: "evt-1",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 1,
      transcript: "hello",
      isFinal: true,
    });

    processEvent(ctx, {
      id: "evt-2",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 2,
      transcript: "hello",
      isFinal: true,
    });

    const call = ctx.activeCalls.get("call-dedupe");
    expect(call?.transcript).toHaveLength(1);
    expect(Array.from(ctx.processedEventIds)).toEqual(["stable-key-1"]);
  });
});
