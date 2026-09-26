// Voice Call tests cover inbound event policy and routing behavior.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VoiceCallConfigSchema } from "../config.js";
import {
  createEventManagerHarness,
  EVENT_MANAGER_REPLAY_KEY_LIMIT,
} from "../manager.test-harness.js";
import type { AnswerCallInput, CallRecord, NormalizedEvent } from "../types.js";
import { processEvent } from "./events.js";

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

beforeEach(() => {
  setup();
});

afterEach(cleanup);

describe("processEvent (functional inbound calls)", () => {
  it.each(["created", "rejected"] as const)(
    "does not publish %s inbound calls before SQLite persistence succeeds",
    async (kind) => {
      let failPersistence = true;
      installStateRuntime(() => failPersistence);
      const { ctx, hangupCalls } = createRejectingInboundContext();
      ctx.config.inboundPolicy = kind === "created" ? "open" : "disabled";
      const event = createInboundInitiatedEvent({
        id: `event-durable-${kind}`,
        providerCallId: `provider-durable-${kind}`,
        from: "+15550000002",
      });

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
    const answerCalls: AnswerCallInput[] = [];
    const provider = createProvider({
      answerCall: async (input: AnswerCallInput): Promise<void> => {
        answerCalls.push(input);
      },
    });
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "telnyx",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
        telnyx: {
          apiKey: "KEY123",
          connectionId: "CONN456",
        },
        skipSignatureVerification: true,
      }),
      provider,
    });
    const event = createInboundInitiatedEvent({
      id: "evt-answer",
      providerCallId: "call-control-1",
      from: "+15552222222",
    });

    await processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(answerCalls).toEqual([
      {
        callId: call.callId,
        providerCallId: "call-control-1",
      },
    ]);
  });

  it.each([
    {
      sessionScope: "per-call",
      coreSession: undefined,
      expectedSessionKey: (call: CallRecord) => `agent:main:voice:call:${call.callId}`,
    },
    {
      sessionScope: "main",
      coreSession: { mainKey: "work" },
      expectedSessionKey: () => "agent:main:work",
    },
  ])(
    "assigns $sessionScope session keys to inbound calls",
    async ({ sessionScope, coreSession, expectedSessionKey }) => {
      const ctx = createContext({
        config: VoiceCallConfigSchema.parse({
          enabled: true,
          provider: "plivo",
          fromNumber: "+15550000000",
          inboundPolicy: "open",
          sessionScope,
        }),
        coreSession,
      });
      const event: NormalizedEvent = {
        id: "evt-inbound-session-scope",
        type: "call.initiated",
        callId: "CA-inbound-session-scope",
        providerCallId: "CA-inbound-session-scope",
        timestamp: Date.now(),
        direction: "inbound",
        from: "+15554444444",
        to: "+15550000000",
      };

      await processEvent(ctx, event);

      const call = requireFirstActiveCall(ctx);
      expect(call.sessionKey).toBe(expectedSessionKey(call));
    },
  );

  it("applies per-number inbound greeting and stores the matched route key", async () => {
    const ctx = createContext({
      config: VoiceCallConfigSchema.parse({
        enabled: true,
        provider: "plivo",
        fromNumber: "+15550000000",
        inboundPolicy: "open",
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
      id: "evt-inbound-number-route",
      type: "call.initiated",
      callId: "CA-inbound-number-route",
      providerCallId: "CA-inbound-number-route",
      timestamp: Date.now(),
      direction: "inbound",
      from: "+15554444444",
      to: "+1 (555) 000-2222",
    };

    await processEvent(ctx, event);

    const call = requireFirstActiveCall(ctx);
    expect(call.metadata?.initialMessage).toBe("Silver Fox Cards, how can I help?");
    expect(call.metadata?.numberRouteKey).toBe("+15550002222");
    expect(call.agentId).toBe("cards");
  });

  it("bounds rejected provider calls while retaining hangup-once behavior", async () => {
    const rejectedProviderCallIds = new Map<string, symbol>(
      Array.from(
        { length: EVENT_MANAGER_REPLAY_KEY_LIMIT },
        (_, index) => [`provider-${index}`, Symbol(`provider-${index}`)] as const,
      ),
    );
    const { ctx, hangupCalls } = createRejectingInboundContext();
    ctx.rejectedProviderCallIds = rejectedProviderCallIds;

    await processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: "evt-rejected-new",
        providerCallId: "provider-new",
        from: "+15552222222",
      }),
    );
    await processEvent(
      ctx,
      createInboundInitiatedEvent({
        id: "evt-rejected-new-replay",
        providerCallId: "provider-new",
        from: "+15552222222",
      }),
    );

    expect(ctx.rejectedProviderCallIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
    expect(ctx.rejectedProviderCallIds.has("provider-0")).toBe(false);
    expect(ctx.rejectedProviderCallIds.has("provider-new")).toBe(true);
    expect(hangupCalls).toHaveLength(1);
  });
});
