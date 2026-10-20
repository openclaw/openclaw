import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCallBriefInstructions } from "../call-brief.js";
import { normalizeVoiceCallConfig } from "../config.js";
import {
  createEventManagerHarness,
  EVENT_MANAGER_REPLAY_KEY_LIMIT,
} from "../manager.test-harness.js";
import { MockProvider } from "../providers/mock.js";
import type { AnswerCallInput, CallRecord, NormalizedEvent } from "../types.js";
import { processEvent } from "./events.js";
import { persistCallRecord } from "./store.js";

const {
  cleanup,
  createContext,
  createInboundInitiatedEvent,
  createProvider,
  createRejectingInboundContext,
  installStateRuntime,
  requireFirstActiveCall,
  setup,
} = createEventManagerHarness();

beforeEach(setup);

afterEach(cleanup);

function inboundEvent(id: string, providerCallId: string, from = "+15554444444") {
  return createInboundInitiatedEvent({ id, providerCallId, from });
}

function inboundConfig(overrides: Record<string, unknown>) {
  return normalizeVoiceCallConfig({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    inboundPolicy: "open",
    ...overrides,
  });
}

describe("processEvent (functional inbound calls)", () => {
  function parseMockEvent(overrides: Partial<NormalizedEvent> = {}): NormalizedEvent {
    const [event] = new MockProvider().parseWebhookEvent({
      headers: {},
      method: "POST",
      url: "http://localhost/voice/webhook",
      query: {},
      rawBody: JSON.stringify({
        event: {
          ...inboundEvent("mock-inbound", "mock-provider-inbound", "+15552222222"),
          to: "+15553333333",
          ...overrides,
        },
      }),
    }).events;
    if (!event) {
      throw new Error("expected a parsed mock event");
    }
    return event;
  }

  it.each([
    ["call.initiated", "ringing"],
    ["call.ringing", "ringing"],
    ["call.active", "active"],
  ] as const)("admits mock %s webhooks with their caller and destination", async (type, state) => {
    const ctx = createContext({ provider: new MockProvider() });
    ctx.config.inboundPolicy = "open";

    expect(await processEvent(ctx, parseMockEvent({ type }))).toEqual({ kind: "processed" });

    expect(requireFirstActiveCall(ctx)).toMatchObject({
      provider: "mock",
      providerCallId: "mock-provider-inbound",
      direction: "inbound",
      from: "+15552222222",
      to: "+15553333333",
      state,
    });
  });

  it.each([
    [5, "+15554444444", "allowlist", true, true],
    [5, "+15554444444", "allowlist", false, false],
    [31, "+15554444444", "allowlist", true, false],
    [5, "5554444444", "allowlist", true, false],
    [5, "+15554444444", "disabled", true, false],
  ] as const)(
    "admits callbacks only for realtime recent E.164 outbound recipients: %s/%s/%s/realtime=%s",
    async (ageMinutes, from, policy, realtimeEnabled, accepted) => {
      const hangup = vi.fn(async () => {});
      const ctx = createContext({
        provider: createProvider({ hangupCall: hangup }),
        config: inboundConfig({
          inboundPolicy: policy,
          callbacks: { enabled: true, windowMinutes: 30, greeting: "I can take a message." },
          realtime: { enabled: realtimeEnabled },
        }),
      });
      const original: CallRecord = {
        callId: "original",
        providerCallId: "original-provider",
        provider: "plivo",
        direction: "outbound",
        state: "completed",
        from: "+15550000000",
        to: "+15554444444",
        startedAt: Date.now() - ageMinutes * 60_000,
        transcript: [],
        processedEventIds: [],
        metadata: {
          requesterSessionKey: "agent:main:telegram:123",
          brief: { task: "Book plumber" },
        },
      };
      await persistCallRecord(ctx.storePath, original);
      await processEvent(ctx, inboundEvent("callback", "callback-provider", from));
      expect(ctx.activeCalls.size).toBe(accepted ? 1 : 0);
      expect(hangup).toHaveBeenCalledTimes(accepted ? 0 : 1);
      if (accepted) {
        expect(requireFirstActiveCall(ctx).metadata).toMatchObject({
          callbackOfCallId: "original",
          requesterSessionKey: "agent:main:telegram:123",
          initialMessage: "I can take a message.",
          brief: {},
        });
        expect(buildCallBriefInstructions(requireFirstActiveCall(ctx))).toMatch(/take a message/i);
        expect(buildCallBriefInstructions(requireFirstActiveCall(ctx))).not.toContain(
          "Book plumber",
        );
      }
    },
  );

  it.each(["created", "rejected"] as const)(
    "does not publish %s inbound calls before SQLite persistence succeeds",
    async (kind) => {
      let failPersistence = true;
      installStateRuntime(() => failPersistence);
      const { ctx, hangupCalls } = createRejectingInboundContext();
      ctx.config.inboundPolicy = kind === "created" ? "open" : "disabled";
      const event = inboundEvent(
        `event-durable-${kind}`,
        `provider-durable-${kind}`,
        "+15550000002",
      );

      await expect(processEvent(ctx, event)).rejects.toThrow(
        "synthetic SQLite persistence failure",
      );
      expect(ctx.activeCalls.size).toBe(0);
      expect(ctx.providerCallIdMap.size).toBe(0);
      expect(ctx.rejectedProviderCallIds.size).toBe(0);
      expect(ctx.processedEventIds.size).toBe(0);
      expect(hangupCalls).toHaveLength(0);

      failPersistence = false;
      expect(await processEvent(ctx, event)).toEqual({ kind: "processed" });
      expect(ctx.activeCalls.size).toBe(kind === "created" ? 1 : 0);
      expect(hangupCalls).toHaveLength(kind === "rejected" ? 1 : 0);
    },
  );

  it("answers accepted inbound calls when the provider requires an answer command", async () => {
    const answerCall = vi.fn<(_: AnswerCallInput) => Promise<void>>().mockResolvedValue(undefined);
    const provider = createProvider({ answerCall });
    const ctx = createContext({
      config: inboundConfig({
        provider: "telnyx",
        telnyx: {
          apiKey: "KEY123",
          connectionId: "CONN456",
        },
        skipSignatureVerification: true,
      }),
      provider,
    });
    const event = inboundEvent("evt-answer", "call-control-1", "+15552222222");

    await processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(answerCall).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "call-control-1",
    });
  });

  it.each([
    ["per-call", undefined],
    ["main", { mainKey: "work" }],
  ] as const)("assigns %s session keys to inbound calls", async (sessionScope, coreSession) => {
    const ctx = createContext({
      config: inboundConfig({ sessionScope }),
      coreSession,
    });
    const event = inboundEvent("evt-inbound-session-scope", "CA-inbound-session-scope");

    await processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(call.sessionKey).toBe(
      sessionScope === "main" ? "agent:main:work" : `agent:main:voice:call:${call.callId}`,
    );
  });

  it("applies per-number inbound greeting and stores the matched route key", async () => {
    const ctx = createContext({
      config: inboundConfig({
        inboundGreeting: "Hello from global.",
        numbers: {
          "+15550002222": {
            agentId: "cards",
            inboundGreeting: "Silver Fox Cards, how can I help?",
          },
        },
      }),
    });
    const event: NormalizedEvent = {
      ...inboundEvent("evt-inbound-number-route", "CA-inbound-number-route"),
      to: "+1 (555) 000-2222",
    };

    await processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(call).toMatchObject({
      metadata: {
        initialMessage: "Silver Fox Cards, how can I help?",
        numberRouteKey: "+15550002222",
      },
      agentId: "cards",
    });
  });

  it("bounds rejected provider calls while retaining hangup-once behavior", async () => {
    const rejectedProviderCallIds = new Set<string>(
      Array.from({ length: EVENT_MANAGER_REPLAY_KEY_LIMIT }, (_, index) => `provider-${index}`),
    );
    const { ctx, hangupCalls } = createRejectingInboundContext();
    ctx.rejectedProviderCallIds = rejectedProviderCallIds;

    await processEvent(ctx, inboundEvent("evt-rejected-new", "provider-new", "+15552222222"));
    await processEvent(
      ctx,
      inboundEvent("evt-rejected-new-replay", "provider-new", "+15552222222"),
    );

    expect(ctx.rejectedProviderCallIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
    expect(ctx.rejectedProviderCallIds.has("provider-0")).toBe(false);
    expect(ctx.rejectedProviderCallIds.has("provider-new")).toBe(true);
    expect(hangupCalls).toHaveLength(1);
  });
});
