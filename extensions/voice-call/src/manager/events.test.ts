import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
// Voice Call tests cover events plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig } from "../config.js";
import { CallManager } from "../manager.js";
import {
  createEventManagerHarness,
  EVENT_MANAGER_REPLAY_KEY_LIMIT,
} from "../manager.test-harness.js";
import { getOptionalVoiceCallStateRuntime } from "../runtime-state.js";
import type { CallRecord, HangupCallInput, NormalizedEvent } from "../types.js";
import type { CallManagerContext } from "./context.js";
import { processEvent } from "./events.js";
import { speakInitialMessage } from "./outbound.js";
import { MAX_CALL_REPLAY_KEYS } from "./replay-keys.js";
import { persistCallRecord } from "./store.js";
import * as callStore from "./store.js";
import { waitForFinalTranscript } from "./timers.js";

const logSpy = vi.hoisted(() => {
  const logEntries: string[] = [];
  return {
    logEntries,
    clearLogEntries: () => {
      logEntries.length = 0;
    },
  };
});

vi.mock("openclaw/plugin-sdk/runtime-env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/runtime-env")>();
  return {
    ...actual,
    createSubsystemLogger: (_subsystem: string) => ({
      info: (msg: string) => {
        logSpy.logEntries.push(msg);
      },
      warn: (msg: string) => {
        logSpy.logEntries.push(msg);
      },
      error: (msg: string) => {
        logSpy.logEntries.push(msg);
      },
    }),
  };
});

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

function createCall(overrides: Partial<CallRecord> & Pick<CallRecord, "callId">): CallRecord {
  return {
    provider: "plivo",
    direction: "outbound",
    state: "active",
    from: "+15550000000",
    to: "+15550000001",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...overrides,
  };
}

function registerCall(
  ctx: CallManagerContext,
  overrides: Partial<CallRecord> & Pick<CallRecord, "callId">,
) {
  const call = createCall(overrides);
  ctx.activeCalls.set(call.callId, call);
  return call;
}

function eventBase(callId: string, id = callId, timestamp = Date.now()) {
  return { id, callId, timestamp };
}

beforeEach(() => {
  setup();
  logSpy.clearLogEntries();
});

afterEach(async () => {
  await cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("processEvent (functional)", () => {
  it.each([
    {
      path: "machine policy",
      answeredBy: "machine_start",
      reason: "voicemail",
      failure: "carrier",
    },
    { path: "notify fax", answeredBy: "fax", reason: "failed", failure: "carrier" },
    {
      path: "playback recovery",
      answeredBy: "machine_end_beep",
      reason: "error",
      failure: "carrier",
    },
    {
      path: "machine policy",
      answeredBy: "machine_start",
      reason: "voicemail",
      failure: "finalization",
    },
  ] as const)(
    "reports failed $path $failure cleanup without claiming termination",
    async ({ path, answeredBy, reason, failure }) => {
      const work: Promise<unknown>[] = [];
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
      const ctx = createContext({
        provider: createProvider({
          name: "twilio",
          hangupCall,
          playMessageAndHangup: async () => {
            throw new Error("synthetic playback failure");
          },
        }),
        config: normalizeVoiceCallConfig({
          voicemail: {
            detection: "twilio",
            onMachine: path === "machine policy" ? "hang-up" : "leave-message",
          },
        }),
        trackCallWork: (item) => {
          work.push(item);
        },
      });
      const call = registerCall(ctx, {
        callId: "detected-call",
        providerCallId: "CA-detected",
        provider: "twilio",
        metadata: {
          pendingNotifyAmd: path === "notify fax",
          brief: { voicemailMessage: "Please call back." },
        },
      });

      await expect(
        processEvent(ctx, {
          ...eventBase(call.callId, "detection", Date.now()),
          type: "call.amd",
          answeredBy,
        }),
      ).resolves.toEqual({ kind: "processed" });
      await Promise.all(work);

      expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        providerCallId: "CA-detected",
        reason,
      });
      expect(logSpy.logEntries).toEqual([
        `Detected-call cleanup failed for ${call.callId}; inspect voice-call status and logs.`,
      ]);
      expect(ctx.activeCalls.get(call.callId)).toBe(call);
      expect(call.endedAt).toBeUndefined();
    },
  );

  it("drains final assistant transcript before a carrier terminal event finalizes", async () => {
    const ctx = createContext();
    const call = registerCall(ctx, { callId: "carrier-drain", providerCallId: "CA-drain" });
    ctx.beforeCallEnd = async () => {
      await processEvent(ctx, {
        ...eventBase(call.callId, "last-transcript", Date.now()),
        type: "call.assistant-speech",
        transcript: "The plumber will call back.",
      });
    };
    await processEvent(ctx, {
      ...eventBase(call.callId, "carrier-ended", Date.now()),
      type: "call.ended",
      reason: "completed",
    });
    expect(call.transcript).toMatchObject([
      { speaker: "bot", text: "The plumber will call back." },
    ]);
    expect(call.endReason).toBe("completed");
  });

  it("finalizes confirmed carrier termination even when final transcript drain fails", async () => {
    const ctx = createContext({
      beforeCallEnd: async () => {
        throw new Error("bridge close failed");
      },
    });
    const call = registerCall(ctx, { callId: "drain-failed", providerCallId: "CA-drain-failed" });
    await expect(
      processEvent(ctx, {
        ...eventBase(call.callId, "carrier-drain-failed", Date.now()),
        type: "call.ended",
        reason: "completed",
      }),
    ).resolves.toEqual({ kind: "processed" });
    expect(call.endReason).toBe("completed");
    expect(ctx.activeCalls.size).toBe(0);
  });

  it.each(["speech", "answered", "terminal", "fatal-error"] as const)(
    "publishes %s side effects only after SQLite persistence succeeds",
    async (kind) => {
      let failPersistence = true;
      installStateRuntime(() => failPersistence);
      const onCallAnswered = vi.fn();
      const ctx = createContext({ onCallAnswered });
      const call: CallRecord = createCall({
        callId: `call-durable-${kind}`,
        providerCallId: "provider-before",
        state: kind === "answered" ? "ringing" : "active",
      });
      const terminal = kind === "terminal" || kind === "fatal-error";
      const endReason = kind === "fatal-error" ? "error" : "hangup-user";
      const terminalLog = `[voice-call] Call finalized callId=${call.callId} providerCallId=provider-before endReason=${endReason}`;
      ctx.activeCalls.set(call.callId, call);
      ctx.providerCallIdMap.set("provider-before", call.callId);
      const resolve = vi.fn();
      const reject = vi.fn();
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
      const base = { id: `event-${kind}`, callId: call.callId, timestamp: Date.now() };
      const event: NormalizedEvent =
        kind === "speech"
          ? { ...base, type: "call.speech", transcript: "durable", isFinal: true }
          : kind === "answered"
            ? { ...base, type: "call.answered", providerCallId: "provider-after" }
            : kind === "fatal-error"
              ? { ...base, type: "call.error", error: "carrier failure", retryable: false }
              : { ...base, type: "call.ended", reason: "hangup-user" };

      await expect(processEvent(ctx, event)).rejects.toThrow(
        "synthetic SQLite persistence failure",
      );
      expect(ctx.processedEventIds.has(event.id)).toBe(false);
      expect(call.processedEventIds).toEqual([]);
      expect(call.transcript).toEqual([]);
      expect(call.providerCallId).toBe("provider-before");
      expect(ctx.providerCallIdMap.has("provider-after")).toBe(false);
      expect(resolve).not.toHaveBeenCalled();
      expect(reject).not.toHaveBeenCalled();
      expect(ctx.maxDurationTimers.has(call.callId)).toBe(terminal);
      expect(logSpy.logEntries).not.toContain(terminalLog);

      failPersistence = false;
      await processEvent(ctx, event);
      expect(ctx.processedEventIds.has(event.id)).toBe(true);
      expect(resolve).toHaveBeenCalledTimes(kind === "speech" ? 1 : 0);
      expect(reject).toHaveBeenCalledTimes(terminal ? 1 : 0);
      expect(onCallAnswered).toHaveBeenCalledTimes(kind === "answered" ? 1 : 0);
      if (kind === "answered") {
        expect(onCallAnswered).toHaveBeenCalledWith(call);
      }
      expect(ctx.activeCalls.has(call.callId)).toBe(!terminal);
      if (terminal) {
        expect(call).toMatchObject({ state: endReason, endReason, endedAt: event.timestamp });
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
    "upgrades provider identity without downgrading a known alias via %s",
    async (aliasCallId) => {
      const now = Date.now();
      const ctx = createContext();
      registerCall(ctx, {
        callId: "call-1",
        providerCallId: "request-uuid",
        state: "initiated",
        startedAt: now,
        metadata: {},
      });
      ctx.providerCallIdMap.set("request-uuid", "call-1");
      const initialCall = expectDefined(ctx.activeCalls.get("call-1"), "expected the initial call");
      await persistCallRecord(ctx.storePath, initialCall);

      await processEvent(ctx, {
        id: "evt-provider-id-change",
        type: "call.answered",
        callId: "call-1",
        providerCallId: "call-uuid",
        timestamp: now + 1,
      });

      const activeCall = expectDefined(
        ctx.activeCalls.get("call-1"),
        "expected active call after provider id change",
      );
      expect(activeCall.providerCallId).toBe("call-uuid");
      expect(ctx.providerCallIdMap.get("call-uuid")).toBe("call-1");
      expect(ctx.providerCallIdMap.has("request-uuid")).toBe(false);

      const result = await processEvent(ctx, {
        id: "evt-old-provider-alias",
        type: "call.speech",
        callId: aliasCallId,
        providerCallId: "request-uuid",
        timestamp: now + 2,
        direction: "outbound",
        transcript: "Continue the existing call.",
        isFinal: true,
      });
      if (result.kind !== "final-speech") {
        throw new Error("expected speech for the live call");
      }
      expect(result.call).toBe(activeCall);
      expect(ctx.activeCalls.size).toBe(1);
      expect(activeCall.providerCallId).toBe("call-uuid");
      expect(ctx.providerCallIdMap.get("call-uuid")).toBe("call-1");
      expect(ctx.providerCallIdMap.has("request-uuid")).toBe(false);
    },
  );

  it.each(["admission", "status"] as const)(
    "surfaces call history read failure during %s without claiming absence or writing a call",
    async (operation) => {
      const provider = createProvider();
      const ctx = createContext({ provider });
      const manager = new CallManager(ctx.config, ctx.storePath);
      await manager.initialize(provider, "https://example.com/voice/webhook");
      const state = getOptionalVoiceCallStateRuntime()?.state;
      if (!state) {
        throw new Error("expected the fixture state runtime");
      }
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
        if (operation === "status") {
          await expect(manager.getCallFromMemoryOrStore("provider-unknown")).rejects.toThrow(
            "synthetic call history read failure",
          );
        } else {
          await expect(
            manager.processEvent({
              ...createInboundInitiatedEvent({
                id: "event-unreadable-history",
                providerCallId: "provider-unknown",
                from: "+15550000001",
              }),
              direction: "outbound",
            }),
          ).rejects.toThrow("synthetic call history read failure");
        }
      } finally {
        fault.mockRestore();
      }
      expect(manager.getActiveCalls()).toEqual([]);
      expect(await manager.getCallHistory()).toEqual([]);
    },
  );

  it("does not burn replay keys for unknown calls before a later replay can resolve them", async () => {
    const now = Date.now();
    const ctx = createContext();
    const event: NormalizedEvent = {
      id: "evt-late-call",
      dedupeKey: "stable-late-call",
      type: "call.answered",
      callId: "call-late",
      providerCallId: "provider-late",
      timestamp: now + 1,
    };

    expect(await processEvent(ctx, event)).toEqual({ kind: "ignored", replayable: true });

    expect(ctx.processedEventIds.size).toBe(0);

    registerCall(ctx, {
      callId: "call-late",
      providerCallId: "provider-late",
      direction: "inbound",
      state: "ringing",
      from: "+15550000002",
      to: "+15550000000",
      startedAt: now,
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-late", "call-late");

    await processEvent(ctx, event);

    const call = expectDefined(
      ctx.activeCalls.get("call-late"),
      "expected replayed event to resolve after call registration",
    );
    expect(call.state).toBe("answered");
    expect(call.answeredAt).toBe(now + 1);
    expect(Array.from(ctx.processedEventIds)).toEqual(["stable-late-call"]);
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
    const ctx = createContext({
      provider,
      config: normalizeVoiceCallConfig({
        enabled: true,
        provider: provider.name,
        fromNumber: "+15550000000",
        maxDurationSeconds: 1,
        ...(streaming ? { streaming: { enabled: true } } : {}),
      }),
    });
    const call = registerCall(ctx, {
      callId: "call-live",
      providerCallId: "provider-live",
      provider: provider.name,
      direction: "inbound",
      state: streaming ? "active" : "ringing",
      from: "+15550000002",
      to: "+15550000000",
      startedAt: now - 120_000,
      metadata: streaming ? { initialMessage: "hello", mode: "conversation" } : {},
    });
    ctx.providerCallIdMap.set("provider-live", call.callId);
    if (streaming) {
      await speakInitialMessage(ctx, "provider-live");
    } else {
      const base = {
        ...eventBase(call.callId, "live-event", now + 250),
        providerCallId: "provider-live",
      };
      await processEvent(
        ctx,
        type === "call.speaking"
          ? { ...base, type, text: "hello" }
          : type === "call.speech"
            ? { ...base, type, transcript: "hello", isFinal: true }
            : { ...base, type, transcript: "hello" },
      );
    }
    expect(call).toMatchObject({ state, answeredAt: streaming ? now : now + 250 });
    expect(call.transcript.map(({ speaker, text }) => ({ speaker, text }))).toEqual(transcript);
    expect(ctx.maxDurationTimers.has(call.callId)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(ctx.endCallOperations.values());
    expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "provider-live",
      reason: "timeout",
    });
    expect(ctx.activeCalls.has(call.callId)).toBe(false);
  });

  it("does not reject externally-initiated outbound calls even with disabled inbound policy", async () => {
    const { ctx, hangupCalls } = createRejectingInboundContext();
    const event: NormalizedEvent = {
      id: "evt-external-2",
      type: "call.initiated",
      callId: "CA-external-456",
      providerCallId: "CA-external-456",
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15559876543",
    };

    await processEvent(ctx, event);

    // External outbound calls bypass inbound policy — they should be accepted
    expect(ctx.activeCalls.size).toBe(1);
    expect(hangupCalls).toHaveLength(0);
    const call = requireFirstActiveCall(ctx);
    expect(ctx.providerCallIdMap.get("CA-external-456")).toBe(call.callId);
    expect(call.providerCallId).toBe("CA-external-456");
    expect(call.direction).toBe("outbound");
    expect(call.from).toBe("+15550000000");
    expect(call.to).toBe("+15559876543");
  });

  it("deduplicates by dedupeKey even when event IDs differ", async () => {
    const now = Date.now();
    const ctx = createContext();
    registerCall(ctx, {
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      state: "answered",
      startedAt: now,
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-dedupe", "call-dedupe");

    const firstResult = await processEvent(ctx, {
      id: "evt-1",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 1,
      transcript: "hello",
      isFinal: true,
    });

    const replayResult = await processEvent(ctx, {
      id: "evt-2",
      dedupeKey: "stable-key-1",
      type: "call.speech",
      callId: "call-dedupe",
      providerCallId: "provider-dedupe",
      timestamp: now + 2,
      transcript: "hello",
      isFinal: true,
    });

    const call = expectDefined(
      ctx.activeCalls.get("call-dedupe"),
      "expected deduped call to remain active",
    );
    expect(call.transcript).toHaveLength(1);
    expect(Array.from(ctx.processedEventIds)).toEqual(["stable-key-1"]);
    expect(firstResult).toMatchObject({
      kind: "final-speech",
      transcript: "hello",
      waiterResolved: false,
    });
    expect(replayResult).toEqual({ kind: "ignored" });
  });

  it.each([
    { label: "empty", transcript: "", withWaiter: false },
    { label: "whitespace with a waiter", transcript: " \t\n", withWaiter: true },
  ])("records $label final speech as a processed non-turn", async ({ transcript, withWaiter }) => {
    const now = Date.now();
    const ctx = createContext();
    const callId = `call-blank-${withWaiter ? "waiter" : "direct"}-${transcript.length}`;
    registerCall(ctx, {
      callId,
      providerCallId: `provider-${callId}`,
      provider: "telnyx",
      direction: "inbound",
      startedAt: now,
      metadata: {},
    });
    const resolve = vi.fn();
    const reject = vi.fn();
    const timeout = setTimeout(() => {}, 60_000);
    if (withWaiter) {
      ctx.transcriptWaiters.set(callId, { resolve, reject, timeout });
    }

    const result = await processEvent(ctx, {
      id: `evt-${callId}`,
      dedupeKey: `dedupe-${callId}`,
      type: "call.speech",
      callId,
      timestamp: now + 1,
      transcript,
      isFinal: true,
    });

    clearTimeout(timeout);
    expect(result).toEqual({ kind: "processed" });
    expect(ctx.activeCalls.get(callId)?.transcript).toEqual([]);
    expect(ctx.activeCalls.get(callId)?.state).toBe("listening");
    expect(ctx.processedEventIds.has(`dedupe-${callId}`)).toBe(true);
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(ctx.transcriptWaiters.has(callId)).toBe(withWaiter);
  });

  it("bounds committed replay keys in both manager and persisted call owners", async () => {
    const now = Date.now();
    const managerKeys = Array.from(
      { length: EVENT_MANAGER_REPLAY_KEY_LIMIT },
      (_, index) => `manager-${index}`,
    );
    const callKeys = Array.from({ length: MAX_CALL_REPLAY_KEYS }, (_, index) => `call-${index}`);
    const ctx = createContext({ processedEventIds: new Set(managerKeys) });
    registerCall(ctx, {
      callId: "call-bounded",
      providerCallId: "provider-bounded",
      startedAt: now,
      processedEventIds: callKeys,
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-bounded", "call-bounded");

    const result = await processEvent(ctx, {
      id: "evt-bounded-new",
      type: "call.dtmf",
      callId: "call-bounded",
      providerCallId: "provider-bounded",
      timestamp: now + 1,
      digits: "1",
    });

    const call = ctx.activeCalls.get("call-bounded");
    expect(result).toEqual({ kind: "processed" });
    expect(ctx.processedEventIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
    expect(ctx.processedEventIds.has("manager-0")).toBe(false);
    expect(ctx.processedEventIds.has("evt-bounded-new")).toBe(true);
    expect(call?.processedEventIds).toHaveLength(MAX_CALL_REPLAY_KEYS);
    expect(call?.processedEventIds[0]).toBe("call-1");
    expect(call?.processedEventIds.at(-1)).toBe("evt-bounded-new");
    expect(
      await processEvent(ctx, {
        id: "evt-bounded-new",
        type: "call.dtmf",
        callId: "call-bounded",
        providerCallId: "provider-bounded",
        timestamp: now + 2,
        digits: "1",
      }),
    ).toEqual({ kind: "ignored" });
  });

  it("keeps retryable call.error events replayable", async () => {
    const now = Date.now();
    const ctx = createContext();
    registerCall(ctx, {
      callId: "call-retryable-error",
      providerCallId: "provider-retryable-error",
      startedAt: now,
      metadata: {},
    });
    ctx.providerCallIdMap.set("provider-retryable-error", "call-retryable-error");

    const event: NormalizedEvent = {
      id: "evt-retryable-error",
      dedupeKey: "stable-retryable-error",
      type: "call.error",
      callId: "call-retryable-error",
      providerCallId: "provider-retryable-error",
      timestamp: now + 1,
      error: "temporary upstream failure",
      retryable: true,
    };

    expect(await processEvent(ctx, event)).toEqual({ kind: "processed", replayable: true });
    await processEvent(ctx, event);

    const call = expectDefined(
      ctx.activeCalls.get("call-retryable-error"),
      "expected retryable error call to remain active",
    );
    expect(call.state).toBe("active");
    expect(Array.from(ctx.processedEventIds)).toStrictEqual([]);
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
