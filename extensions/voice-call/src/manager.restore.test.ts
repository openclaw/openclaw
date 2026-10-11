import type { OpenAsyncKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import {
  createPluginStateKeyedStoreForTests,
  resetPluginStateStoreForTests,
} from "openclaw/plugin-sdk/plugin-state-test-runtime";
// Voice Call tests cover manager.restore plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { VoiceCallConfigSchema } from "./config.js";
import { CallManager } from "./manager.js";
import {
  createTestStorePath,
  FakeProvider,
  makePersistedCall,
  registerTestManagerCleanup,
  writeCallsToStore,
} from "./manager.test-harness.js";
import { MAX_CALL_REPLAY_KEYS } from "./manager/replay-keys.js";
import { getCallHistoryFromStore, loadActiveCallsFromStore } from "./manager/store.js";
import { setVoiceCallStateRuntime, type VoiceCallStateRuntime } from "./runtime-state.js";

function installStateRuntime(): VoiceCallStateRuntime["state"] {
  const state: VoiceCallStateRuntime["state"] = {
    resolveStateDir: () => "",
    openKeyedStore: (options: OpenAsyncKeyedStoreOptions) =>
      createPluginStateKeyedStoreForTests("voice-call", options),
    openChannelIngressQueue: (() => {
      throw new Error("openChannelIngressQueue is not used by voice-call restore tests");
    }) as never,
    openChannelIngressDrain: (() => {
      throw new Error("openChannelIngressDrain is not used by voice-call restore tests");
    }) as never,
  };
  setVoiceCallStateRuntime({ state });
  return state;
}

function requireSingleActiveCall(manager: CallManager) {
  const activeCalls = manager.getActiveCalls();
  expect(activeCalls).toHaveLength(1);
  const activeCall = activeCalls[0];
  if (!activeCall) {
    throw new Error("expected restored active call");
  }
  return activeCall;
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireSingleHangupCall(provider: FakeProvider) {
  expect(provider.hangupCalls).toHaveLength(1);
  return requireRecord(provider.hangupCalls[0], "hangup call");
}

describe("CallManager verification on restore", () => {
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

  async function initializeManager(params?: {
    callOverrides?: Parameters<typeof makePersistedCall>[0];
    configOverrides?: Partial<{ maxDurationSeconds: number }>;
    provider?: FakeProvider;
  }) {
    const storePath = createTestStorePath();
    const call = makePersistedCall(params?.callOverrides);
    await writeCallsToStore(storePath, [call]);

    const provider = params?.provider ?? new FakeProvider();

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      ...params?.configOverrides,
    });
    const manager = registerTestManagerCleanup(new CallManager(config, storePath));
    await manager.initialize(provider, "https://example.com/voice/webhook");

    return { call, manager, provider, storePath };
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
      makePersistedCall({
        callId: "unowned-history",
        providerCallId: "completed-provider",
        agentId: undefined,
        state: "completed",
        endReason: "completed",
        endedAt: Date.now(),
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
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      agentId: "new-default",
    });
    const manager = registerTestManagerCleanup(new CallManager(config, storePath));
    await manager.initialize(provider, "https://example.com/voice/webhook");
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
    const call = makePersistedCall({
      callId: "call-before-runtime-threading",
      state: "completed",
      endReason: "completed",
      endedAt: Date.now(),
    });
    await writeCallsToStore(storePath, [call]);
    setVoiceCallStateRuntime({
      state: {
        ...retainedStateRuntime,
        openKeyedStore: () => {
          throw new Error("ambient state runtime must not own retained manager records");
        },
      },
    });

    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = registerTestManagerCleanup(
      new CallManager(config, storePath, undefined, retainedStateRuntime),
    );
    await manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    await expect(manager.getCallFromMemoryOrStore(String(call.callId))).resolves.toMatchObject({
      callId: call.callId,
      state: "completed",
    });
  });

  it("prefers active provider state before persisted fallback", async () => {
    const storePath = createTestStorePath();
    await writeCallsToStore(storePath, [
      makePersistedCall({
        callId: "call-target",
        providerCallId: "provider-completed",
        state: "completed",
        endReason: "completed",
        endedAt: Date.now(),
      }),
      makePersistedCall({
        callId: "call-active",
        providerCallId: "call-target",
        state: "answered",
      }),
    ]);
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = registerTestManagerCleanup(new CallManager(config, storePath));
    await manager.initialize(new FakeProvider(), "https://example.com/voice/webhook");

    expect(manager.getCallByProviderCallId("call-target")?.callId).toBe("call-active");
    expect(await manager.getCallFromMemoryOrStore("call-target")).toMatchObject({
      callId: "call-active",
      state: "answered",
    });
  });

  it("expires a restored call at its persisted brief duration cap", async () => {
    const { manager, provider, storePath } = await initializeManager({
      callOverrides: {
        startedAt: Date.now() - 20_000,
        answeredAt: Date.now() - 19_000,
        metadata: { maxDurationSeconds: 10 },
      },
      configOverrides: { maxDurationSeconds: 300 },
    });
    expect(manager.getActiveCalls()).toHaveLength(0);
    expect(requireSingleHangupCall(provider).reason).toBe("timeout");
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
  });

  it("restores the remaining brief duration without charging time spent ringing", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const now = Date.now();
    const { manager, provider, storePath } = await initializeManager({
      callOverrides: {
        startedAt: now - 35_000,
        answeredAt: now - 10_000,
        metadata: { maxDurationSeconds: 30 },
      },
    });
    requireSingleActiveCall(manager);
    expect(provider.hangupCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(provider.hangupCalls).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await manager.stop();
    expect(requireSingleHangupCall(provider).reason).toBe("timeout");
    expect(manager.getActiveCalls()).toEqual([]);
    expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
  });

  it.each([0, 2_000])(
    "hangs up a call that reaches its deadline during a %ims restore probe",
    async (probeDelay) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      const now = Date.now();
      const answeredAt = now - (probeDelay ? 29_000 : 30_000);
      const provider = new FakeProvider();
      provider.getCallStatus = async () => {
        vi.setSystemTime(now + probeDelay);
        return { status: "in-progress", isTerminal: false };
      };
      const { manager, storePath } = await initializeManager({
        provider,
        callOverrides: {
          startedAt: answeredAt,
          answeredAt,
          metadata: { maxDurationSeconds: 30 },
        },
      });
      await vi.advanceTimersByTimeAsync(1);
      await manager.stop();
      expect(requireSingleHangupCall(provider).reason).toBe("timeout");
      expect(manager.getActiveCalls()).toEqual([]);
      expect((await loadActiveCallsFromStore(storePath)).activeCalls.size).toBe(0);
    },
  );

  it("summarizes repeated restored-call verification outcomes", async () => {
    const now = Date.now();
    const storePath = createTestStorePath();
    const calls = [
      ["missing-provider-a", undefined, 10_000],
      ["missing-provider-b", undefined, 10_000],
      ["expired-a", "expired-provider-a", 600_000],
      ["terminal-a", "terminal-provider-a", 20_000],
      ["terminal-b", "terminal-provider-b", 20_000],
    ] as const;
    const restoredCalls = calls.map(([callId, providerCallId, age]) =>
      makePersistedCall({
        callId,
        providerCallId,
        state: "initiated",
        startedAt: now - age,
        answeredAt: undefined,
      }),
    );
    for (const outcome of ["active", "unknown", "failure"]) {
      restoredCalls.push(
        makePersistedCall({
          callId: `${outcome}-a`,
          providerCallId: `${outcome}-provider-a`,
          startedAt: now - 30_000,
          answeredAt: now - 25_000,
        }),
      );
    }
    await writeCallsToStore(storePath, restoredCalls);

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
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
      maxDurationSeconds: 300,
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const manager = registerTestManagerCleanup(new CallManager(config, storePath));

    await manager.initialize(provider, "https://example.com/voice/webhook");

    expect(
      manager
        .getActiveCalls()
        .map((call) => call.callId)
        .toSorted(),
    ).toEqual(["active-a", "failure-a", "unknown-a"]);
    expect(manager.getActiveCalls().map((call) => call.state)).toEqual([
      "answered",
      "answered",
      "answered",
    ]);
    const hangupCall = requireSingleHangupCall(provider);
    expect(hangupCall.callId).toBe("expired-a");
    expect(hangupCall.providerCallId).toBe("expired-provider-a");
    expect(hangupCall.reason).toBe("timeout");
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Skipped 2 restored call(s) with no providerCallId",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Skipped 1 restored call(s) older than maxDurationSeconds",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Skipped 2 restored call(s) with provider status: completed",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Kept 1 restored call(s) confirmed active by provider",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Kept 1 restored call(s) with unknown provider status (relying on timer)",
    );
    expect(logSpy).toHaveBeenCalledWith(
      "[voice-call] Kept 1 restored call(s) after verification failure (relying on timer)",
    );
    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).not.toContain("terminal-a");

    logSpy.mockRestore();
  });

  it("uses call start as max-duration anchor for restored listening calls without answeredAt", async () => {
    const state = "listening";
    vi.useFakeTimers();
    const now = new Date("2026-03-17T03:07:00Z").getTime();
    vi.setSystemTime(now);
    const startedAt = now - 290_000;
    const { manager, provider, storePath } = await initializeManager({
      callOverrides: {
        callId: `call-${state}`,
        providerCallId: `provider-${state}`,
        state,
        startedAt,
        answeredAt: undefined,
      },
      configOverrides: { maxDurationSeconds: 300 },
    });

    const activeCall = requireSingleActiveCall(manager);
    expect(activeCall.state).toBe(state);
    expect(activeCall.answeredAt).toBe(startedAt);
    expect(
      (await loadActiveCallsFromStore(storePath)).activeCalls.get(activeCall.callId)?.answeredAt,
    ).toBe(startedAt);

    await vi.advanceTimersByTimeAsync(9_000);
    expect(manager.getActiveCalls()).toHaveLength(1);
    expect(provider.hangupCalls).toHaveLength(0);

    const endCall = vi.spyOn(manager, "endCall");
    await vi.advanceTimersByTimeAsync(1_100);
    expect(endCall).toHaveBeenCalledOnce();
    await requireRecord(endCall.mock.results[0], "timeout completion").value;
    expect(manager.getActiveCalls()).toHaveLength(0);
    const hangupCall = requireSingleHangupCall(provider);
    expect(hangupCall.reason).toBe("timeout");
  });

  it("keeps terminal identity when a replay key is retained or evicted", async () => {
    const storePath = createTestStorePath();
    const replayKeys = Array.from(
      { length: MAX_CALL_REPLAY_KEYS + 2 },
      (_, index) => `evt-terminal-${index}`,
    );
    const persisted = makePersistedCall({
      state: "completed",
      endedAt: Date.now() - 5_000,
      endReason: "completed",
      processedEventIds: replayKeys,
    });
    await writeCallsToStore(storePath, [persisted]);

    const provider = new FakeProvider();
    const config = VoiceCallConfigSchema.parse({
      enabled: true,
      provider: "plivo",
      fromNumber: "+15550000000",
    });
    const manager = registerTestManagerCleanup(new CallManager(config, storePath));
    await manager.initialize(provider, "https://example.com/voice/webhook");

    await manager.processEvent({
      id: replayKeys.at(-1) as string,
      type: "call.initiated",
      callId: String(persisted.providerCallId),
      providerCallId: String(persisted.providerCallId),
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15550000001",
    });

    expect(manager.getActiveCalls()).toHaveLength(0);

    await manager.processEvent({
      id: replayKeys[0] as string,
      type: "call.initiated",
      callId: String(persisted.providerCallId),
      providerCallId: String(persisted.providerCallId),
      timestamp: Date.now(),
      direction: "outbound",
      from: "+15550000000",
      to: "+15550000001",
    });

    expect(manager.getActiveCalls()).toHaveLength(0);
    expect(new Set((await manager.getCallHistory()).map((call) => call.callId))).toEqual(
      new Set([persisted.callId]),
    );
  });
});
