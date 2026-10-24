import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { normalizeVoiceCallConfig } from "../config.js";
import { EVENT_MANAGER_REPLAY_KEY_LIMIT } from "../manager.test-harness.js";
import type { AnswerCallInput, CallRecord, HangupCallInput } from "../types.js";
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
} from "./events.test-support.js";
import { speakInitialMessage } from "./outbound.js";
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

function transcriptWaiter(ctx: CallManagerContext, call: CallRecord, register = true) {
  const waiter = { resolve: vi.fn(), reject: vi.fn(), timeout: setTimeout(() => {}, 60_000) };
  if (register) {
    ctx.transcriptWaiters.set(call.callId, waiter);
  } else {
    clearTimeout(waiter.timeout);
  }
  return waiter;
}

function inboundContext(
  config: Record<string, unknown> = {},
  options: Partial<CallManagerContext> = {},
) {
  return createContext({ config: inboundConfig(config), ...options });
}

function delayedOperation() {
  const result = createDeferred<void>();
  const started = createDeferred<void>();
  const invoke = vi.fn(() => {
    started.resolve();
    return result.promise;
  });
  return { ...result, started: started.promise, invoke };
}

it.each(["carrier", "finalization"])("reports %s cleanup failure", async (failure) => {
  let failPersistence = false;
  installStateRuntime(() => failPersistence);
  const hangupCall = vi.fn(async () => {
    if (failure === "carrier") {
      throw new Error("synthetic private carrier response");
    }
    failPersistence = true;
  });
  const { ctx, call, send, work } = amdContext(
    {},
    {
      config: normalizeVoiceCallConfig({
        voicemail: { detection: "twilio", onMachine: "hang-up" },
      }),
    },
    { hangupCall },
  );
  await send({ type: "call.amd", answeredBy: "machine_start" });
  await Promise.all(work);
  expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
    callId: call.callId,
    providerCallId: "provider-1",
    reason: "voicemail",
  });
  expect(logSpy.logEntries).toEqual([
    "Detected-call cleanup failed for " + call.callId + "; inspect voice-call status and logs.",
  ]);
  expect(ctx.activeCalls.get(call.callId)).toBe(call);
  expect(call.endedAt).toBeUndefined();
});

it.each(["speech", "terminal", "fatal-error"] as const)(
  "publishes %s effects only after persistence",
  async (kind) => {
    let failPersistence = true;
    installStateRuntime(() => failPersistence);
    const { ctx, call, event, send } = fixture();
    const terminal = kind === "terminal" || kind === "fatal-error";
    const endReason = kind === "fatal-error" ? "error" : "hangup-user";
    const { resolve, reject } = transcriptWaiter(ctx, call);
    if (terminal) {
      ctx.maxDurationTimers.set(
        call.callId,
        setTimeout(() => {}, 60_000),
      );
    }
    const input = event(
      kind === "speech"
        ? { type: "call.speech", transcript: "durable", isFinal: true }
        : kind === "fatal-error"
          ? { type: "call.error", error: "carrier failure", retryable: false }
          : { type: "call.ended", reason: "hangup-user" },
    );
    await expect(processEvent(ctx, input)).rejects.toThrow("synthetic SQLite persistence failure");
    expect(ctx.processedEventIds.has(input.id)).toBe(false);
    expect(call).toMatchObject({
      processedEventIds: [],
      transcript: [],
    });
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(ctx.maxDurationTimers.has(call.callId)).toBe(terminal);
    failPersistence = false;
    ctx.beforeCallEnd = async () => {
      if (kind === "fatal-error") {
        throw new Error("bridge close failed");
      }
      await send({ type: "call.assistant-speech", transcript: "The plumber will call back." });
    };
    await processEvent(ctx, input);
    expect(ctx.processedEventIds.has(input.id)).toBe(true);
    expect(resolve).toHaveBeenCalledTimes(kind === "speech" ? 1 : 0);
    expect(reject).toHaveBeenCalledTimes(terminal ? 1 : 0);
    expect(ctx.activeCalls.has(call.callId)).toBe(!terminal);
    if (terminal) {
      expect(call).toMatchObject({ state: endReason, endReason, endedAt: input.timestamp });
      expect(call.transcript).toMatchObject(
        kind === "fatal-error" ? [] : [{ speaker: "bot", text: "The plumber will call back." }],
      );
      expect(reject).toHaveBeenCalledWith(
        new Error(
          kind === "fatal-error" ? "Call error: carrier failure" : "Call ended: hangup-user",
        ),
      );
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
    await send({ type: "call.answered", providerCallId: "call-uuid" });
    const result = await send({
      type: "call.speech",
      callId: aliasCallId,
      providerCallId: "request-uuid",
      direction: "outbound",
      transcript: "Continue the existing call.",
      isFinal: true,
    });
    expect(result.kind === "final-speech" ? result.call : undefined).toBe(call);
    expect(ctx.activeCalls.size).toBe(1);
    expect(call.providerCallId).toBe("call-uuid");
    expect(ctx.providerCallIdMap).toEqual(new Map([["call-uuid", call.callId]]));
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
  [{ type: "call.speaking", text: "hello" }, "speaking", []],
  [
    { type: "call.assistant-speech", transcript: "hello" },
    "speaking",
    [{ speaker: "bot", text: "hello" }],
  ],
  [
    { type: "call.speech", transcript: "hello", isFinal: true },
    "listening",
    [{ speaker: "user", text: "hello" }],
  ],
  [null, "speaking", [{ speaker: "bot", text: "hello" }]],
] as const)("starts duration before answered: %j", async (input, state, transcript) => {
  const now = Date.parse("2026-03-22T12:00:00.000Z");
  vi.useFakeTimers({ now });
  const hangupCall = vi.fn(async (_input: HangupCallInput) => {});
  const provider = {
    ...createProvider({ name: "twilio", hangupCall }),
    isConversationStreamConnectEnabled: () => true,
  };
  const { ctx, call, send } = fixture(
    {
      direction: "inbound",
      startedAt: now - 120_000,
      metadata: { initialMessage: "hello", mode: "conversation" },
    },
    {
      provider,
      config: inboundConfig({
        maxDurationSeconds: 1,
        provider: provider.name,
        streaming: { enabled: true },
      }),
    },
  );
  if (input) {
    await send({ ...input, timestamp: now + 250 });
  } else {
    await speakInitialMessage(ctx, "provider-1");
  }
  expect(call).toMatchObject({ state, answeredAt: input ? now + 250 : now });
  expect(call.transcript.map(({ speaker, text }) => ({ speaker, text }))).toEqual(transcript);
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

it.each([
  ["hello", false],
  ["", false],
  [" \t\n", true],
] as const)(
  "commits final speech %j once without consuming blank turns (waiter=%s)",
  async (transcript, withWaiter) => {
    const { ctx, call, event } = fixture();
    const { resolve, reject, timeout } = transcriptWaiter(ctx, call, withWaiter);
    const input = event({ type: "call.speech", transcript, isFinal: true, dedupeKey: "speech" });
    const result = await processEvent(ctx, input);
    clearTimeout(timeout);
    expect(result).toMatchObject(
      transcript.trim()
        ? { kind: "final-speech", transcript: "hello", waiterResolved: false }
        : { kind: "processed" },
    );
    expect(call.state).toBe("listening");
    expect(call.transcript).toEqual(
      transcript.trim() ? [expect.objectContaining({ speaker: "user", text: "hello" })] : [],
    );
    expect([...ctx.processedEventIds]).toEqual(["speech"]);
    expect(resolve).not.toHaveBeenCalled();
    expect(reject).not.toHaveBeenCalled();
    expect(ctx.transcriptWaiters.has(call.callId)).toBe(withWaiter);
    expect(
      await processEvent(ctx, { ...input, id: "redelivery", timestamp: input.timestamp + 1 }),
    ).toEqual({ kind: "ignored" });
    expect(call.transcript).toHaveLength(transcript.trim() ? 1 : 0);
  },
);

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
    const ctx = inboundContext(
      {
        provider: "plivo",
        inboundPolicy,
        allowFrom: [allowed ? phone : "+15550001111"],
      },
      { provider: hasProvider ? createProvider() : null },
    );
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

it.each([false, true])(
  "reports unconsumed speech after its waiter expires (replacement=%s)",
  async (replacement) => {
    vi.useFakeTimers();
    const { ctx, call, send } = fixture({
      callId: "call-expiring-waiter",
      providerCallId: "provider-expiring-waiter",
      direction: "inbound",
      state: "listening",
      answeredAt: Date.now(),
    });
    ctx.config.transcriptTimeoutMs = 30;
    const gate = delayedOperation();
    const persist = callStore.persistCallRecord;
    vi.spyOn(callStore, "persistCallRecord").mockImplementationOnce(async (...args) => {
      await gate.invoke();
      await persist(...args);
    });
    const waiting = waitForFinalTranscript(ctx, call.callId);
    const timedOut = expect(waiting).rejects.toThrow("Timed out waiting for transcript");
    const pending = send({
      id: "speech-before-timeout",
      type: "call.speech",
      transcript: "Persist this utterance",
      isFinal: true,
    });
    let replacementSettled = false;
    try {
      await gate.started;
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
      gate.resolve();
      await expect(pending).resolves.toMatchObject({ kind: "final-speech", waiterResolved: false });
      expect(replacementSettled).toBe(false);
      expect(ctx.transcriptWaiters.has(call.callId)).toBe(replacement);
      expect(call.transcript.at(-1)?.text).toBe("Persist this utterance");
      expect(ctx.processedEventIds.has("speech-before-timeout")).toBe(true);
    } finally {
      gate.resolve();
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

it.each([
  ["call.initiated", "ringing", "main"],
  ["call.ringing", "ringing", "per-call"],
  ["call.active", "active", "per-call"],
] as const)("routes inbound %s events (%s/%s)", async (type, state, sessionScope) => {
  const ctx = inboundContext(
    {
      sessionScope,
      inboundGreeting: "Global greeting",
      numbers: { "+15550002222": { agentId: "cards", inboundGreeting: "Cards greeting" } },
    },
    { provider: createProvider(), coreSession: { mainKey: "work" } },
  );
  await processEvent(ctx, {
    ...inboundEvent("inbound", "provider-inbound", "+15552222222"),
    type,
    to: "+1 (555) 000-2222",
  });
  const call = requireFirstActiveCall(ctx);
  expect(call).toMatchObject({
    provider: "plivo",
    providerCallId: "provider-inbound",
    direction: "inbound",
    from: "+15552222222",
    to: "+1 (555) 000-2222",
    state,
    agentId: "cards",
    metadata: { initialMessage: "Cards greeting", numberRouteKey: "+15550002222" },
    sessionKey:
      sessionScope === "main" ? "agent:cards:work" : `agent:cards:voice:call:${call.callId}`,
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
    const ctx = inboundContext(
      {
        inboundPolicy: policy,
        callbacks: { enabled: true, windowMinutes: 30, greeting: "I can take a message." },
        realtime: { enabled: realtimeEnabled },
      },
      { provider: createProvider({ hangupCall: hangup }) },
    );
    const original = createCall({
      callId: "original",
      providerCallId: "original-provider",
      state: "completed",
      to: "+15554444444",
      startedAt: Date.now() - ageMinutes * 60_000,
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
    const event = inboundEvent(`event-durable-${kind}`, `provider-durable-${kind}`, "+15550000002");

    await expect(processEvent(ctx, event)).rejects.toThrow("synthetic SQLite persistence failure");
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
  const ctx = inboundContext({}, { provider: createProvider({ answerCall }) });
  await processEvent(ctx, inboundEvent("evt-answer", "call-control-1"));
  expect(answerCall).toHaveBeenCalledExactlyOnceWith({
    callId: requireFirstActiveCall(ctx).callId,
    providerCallId: "call-control-1",
  });
});

it("bounds rejected provider calls while retaining hangup-once behavior", async () => {
  const rejectedProviderCallIds = new Set<string>(
    Array.from({ length: EVENT_MANAGER_REPLAY_KEY_LIMIT }, (_, index) => `provider-${index}`),
  );
  const { ctx, hangupCalls } = createRejectingInboundContext();
  ctx.rejectedProviderCallIds = rejectedProviderCallIds;

  await processEvent(ctx, inboundEvent("evt-rejected-new", "provider-new", "+15552222222"));
  await processEvent(ctx, inboundEvent("evt-rejected-new-replay", "provider-new", "+15552222222"));

  expect(ctx.rejectedProviderCallIds.size).toBe(EVENT_MANAGER_REPLAY_KEY_LIMIT);
  expect(ctx.rejectedProviderCallIds.has("provider-0")).toBe(false);
  expect(ctx.rejectedProviderCallIds.has("provider-new")).toBe(true);
  expect(hangupCalls).toHaveLength(1);
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

it.each([false, true])("waits for realtime voicemail (failure=%s)", async (failed) => {
  const playback = delayedOperation();
  const beforeCarrierPlayback = vi.fn();
  const { call, send, work, hangup, playMessageAndHangup } = amdContext(
    { brief: { voicemailMessage: "We will call again later." } },
    { playRealtimeVoicemail: playback.invoke, beforeCarrierPlayback },
  );
  await send({ type: "call.amd", answeredBy: "machine_end_beep" });
  await playback.started;
  expect(playback.invoke).toHaveBeenCalledWith(
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
});

it.each(["human", "unknown", "machine_end_beep"])(
  "hands off %s playback once after bridge preparation",
  async (answeredBy) => {
    const machine = answeredBy === "machine_end_beep";
    const message = machine ? "Please call me back." : "Your parcel is ready.";
    const prepared = delayedOperation();
    const { call, send, work, hangup, playMessageAndHangup } = amdContext(
      {
        mode: "notify",
        pendingNotifyAmd: true,
        initialMessage: "Your parcel is ready.",
        brief: { task: "Arrange a plumber", voicemailMessage: "Please call me back." },
      },
      { beforeCarrierPlayback: prepared.invoke },
    );
    playMessageAndHangup.mockImplementation(async () => {
      expect(call.metadata?.[machine ? "voicemailStatus" : "notifyStatus"]).toBe("playing");
      expect(call.transcript).toMatchObject([{ speaker: "bot", text: message }]);
    });
    if (machine) {
      await send({ type: "call.amd", answeredBy: "machine_start" });
      expect(playMessageAndHangup).not.toHaveBeenCalled();
    }
    await send({ type: "call.amd", answeredBy });
    await send({ type: "call.amd", answeredBy, id: "redelivery" });
    expect(call.metadata).toMatchObject({
      answeredByFirst: machine ? "machine_start" : answeredBy,
      answeredBy,
    });
    await prepared.started;
    expect(prepared.invoke).toHaveBeenCalledExactlyOnceWith(call.callId);
    expect(playMessageAndHangup).not.toHaveBeenCalled();
    prepared.resolve();
    await Promise.all(work);
    expect(playMessageAndHangup).toHaveBeenCalledExactlyOnceWith({
      callId: call.callId,
      providerCallId: "provider-1",
      text: message,
    });
    expect(hangup).not.toHaveBeenCalled();
    expect(call.endReason).toBeUndefined();
    await send({ type: "call.ended", reason: "completed", answeredBy });
    expect(call.metadata).toMatchObject({
      [machine ? "voicemailStatus" : "notifyStatus"]: "left",
      answeredByFirst: machine ? "machine_start" : answeredBy,
      answeredBy,
    });
    expect(call.endReason).toBe(machine ? "voicemail" : "completed");
  },
);

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

it.each(["off", "hang-up", "fax"] as const)(
  "handles AMD policy %s without speaking",
  async (mode) => {
    const { call, send, work, hangup, playMessageAndHangup } = amdContext(
      { pendingNotifyAmd: mode === "fax" },
      {
        config: normalizeVoiceCallConfig({
          voicemail: { detection: mode === "off" ? "off" : "twilio", onMachine: "hang-up" },
        }),
      },
    );
    await send({ type: "call.amd", answeredBy: mode === "fax" ? "fax" : "machine_start" });
    await Promise.all(work);
    expect(playMessageAndHangup).not.toHaveBeenCalled();
    expect(hangup).toHaveBeenCalledTimes(mode === "off" ? 0 : 1);
    expect(call.metadata?.voicemailStatus).toBe(mode === "hang-up" ? "hang-up" : undefined);
    expect(call.endReason).toBe(
      mode === "off" ? undefined : mode === "fax" ? "failed" : "voicemail",
    );
  },
);
