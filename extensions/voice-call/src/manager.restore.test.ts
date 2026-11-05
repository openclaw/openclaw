import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { normalizeVoiceCallConfig } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  createVoiceCallStateRuntimeForTests,
  FakeProvider,
  makePersistedCall,
  registerTestManagerCleanup,
  writeCallsToStore,
} from "./manager.test-harness.js";
import { MAX_CALL_REPLAY_KEYS } from "./manager/replay-keys.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./manager/store.js";
import { PlivoProvider } from "./providers/plivo.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";

function installStateRuntime(): VoiceCallStateRuntime["state"] {
  const state = createVoiceCallStateRuntimeForTests();
  setVoiceCallStateRuntime({ state });
  return state;
}

const requireRecord = createRequireRecord("record", "expected-label-record");
function requireSingleActiveCall(manager: CallManager) {
  const activeCalls = manager.getActiveCalls();
  expect(activeCalls).toHaveLength(1);
  return expectDefined(activeCalls[0], "restored active call");
}

function requireSingleHangupCall(provider: FakeProvider) {
  expect(provider.hangupCalls).toHaveLength(1);
  return requireRecord(provider.hangupCalls[0], "hangup call");
}

async function expectExpired(manager: CallManager, provider: FakeProvider, storePath: string) {
  expect(manager.getActiveCalls()).toEqual([]);
  expect(requireSingleHangupCall(provider).reason).toBe("timeout");
  expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
}

function completedCall(overrides: Parameters<typeof makePersistedCall>[0] = {}) {
  return makePersistedCall({
    state: "completed",
    endReason: "completed",
    endedAt: Date.now(),
    ...overrides,
  });
}

beforeEach(() => {
  resetPluginStateStoreForTests();
  installStateRuntime();
  // Finish hooks are LIFO: managers must persist terminal state before stores
  // close, and clear fake timers before the clock is restored.
  onTestFinished(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    resetPluginStateStoreForTests();
  });
});

async function initializeManager(
  callOverrides: Parameters<typeof makePersistedCall>[0] = {},
  maxDurationSeconds?: number,
  provider = new FakeProvider(),
) {
  const storePath = createTestStorePath();
  await writeCallsToStore(storePath, [makePersistedCall(callOverrides)]);
  const manager = await restoreManager(storePath, { maxDurationSeconds }, provider);
  return { manager, provider, storePath };
}

async function restoreManager(
  storePath: string,
  overrides: Record<string, unknown> = {},
  provider = new FakeProvider(),
  state?: VoiceCallStateRuntime["state"],
) {
  const config = normalizeVoiceCallConfig({
    enabled: true,
    provider: "plivo",
    fromNumber: "+15550000000",
    ...overrides,
  });
  const manager = registerTestManagerCleanup(new CallManager(config, storePath, undefined, state));
  await manager.initialize(provider, "https://example.com/voice/webhook");
  return manager;
}

it("refuses unowned active calls and delayed webhooks without rewriting their history", async () => {
  const storePath = createTestStorePath();
  await writeCallsToStore(storePath, [
    makePersistedCall({
      callId: "unowned-active",
      providerCallId: "unowned-provider",
      agentId: undefined,
      sessionKey: "agent:old-owner:voice:unowned",
      transcript: [
        { timestamp: 1, speaker: "user", text: "Keep this café transcript", isFinal: true },
      ],
    }),
    completedCall({
      callId: "unowned-history",
      providerCallId: "completed-provider",
      agentId: undefined,
    }),
    makePersistedCall({
      callId: "owned-active",
      providerCallId: "owned-provider",
      agentId: "recorded-owner",
    }),
  ]);
  const before = await getCallHistoryFromStore(storePath);
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const provider = new FakeProvider();
  const status = vi.spyOn(provider, "getCallStatus");
  const manager = await restoreManager(storePath, { agentId: "new-default" }, provider);
  expect(manager.getActiveCalls().map((call) => [call.callId, call.agentId])).toEqual([
    ["owned-active", "recorded-owner"],
  ]);
  expect(status).toHaveBeenCalledExactlyOnceWith({ providerCallId: "owned-provider" });
  expect(provider.hangupCalls).toEqual([]);
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("Start a new call and hang up any remaining call with your provider"),
  );
  await expect(
    manager.processEvent({
      id: "late-event",
      type: "call.speech",
      callId: "unowned-active",
      providerCallId: "unowned-provider",
      direction: "outbound",
      timestamp: Date.now(),
      transcript: "late callback",
      isFinal: true,
    }),
  ).resolves.toEqual({ kind: "ignored", replayable: true });
  expect(await getCallHistoryFromStore(storePath)).toEqual(before);
  await expect(manager.getCallFromMemoryOrStore("completed-provider")).resolves.toEqual(
    requireRecord(
      before.find((call) => call.callId === "unowned-history"),
      "completed call history",
    ),
  );
});

it("restores existing records through the retained runtime without a data migration", async () => {
  const retainedStateRuntime = installStateRuntime();
  const storePath = createTestStorePath();
  const call = completedCall();
  await writeCallsToStore(storePath, [call]);
  setVoiceCallStateRuntime({
    state: {
      ...retainedStateRuntime,
      openKeyedStoreV2: () => {
        throw new Error("ambient state runtime must not own retained manager records");
      },
    },
  });

  const manager = await restoreManager(storePath, {}, new FakeProvider(), retainedStateRuntime);

  await expect(manager.getCallFromMemoryOrStore(String(call.callId))).resolves.toMatchObject({
    callId: call.callId,
    state: "completed",
  });
});

it("prefers active provider state before persisted fallback", async () => {
  const storePath = createTestStorePath();
  await writeCallsToStore(storePath, [
    completedCall({ callId: "call-target", providerCallId: "provider-completed" }),
    makePersistedCall({ callId: "call-active", providerCallId: "call-target" }),
  ]);
  const manager = await restoreManager(storePath);

  expect(manager.getCallByProviderCallId("call-target")?.callId).toBe("call-active");
  expect(await manager.getCallFromMemoryOrStore("call-target")).toMatchObject({
    callId: "call-active",
    state: "answered",
  });
});

it.each([
  ["expired brief", 20_000, 19_000, 10, 0, 0],
  ["brief excludes ringing", 35_000, 10_000, 30, 20_000, 0],
  ["exact deadline", 30_000, 30_000, 30, 1, 0],
  ["deadline during probe", 29_000, 29_000, 30, 1, 2_000],
  ["missing live anchor", 290_000, undefined, undefined, 10_000, 0],
] as const)(
  "restores max-duration policy: %s",
  async (_, startedAgo, answeredAgo, cap, wait, probeDelay) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const now = Date.now();
    const provider = new FakeProvider();
    if (probeDelay) {
      provider.getCallStatus = async () => {
        vi.setSystemTime(now + probeDelay);
        return { status: "in-progress", isTerminal: false };
      };
    }
    const unanchored = answeredAgo === undefined;
    const { manager, storePath } = await initializeManager(
      {
        state: unanchored ? "listening" : "answered",
        startedAt: now - startedAgo,
        answeredAt: unanchored ? undefined : now - answeredAgo,
        metadata: { maxDurationSeconds: cap },
      },
      300,
      provider,
    );
    if (wait) {
      const call = requireSingleActiveCall(manager);
      if (unanchored) {
        expect(call).toMatchObject({ state: "listening", answeredAt: now - startedAgo });
        expect(
          (await loadActiveCallsFromStore(storePath)).activeCalls.get(call.callId)?.answeredAt,
        ).toBe(call.answeredAt);
      }
      expect(provider.hangupCalls).toEqual([]);
      if (wait > 1) {
        await vi.advanceTimersByTimeAsync(wait - 1);
        expect(manager.getActiveCalls()).toHaveLength(1);
        expect(provider.hangupCalls).toEqual([]);
      }
      await vi.advanceTimersByTimeAsync(1);
      await manager.stop();
    }
    await expectExpired(manager, provider, storePath);
  },
);

it("summarizes repeated restored-call verification outcomes", async () => {
  const now = Date.now();
  const storePath = createTestStorePath();
  const rows = [
    ["missing-provider-a", undefined, 10_000],
    ["missing-provider-b", undefined, 10_000],
    ["expired-a", "expired-provider-a", 600_000],
    ["terminal-a", "terminal-provider-a", 20_000],
    ["terminal-b", "terminal-provider-b", 20_000],
    ["active-a", "active-provider-a"],
    ["unknown-a", "unknown-provider-a"],
    ["failure-a", "failure-provider-a"],
  ] as const;
  await writeCallsToStore(
    storePath,
    rows.map(([callId, providerCallId, age]) =>
      makePersistedCall({
        callId,
        providerCallId,
        state: age ? "initiated" : "answered",
        startedAt: now - (age ?? 30_000),
        answeredAt: age ? undefined : now - 25_000,
      }),
    ),
  );

  const provider = new FakeProvider();
  provider.getCallStatus = async ({ providerCallId }) => {
    if (providerCallId.startsWith("terminal-provider")) {
      return { status: "completed", isTerminal: true };
    }
    if (providerCallId.startsWith("unknown-provider")) {
      return { status: "unknown", isTerminal: false, isUnknown: true };
    }
    if (providerCallId.startsWith("active-provider")) {
      return { status: "in-progress", isTerminal: false };
    }
    throw new Error("network failure");
  };
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  const manager = await restoreManager(storePath, { maxDurationSeconds: 300 }, provider);

  expect(
    manager
      .getActiveCalls()
      .map(({ callId, state }) => [callId, state] as const)
      .toSorted(([a], [b]) => a.localeCompare(b)),
  ).toEqual([
    ["active-a", "answered"],
    ["failure-a", "answered"],
    ["unknown-a", "answered"],
  ]);
  expect(requireSingleHangupCall(provider)).toMatchObject({
    callId: "expired-a",
    providerCallId: "expired-provider-a",
    reason: "timeout",
  });
  for (const message of [
    "Skipped 2 restored call(s) with no providerCallId",
    "Skipped 1 restored call(s) older than maxDurationSeconds",
    "Skipped 2 restored call(s) with provider status: completed",
    "Kept 1 restored call(s) confirmed active by provider",
    "Kept 1 restored call(s) with unknown provider status (relying on timer)",
    "Kept 1 restored call(s) after verification failure (relying on timer)",
  ]) {
    expect(logSpy).toHaveBeenCalledWith(`[voice-call] ${message}`);
  }
  expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("terminal-a");
});

it("keeps terminal identity when a replay key is retained or evicted", async () => {
  const storePath = createTestStorePath();
  const replayKeys = Array.from(
    { length: MAX_CALL_REPLAY_KEYS + 2 },
    (_, index) => `evt-terminal-${index}`,
  );
  const persisted = completedCall({
    endedAt: Date.now() - 5_000,
    processedEventIds: replayKeys,
  });
  await writeCallsToStore(storePath, [persisted]);

  const manager = await restoreManager(storePath);
  for (const id of [replayKeys.at(-1) as string, replayKeys[0] as string]) {
    await manager.processEvent({
      id,
      type: "call.initiated",
      callId: String(persisted.providerCallId),
      providerCallId: String(persisted.providerCallId),
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15550000001",
    });
    expect(manager.getActiveCalls()).toHaveLength(0);
  }
  expect(new Set((await manager.getCallHistory()).map((call) => call.callId))).toEqual(
    new Set([persisted.callId]),
  );
});

it("resolves a late Plivo request alias to the terminal snapshot after restart", async () => {
  const storePath = createTestStorePath();
  await writeCallsToStore(storePath, [
    makePersistedCall({
      callId: "aliased",
      providerCallId: "request-uuid",
      agentId: "sales",
      sessionKey: "agent:sales:voice:fixture",
    }),
  ]);
  const provider = new FakeProvider();
  const previous = await restoreManager(storePath, {}, provider);
  await previous.processEvent({
    id: "answer",
    type: "call.answered",
    callId: "aliased",
    providerCallId: "call-uuid",
    timestamp: Date.now(),
  });
  await expect(previous.speak("aliased", "Recorded.")).resolves.toEqual({ success: true });
  await expect(previous.endCall("aliased")).resolves.toEqual({ success: true });
  const terminal = await previous.getCallFromMemoryOrStore("aliased");
  expect(terminal).toMatchObject({
    agentId: "sales",
    sessionKey: "agent:sales:voice:fixture",
    state: "hangup-bot",
    transcript: [expect.objectContaining({ text: "Recorded." })],
  });
  resetPluginStateStoreForTests();
  const manager = await restoreManager(storePath, { agentId: "default-agent" }, provider);
  const { events } = new PlivoProvider({
    authId: "MA-fixture",
    authToken: "synthetic-token",
  }).parseWebhookEvent({
    headers: {},
    method: "POST",
    url: "https://example.com/voice/webhook",
    query: {},
    rawBody:
      "RequestUUID=request-uuid&CallStatus=ringing&Direction=outbound&From=%2B15550000000&To=%2B15550000001",
  });
  expect(events).toHaveLength(1);
  await expect(
    manager.processEvent(expectDefined(events[0], "late Plivo callback")),
  ).resolves.toEqual({ kind: "ignored" });
  expect(await manager.getCallFromMemoryOrStore("request-uuid")).toEqual(terminal);
  expect(new Set((await manager.getCallHistory()).map(({ callId }) => callId))).toEqual(
    new Set(["aliased"]),
  );
  expect(manager.getActiveCalls()).toEqual([]);
  expect(provider.playTtsCalls).toHaveLength(1);
  expect(provider.hangupCalls).toHaveLength(1);
  expect(provider.startListeningCalls).toEqual([]);
});
