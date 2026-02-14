import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { VoiceCallConfigSchema } from "../config.js";
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
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
    ...overrides,
  };
}

describe("processEvent (functional)", () => {
  it("calls provider hangup when rejecting inbound call", () => {
    const hangupCalls: HangupCallInput[] = [];
    const provider = {
      name: "plivo" as const,
      async hangupCall(input: HangupCallInput): Promise<void> {
        hangupCalls.push(input);
      },
    };

    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "disabled",
      }),
      provider,
    });
    const event: NormalizedEvent = {
      id: "evt-1",
      type: "call.initiated",
      callId: "prov-1",
      providerCallId: "prov-1",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15559999999",
      to: "+15550000000",
    };

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
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "disabled",
      }),
      provider: null,
    });
    const event: NormalizedEvent = {
      id: "evt-2",
      type: "call.initiated",
      callId: "prov-2",
      providerCallId: "prov-2",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15551111111",
      to: "+15550000000",
    };

    processEvent(ctx, event);

    expect(ctx.activeCalls.size).toBe(0);
  });

  it("calls hangup only once for duplicate events for same rejected call", () => {
    const hangupCalls: HangupCallInput[] = [];
    const provider = {
      name: "plivo" as const,
      async hangupCall(input: HangupCallInput): Promise<void> {
        hangupCalls.push(input);
      },
    };
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "disabled",
      }),
      provider,
    });
    const event1: NormalizedEvent = {
      id: "evt-init",
      type: "call.initiated",
      callId: "prov-dup",
      providerCallId: "prov-dup",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15552222222",
      to: "+15550000000",
    };
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
    const provider = {
      name: "plivo" as const,
      async hangupCall(): Promise<void> {
        throw new Error("provider down");
      },
    };
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "disabled",
      }),
      provider,
    });
    const event: NormalizedEvent = {
      id: "evt-fail",
      type: "call.initiated",
      callId: "prov-fail",
      providerCallId: "prov-fail",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15553333333",
      to: "+15550000000",
    };

    expect(() => processEvent(ctx, event)).not.toThrow();
    expect(ctx.activeCalls.size).toBe(0);
  });
});
