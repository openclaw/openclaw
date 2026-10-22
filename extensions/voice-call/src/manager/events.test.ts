import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
// Voice Call tests cover events plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildCallBriefInstructions } from "../call-brief.js";
import { normalizeVoiceCallConfig } from "../config.js";
import { CallManager } from "../manager.js";
import { EVENT_MANAGER_REPLAY_KEY_LIMIT } from "../manager.test-harness.js";
import { MockProvider } from "../providers/mock.js";
import { getOptionalVoiceCallStateRuntime } from "../runtime-state.js";
import type { AnswerCallInput, CallRecord, HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";
import {
  cleanup,
  createContext,
  createCall,
  createInboundInitiatedEvent,
  createProvider,
  createRejectingInboundContext,
  installStateRuntime,
  requireFirstActiveCall,
  setup,
  fixture,
  registerCall,
  eventBase,
} from "./events.test-support.js";
import { speakInitialMessage } from "./outbound.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import { persistCallRecord } from "./store.js";
import * as callStore from "./store.js";
import { waitForFinalTranscript } from "./timers.js";

const logSpy = vi.hoisted(() => {
  const logEntries: string[] = [];
  return { logEntries };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (_subsystem: string) => {
      const record = (msg: string) => {
        logSpy.logEntries.push(msg);
      };
      return { info: record, warn: record, error: record };
    },
  };
});

beforeEach(() => {
  setup();
  logSpy.logEntries.length = 0;
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("processEvent (functional)", () => {
  it.each([
    ["machine_start", "voicemail", "carrier"],
    ["fax", "failed", "carrier"],
    ["machine_end_beep", "error", "carrier"],
    ["machine_start", "voicemail", "finalization"],
  ] as const)("reports failed %s cleanup during %s/%s", async (answeredBy, reason, failure) => {
    let failPersistence = false;
    if (failure === "finalization") {
      installStateRuntime(() => failPersistence);
    }
    const hangupCall = vi.fn(async () => {
      if (failure === "carrier") {
        throw new Error("synthetic private carrier response");
      }
      failPersistence = true;
    });
    const { ctx, call, send, work } = amdContext(
      {
        pendingNotifyAmd: answeredBy === "fax",
        brief: { voicemailMessage: "Please call back." },
      },
      {
        config: normalizeVoiceCallConfig({
          voicemail: {
            detection: "twilio",
            onMachine: answeredBy === "machine_start" ? "hang-up" : "leave-message",
          },
        }),
      },
      {
        hangupCall,
        playMessageAndHangup: async () => {
          throw new Error("synthetic playback failure");
        },
      },
    );
    await expect(send({ type: "call.amd", answeredBy })).resolves.toEqual({ kind: "processed" });
    await Promise.all(work);
    expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "provider-1",
      reason,
    });
    expect(logSpy.logEntries).toEqual([
      "Detected-call cleanup failed for " + call.callId + "; inspect voice-call status and logs.",
    ]);
    expect(ctx.activeCalls.get(call.callId)).toBe(call);
    expect(call.endedAt).toBeUndefined();
  });

  it.each([false, true])("finalizes after transcript drain (failure=%s)", async (failure) => {
    const { ctx, call, send } = fixture();
    ctx.beforeCallEnd = async () => {
      if (failure) {
        throw new Error("bridge close failed");
      }
      await send({ type: "call.assistant-speech", transcript: "The plumber will call back." });
    };
    await expect(send({ type: "call.ended", reason: "completed" })).resolves.toEqual({
      kind: "processed",
    });
    if (!failure) {
      expect(call.transcript).toMatchObject([
        { speaker: "bot", text: "The plumber will call back." },
      ]);
    }
    expect(call.endReason).toBe("completed");
    expect(ctx.activeCalls.size).toBe(0);
  });

  it.each(["speech", "answered", "terminal", "fatal-error"] as const)(
    "publishes %s effects only after persistence",
    async (kind) => {
      let failPersistence = true;
      installStateRuntime(() => failPersistence);
      const onCallAnswered = vi.fn();
      const { ctx, call, event } = fixture(
        {
          providerCallId: "provider-before",
          state: kind === "answered" ? "ringing" : "active",
        },
        { onCallAnswered },
      );
      const terminal = kind === "terminal" || kind === "fatal-error";
      const endReason = kind === "fatal-error" ? "error" : "hangup-user";
      const terminalLog = `[voice-call] Call finalized callId=${call.callId} providerCallId=provider-before endReason=${endReason}`;
      const resolve = vi.fn(),
        reject = vi.fn();
      if (kind !== "answered") {
        ctx.transcriptWaiters.set(call.callId, {
          resolve,
          reject,
          timeout: setTimeout(() => {}, 60_000),
        });
      }
      if (terminal) {
        ctx.maxDurationTimers.set(
          call.callId,
          setTimeout(() => {}, 60_000),
        );
      }
      const input = event(
        kind === "speech"
          ? { type: "call.speech", transcript: "durable", isFinal: true }
          : kind === "answered"
            ? { type: "call.answered", providerCallId: "provider-after" }
            : kind === "fatal-error"
              ? { type: "call.error", error: "carrier failure", retryable: false }
              : { type: "call.ended", reason: "hangup-user" },
      );
      await expect(processEvent(ctx, input)).rejects.toThrow(
        "synthetic SQLite persistence failure",
      );
      expect(ctx.processedEventIds.has(input.id)).toBe(false);
      expect(call).toMatchObject({
        processedEventIds: [],
        transcript: [],
        providerCallId: "provider-before",
      });
      expect(ctx.providerCallIdMap.has("provider-after")).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(ctx.maxDurationTimers.has(call.callId)).toBe(terminal);
      expect(logSpy.logEntries).not.toContain(terminalLog);
      failPersistence = false;
      await processEvent(ctx, input);
      expect(ctx.processedEventIds.has(input.id)).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(kind === "speech" ? 1 : 0);
      expect(reject).toHaveBeenCalledTimes(terminal ? 1 : 0);
      expect(onCallAnswered).toHaveBeenCalledTimes(kind === "answered" ? 1 : 0);
      if (kind === "answered") {
        expect(onCallAnswered).toHaveBeenCalledWith(call);
      }
      expect(ctx.activeCalls.has(call.callId)).toBe(!terminal);
      if (terminal) {
        expect(call).toMatchObject({ state: endReason, endReason, endedAt: input.timestamp });
        expect(reject).toHaveBeenCalledWith(
          new Error(
            kind === "fatal-error" ? "Call error: carrier failure" : "Call ended: hangup-user",
          ),
        );
        expect(logSpy.logEntries.filter((entry) => entry === terminalLog)).toHaveLength(1);
      } else {
        expect(logSpy.logEntries).not.toContain(terminalLog);
      }
    },
  );

  it.each(["request-uuid", "call-1"])(
    "never downgrades an upgraded provider ID via %s",
    async (aliasCallId) => {
      const { ctx, call, send } = fixture({
        providerCallId: "request-uuid",
        state: "initiated",
        metadata: {},
      });
      await persistCallRecord(ctx.storePath, call);
      const assertIdentity = () => {
        expect(call.providerCallId).toBe("call-uuid");
        expect(ctx.providerCallIdMap.get("call-uuid")).toBe(call.callId);
        expect(ctx.providerCallIdMap.has("request-uuid")).toBe(false);
      };
      await send({ type: "call.answered", providerCallId: "call-uuid" });
      expect(ctx.activeCalls.get(call.callId)).toBe(call);
      assertIdentity();
      const result = await send({
        type: "call.speech",
        callId: aliasCallId,
        providerCallId: "request-uuid",
        direction: "outbound",
        transcript: "Continue the existing call.",
        isFinal: true,
      });
      expect(result).toMatchObject({ kind: "final-speech" });
      if (result.kind !== "final-speech") {
        throw new Error("expected live speech");
      }
      expect(result.call).toBe(call);
      expect(ctx.activeCalls.size).toBe(1);
      assertIdentity();
    },
  );

  it.each(["admission", "status"] as const)(
    "surfaces history read failure during %s",
    async (operation) => {
      const provider = createProvider(),
        ctx = createContext({ provider });
      const manager = new CallManager(ctx.config, ctx.storePath);
      await manager.initialize(provider, "https://example.com/voice/webhook");
      const state = expectDefined(getOptionalVoiceCallStateRuntime()?.state, "fixture state");
      const openStore = state.openKeyedStoreV2.bind(state);
      const fault = vi
        .spyOn(state, "openKeyedStoreV2")
        .mockImplementation(<T>(options: OpenAsyncKeyedStoreOptions) => {
          const store = openStore<T>(options);
          store.entries = async () => {
            throw new Error("synthetic call history read failure");
          };
          return store;
        });
      try {
        const result =
          operation === "status"
            ? manager.getCallFromMemoryOrStore("provider-unknown")
            : manager.processEvent({
                ...inboundEvent("unreadable", "provider-unknown", "+15550000001"),
                direction: "outbound",
              });
        await expect(result).rejects.toThrow("synthetic call history read failure");
      } finally {
        fault.mockRestore();
      }
      expect(manager.getActiveCalls()).toEqual([]);
      expect(await manager.getCallHistory()).toEqual([]);
    },
  );

  it("leaves unknown events replayable until the call is registered", async () => {
    const { ctx, call, event } = fixture({ state: "ringing", direction: "inbound", metadata: {} });
    ctx.activeCalls.clear();
    ctx.providerCallIdMap.clear();
    const input = event({
      type: "call.answered",
      providerCallId: "provider-1",
      dedupeKey: "stable-late-call",
    });
    expect(await processEvent(ctx, input)).toEqual({ kind: "ignored", replayable: true });
    expect(ctx.processedEventIds.size).toBe(0);
    ctx.activeCalls.set(call.callId, call);
    ctx.providerCallIdMap.set("provider-1", call.callId);
    await processEvent(ctx, input);
    expect(ctx.activeCalls.get(call.callId)).toBe(call);
    expect(call).toMatchObject({ state: "answered", answeredAt: input.timestamp });
    expect([...ctx.processedEventIds]).toEqual(["stable-late-call"]);
  });

  it.each([
    ["call.speaking", "speaking", []],
    ["call.assistant-speech", "speaking", [{ speaker: "bot", text: "hello" }]],
    ["call.speech", "listening", [{ speaker: "user", text: "hello" }]],
    ["initial-message", "speaking", [{ speaker: "bot", text: "hello" }]],
  ] as const)("enforces duration when %s precedes answered", async (type, state, transcript) => {
    const now = Date.parse("2026-03-22T12:00:00.000Z");
    vi.useFakeTimers({ now });
    const streaming = type === "initial-message";
    const hangupCall = vi.fn(async (_input: HangupCallInput) => {});
    const provider = Object.assign(
      createProvider({ name: streaming ? "twilio" : "plivo", hangupCall }),
      {
        isConversationStreamConnectEnabled: () => true,
      },
    );
    const { ctx, call, send } = fixture(
      {
        provider: provider.name,
        direction: "inbound",
        state: streaming ? "active" : "ringing",
        startedAt: now - 120_000,
        metadata: streaming ? { initialMessage: "hello", mode: "conversation" } : {},
      },
      {
        provider,
        config: inboundConfig({
          maxDurationSeconds: 1,
          provider: provider.name,
          ...(streaming ? { streaming: { enabled: true } } : {}),
        }),
      },
    );
    if (streaming) {
      await speakInitialMessage(ctx, "provider-1");
    } else {
      await send(
        type === "call.speaking"
          ? { type, text: "hello", timestamp: now + 250 }
          : type === "call.speech"
            ? { type, transcript: "hello", isFinal: true, timestamp: now + 250 }
            : { type, transcript: "hello", timestamp: now + 250 },
      );
    }
    expect(call).toMatchObject({ state, answeredAt: streaming ? now : now + 250 });
    expect(call.transcript.map(({ speaker, text }) => ({ speaker, text }))).toEqual(transcript);
    expect(ctx.maxDurationTimers.has(call.callId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(ctx.endCallOperations.values());
    expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "provider-1",
      reason: "timeout",
    });
    expect(ctx.activeCalls.has(call.callId)).toBe(false);
  });

  it("admits external outbound calls despite disabled inbound policy", async () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    await processEvent(ctx, {
      ...inboundEvent("external", "CA-external-456", "+15550000000"),
      direction: "outbound",
      to: "+15559876543",
    });
    expect(ctx.activeCalls.size).toBe(1);
    expect(hangupCalls).toHaveLength(0);
    const call = requireFirstActiveCall(ctx);
    expect(ctx.providerCallIdMap.get("CA-external-456")).toBe(call.callId);
    expect(call).toMatchObject({
      providerCallId: "CA-external-456",
      direction: "outbound",
      from: "+15550000000",
      to: "+15559876543",
    });
  });

  it("deduplicates distinct event IDs by their stable key", async () => {
    const { ctx, call, event } = fixture({ state: "answered", metadata: {} });
    const input = event({
      type: "call.speech",
      dedupeKey: "stable-key-1",
      transcript: "hello",
      isFinal: true,
    });
    const first = await processEvent(ctx, input);
    const replay = await processEvent(ctx, {
      ...input,
      id: "redelivery",
      timestamp: input.timestamp + 1,
    });
    expect(ctx.activeCalls.get(call.callId)).toBe(call);
    expect(call.transcript).toHaveLength(1);
    expect([...ctx.processedEventIds]).toEqual(["stable-key-1"]);
    expect(first).toMatchObject({
      kind: "final-speech",
      transcript: "hello",
      waiterResolved: false,
    });
    expect(replay).toEqual({ kind: "ignored" });
  });

  it.each([
    ["", false],
    [" \t\n", true],
  ] as const)(
    "treats blank speech %j as a non-turn (waiter=%s)",
    async (transcript, withWaiter) => {
      const { ctx, call, send } = fixture({
        provider: "telnyx",
        direction: "inbound",
        metadata: {},
      });
      const resolve = vi.fn(),
        reject = vi.fn(),
        timeout = setTimeout(() => {}, 60_000);
      if (withWaiter) {
        ctx.transcriptWaiters.set(call.callId, { resolve, reject, timeout });
      }
      const result = await send({
        type: "call.speech",
        transcript,
        isFinal: true,
        dedupeKey: "blank",
      });
      clearTimeout(timeout);
      expect(result).toEqual({ kind: "processed" });
      expect(ctx.activeCalls.get(call.callId)).toMatchObject({
        transcript: [],
        state: "listening",
      });
      expect(ctx.processedEventIds.has("blank")).toBe(true);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(ctx.transcriptWaiters.has(call.callId)).toBe(withWaiter);
    },
  );

  it("bounds committed manager and call replay keys", async () => {
    const { ctx, call, event } = fixture(
      {
        processedEventIds: Array.from({ length: MAX_CALL_REPLAY_KEYS }, (_, i) => "call-" + i),
        metadata: {},
      },
      {
        processedEventIds: new Set(
          Array.from({ length: EVENT_MANAGER_REPLAY_KEY_LIMIT }, (_, i) => "manager-" + i),
        ),
      },
    );
    const input = event({
      id: "new",
      type: "call.dtmf",
      providerCallId: "provider-1",
      digits: "1",
    });
    expect(await processEvent(ctx, input)).toEqual({ kind: "processed" });
    expect(ctx.processedEventIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
    expect(ctx.processedEventIds.has("manager-0")).toBe(false);
    expect(ctx.processedEventIds.has("new")).toBe(true);
    expect(call.processedEventIds).toHaveLength(MAX_CALL_REPLAY_KEYS);
    expect(call.processedEventIds[0]).toBe("call-1");
    expect(call.processedEventIds.at(-1)).toBe("new");
    expect(await processEvent(ctx, { ...input, timestamp: input.timestamp + 1 })).toEqual({
      kind: "ignored",
    });
  });

  it("keeps retryable provider errors replayable", async () => {
    const { ctx, call, event } = fixture({ metadata: {} });
    const input = event({
      type: "call.error",
      dedupeKey: "stable-retryable-error",
      providerCallId: "provider-1",
      error: "temporary upstream failure",
      retryable: true,
    });
    expect(await processEvent(ctx, input)).toEqual({ kind: "processed", replayable: true });
    await processEvent(ctx, input);
    expect(ctx.activeCalls.get(call.callId)).toBe(call);
    expect(call.state).toBe("active");
    expect([...ctx.processedEventIds]).toStrictEqual([]);
    expect(call.processedEventIds).toStrictEqual([]);
  });
});

describe("processEvent privacy assertions", () => {
  it.each([
    ["acceptance", "allowlist", true, true],
    ["rejection", "allowlist", false, true],
    ["creation", "open", true, false],
    ["no-provider", "allowlist", false, false],
  ] as const)(
    "redacts caller numbers in %s logs",
    async (label, inboundPolicy, allowed, hasProvider) => {
      const phone = "+15551112222";
      const providerCallId = `prov-privacy-${label}`;
      const ctx = createContext({
        config: normalizeVoiceCallConfig({
          enabled: true,
          provider: "plivo",
          fromNumber: "+15550000000",
          inboundPolicy,
          allowFrom: [allowed ? phone : "+15550001111"],
        }),
        provider: hasProvider ? createProvider() : null,
      });
      await processEvent(
        ctx,
        createInboundInitiatedEvent({
          id: `evt-privacy-${label}`,
          providerCallId,
          from: phone,
        }),
      );
      const logOutput = logSpy.logEntries.join(" ");
      expect(logOutput).not.toContain(phone);
      expect(logOutput).toContain("caller=sha256:");
      if (inboundPolicy === "allowlist") {
        expect(logOutput).toContain(`allowlisted=${allowed}`);
      }
      if (label === "creation") {
        expect(logOutput).toContain(requireFirstActiveCall(ctx).callId);
      }
      if (label === "no-provider") {
        expect(logOutput).toContain(providerCallId);
        expect(ctx.activeCalls.size).toBe(0);
      }
    },
  );
});

it.each([false, true])(
  "reports unconsumed speech after its waiter expires (replacement=%s)",
  async (replacement) => {
    vi.useFakeTimers();
    const ctx = createContext();
    ctx.config.transcriptTimeoutMs = 30;
    const call = registerCall(ctx, {
      callId: "call-expiring-waiter",
      providerCallId: "provider-expiring-waiter",
      direction: "inbound",
      state: "listening",
      from: "+15550000001",
      to: "+15550000000",
      startedAt: Date.now(),
      answeredAt: Date.now(),
    });
    ctx.providerCallIdMap.set(call.providerCallId!, call.callId);
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const persist = callStore.persistCallRecord;
    vi.spyOn(callStore, "persistCallRecord").mockImplementationOnce(async (...args) => {
      entered.resolve();
      await release.promise;
      await persist(...args);
    });
    const waiting = waitForFinalTranscript(ctx, call.callId);
    const timedOut = expect(waiting).rejects.toThrow("Timed out waiting for transcript");
    const pending = processEvent(ctx, {
      ...eventBase(call.callId, "speech-before-timeout", Date.now()),
      type: "call.speech",
      transcript: "Persist this utterance",
      isFinal: true,
    });
    let replacementSettled = false;
    try {
      await entered.promise;
      await vi.advanceTimersByTimeAsync(30);
      await timedOut;
      if (replacement) {
        const next = waitForFinalTranscript(ctx, call.callId);
        ctx.trackCallWork(
          next.then(
            () => {
              replacementSettled = true;
            },
            () => {},
          ),
        );
      }
      release.resolve();
      await expect(pending).resolves.toMatchObject({ kind: "final-speech", waiterResolved: false });
      expect(replacementSettled).toBe(false);
      expect(ctx.transcriptWaiters.has(call.callId)).toBe(replacement);
      expect(call.transcript.at(-1)?.text).toBe("Persist this utterance");
      expect(ctx.processedEventIds.has("speech-before-timeout")).toBe(true);
    } finally {
      release.resolve();
      await pending;
    }
  },
);

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
      const original = createCall({
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
      });
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

function amdContext(
  metadata: CallRecord["metadata"] = {},
  overrides: Partial<CallManagerContext> = {},
  providerOverrides: Parameters<typeof createProvider>[0] = {},
) {
  const work: Promise<unknown>[] = [];
  const hangup = vi.fn(async () => {}),
    playMessageAndHangup = vi.fn(async () => {});
  const context = fixture(
    { provider: "twilio", metadata },
    {
      trackCallWork: (item) => {
        work.push(item);
      },
      provider: createProvider({
        name: "twilio",
        playMessageAndHangup,
        hangupCall: hangup,
        ...providerOverrides,
      }),
      config: normalizeVoiceCallConfig({
        voicemail: { detection: "twilio", onMachine: "leave-message" },
      }),
      ...overrides,
    },
  );
  return { ...context, work, hangup, playMessageAndHangup };
}

describe("carrier answering machine flow", () => {
  it("records detection on a terminal status without restarting playback", async () => {
    const playMessageAndHangup = vi.fn(async () => {});
    const { call, send } = fixture(
      { provider: "twilio", metadata: {} },
      {
        provider: createProvider({ playMessageAndHangup }),
      },
    );
    await send({
      type: "call.ended",
      reason: "completed",
      id: "ended",
      answeredBy: "machine_end_beep",
    });
    expect(call.metadata).toMatchObject({
      answeredByFirst: "machine_end_beep",
      answeredBy: "machine_end_beep",
    });
    expect(call.endReason).toBe("completed");
    expect(playMessageAndHangup).not.toHaveBeenCalled();
  });

  it("retains the first classification as later callbacks update the call", async () => {
    const { call, send } = fixture({ provider: "twilio", metadata: {} });
    await send({ type: "call.amd", answeredBy: "machine_start", id: "first" });
    await send({ type: "call.amd", answeredBy: "machine_end_other", id: "last" });
    expect(call.metadata).toMatchObject({
      answeredByFirst: "machine_start",
      answeredBy: "machine_end_other",
    });
    await send({
      type: "call.ended",
      reason: "completed",
      id: "ended",
      answeredBy: "machine_end_beep",
    });
    expect(call.metadata).toMatchObject({
      answeredByFirst: "machine_start",
      answeredBy: "machine_end_beep",
    });
  });

  it.each([false, true])(
    "uses realtime voicemail and waits before hangup (failure=%s)",
    async (failed) => {
      const playback = createDeferred<void>();
      const started = createDeferred<void>();
      const beforeCarrierPlayback = vi.fn();
      const playRealtimeVoicemail = vi.fn(() => {
        started.resolve();
        return playback.promise;
      });
      const { call, send, work, hangup, playMessageAndHangup } = amdContext(
        { brief: { voicemailMessage: "We will call again later." } },
        { playRealtimeVoicemail, beforeCarrierPlayback },
      );
      await send({ type: "call.amd", answeredBy: "machine_end_beep" });
      await started.promise;
      expect(playRealtimeVoicemail).toHaveBeenCalledWith(
        call.callId,
        expect.stringContaining("We will call again later."),
      );
      expect(playMessageAndHangup).not.toHaveBeenCalled();
      expect(beforeCarrierPlayback).not.toHaveBeenCalled();
      expect(hangup).not.toHaveBeenCalled();
      if (failed) {
        playback.reject(new Error("No audible voicemail"));
      } else {
        playback.resolve();
      }
      await Promise.all(work);
      expect(hangup).toHaveBeenCalledTimes(1);
      expect(call.endReason).toBe(failed ? "error" : "voicemail");
      expect(call.metadata?.voicemailStatus).toBe(failed ? "failed" : "left");
    },
  );

  it("prepares the bridge once and persists the intended message before carrier playback", async () => {
    const prepared = createDeferred<void>();
    const preparing = createDeferred<void>();
    const beforeCarrierPlayback = vi.fn(() => {
      preparing.resolve();
      return prepared.promise;
    });
    const { call, send, work, hangup, playMessageAndHangup } = amdContext(
      { brief: { task: "Arrange a plumber", voicemailMessage: "Please call me back." } },
      { beforeCarrierPlayback },
    );
    playMessageAndHangup.mockImplementation(async () => {
      expect(call.metadata?.voicemailStatus).toBe("playing");
      expect(call.transcript).toMatchObject([{ speaker: "bot", text: "Please call me back." }]);
    });
    await send({ type: "call.amd", answeredBy: "machine_end_beep" });
    await send({ type: "call.amd", answeredBy: "machine_end_beep", id: "redelivery" });
    await preparing.promise;
    expect(beforeCarrierPlayback).toHaveBeenCalledExactlyOnceWith(call.callId);
    expect(playMessageAndHangup).not.toHaveBeenCalled();
    prepared.resolve();
    await Promise.all(work);
    expect(playMessageAndHangup).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "provider-1",
      text: "Please call me back.",
    });
    expect(hangup).not.toHaveBeenCalled();
    expect(call.endReason).toBeUndefined();
    await send({ type: "call.ended", reason: "completed" });
    expect(call.metadata?.voicemailStatus).toBe("left");
    expect(call.endReason).toBe("voicemail");
  });

  it.each(["prepare", "request"])(
    "records %s failure without claiming voicemail was left",
    async (failure) => {
      const fail = async () => {
        throw new Error("carrier handoff failed");
      };
      const { call, send, work, playMessageAndHangup } = amdContext(
        {},
        {
          beforeCarrierPlayback: failure === "prepare" ? fail : async () => {},
        },
      );
      if (failure === "request") {
        playMessageAndHangup.mockImplementation(fail);
      }
      await send({ type: "call.amd", answeredBy: "machine_end_silence" });
      await Promise.all(work);
      expect(playMessageAndHangup).toHaveBeenCalledTimes(failure === "request" ? 1 : 0);
      expect(call.metadata).toMatchObject({
        voicemailStatus: "failed",
        voicemailError: "carrier handoff failed",
      });
      expect(call.endReason).toBe("error");
    },
  );

  it.each(["human", "unknown", "machine_end_beep"])(
    "holds notify speech until classification %s, then plays the right message once",
    async (answeredBy) => {
      const { call, send, work, hangup, playMessageAndHangup } = amdContext({
        mode: "notify",
        pendingNotifyAmd: true,
        initialMessage: "Your parcel is ready.",
        brief: { voicemailMessage: "Please collect your parcel." },
      });
      await send({ type: "call.amd", answeredBy });
      await send({ type: "call.amd", answeredBy, id: "redelivery" });
      await Promise.all(work);
      expect(playMessageAndHangup).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        providerCallId: "provider-1",
        text:
          answeredBy === "machine_end_beep"
            ? "Please collect your parcel."
            : "Your parcel is ready.",
      });
      expect(hangup).not.toHaveBeenCalled();
      await send({ type: "call.ended", reason: "completed" });
      expect(call.endReason).toBe(answeredBy === "machine_end_beep" ? "voicemail" : "completed");
    },
  );

  it.each(["off", "hang-up"] as const)("handles AMD policy %s without speaking", async (mode) => {
    const { call, send, work, hangup, playMessageAndHangup } = amdContext(
      {},
      {
        config: normalizeVoiceCallConfig({
          voicemail: { detection: mode === "off" ? "off" : "twilio", onMachine: "hang-up" },
        }),
      },
    );
    await send({ type: "call.amd", answeredBy: "machine_start" });
    await Promise.all(work);
    expect(playMessageAndHangup).not.toHaveBeenCalled();
    expect(hangup).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    expect(call.metadata?.voicemailStatus).toBe(mode === "off" ? undefined : "hang-up");
  });
});
