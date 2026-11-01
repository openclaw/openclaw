import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { upsertSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { publishSessionTranscriptUpdateByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  SessionStartupCatchupHarness,
  startupHarnessDatabases,
} from "./manager-sync-ops.startup-catchup.test-support.js";

const { activity } = await vi.hoisted(() => import("./agent-activity.test-support.js"));

describe("session index scheduling", () => {
  let testState: OpenClawTestState;
  let harness: SessionStartupCatchupHarness;

  beforeEach(async () => {
    testState = await createOpenClawTestState({
      prefix: "openclaw-session-scheduling-",
      layout: "state-only",
    });
    await captureRuntimeConfigAsyncReader()();
    harness = await SessionStartupCatchupHarness.create([]);
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    harness.startTranscriptListener();
  });

  afterEach(async () => {
    harness.stopTranscriptListener();
    vi.clearAllTimers();
    vi.useRealTimers();
    for (const database of startupHarnessDatabases) {
      await database.closeShadow();
    }
    startupHarnessDatabases.clear();
    await testState.restoreEnv();
    clearRuntimeConfigSnapshot();
    clearConfigCache();
    resetPluginStateStoreForTests();
    await testState.cleanup();
  });

  async function append(sessionId: string) {
    const target = { agentId: "main", sessionId, sessionKey: `agent:main:chat:${sessionId}` };
    await upsertSessionEntry({
      agentId: target.agentId,
      sessionKey: target.sessionKey,
      entry: { sessionId, updatedAt: Date.now() },
    });
    await publishSessionTranscriptUpdateByIdentity(target);
    return target;
  }

  async function advanceSessionTime(ms: number): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
    await harness.waitForSessionSync();
  }
  const delta = (...sessions: Array<Awaited<ReturnType<typeof append>> | undefined>) => ({
    reason: "session-delta",
    sessions,
    archiveFiles: [],
  });

  it.each([1, 14])(
    "coalesces %i activity intervals within quiet and maximum deadlines",
    async (updates) => {
      const first = await append("first");
      let second = first;
      for (let update = 0; update < updates; update++) {
        await vi.advanceTimersByTimeAsync(20_000);
        second = await append("second");
        await append("first");
      }
      vi.setSystemTime(Date.now() + (updates === 14 ? 120_000 : 0));
      await append("first");
      await vi.advanceTimersByTimeAsync(updates === 14 ? 19_999 : 29_999);
      expect(harness.syncCalls).toEqual([]);
      await advanceSessionTime(1);
      expect(harness.syncCalls).toEqual([delta(first, second)]);
      await vi.advanceTimersByTimeAsync(300_000);
      expect(harness.syncCalls).toHaveLength(1);
    },
  );

  it("starts overdue work as soon as a long running turn settles", async () => {
    activity.listener?.(true);
    const target = await append("busy");
    await vi.advanceTimersByTimeAsync(360_000);
    expect(harness.syncCalls).toEqual([]);

    activity.listener?.(false);
    await advanceSessionTime(1);
    expect(harness.syncCalls).toEqual([delta(target)]);
  });

  it("caps deferral across back-to-back turns and only starts in an idle gap", async () => {
    const target = { agentId: "main", sessionId: "busy", sessionKey: "agent:main:chat:busy" };
    for (let turn = 0; turn < 15; turn++) {
      activity.listener?.(true);
      await append("busy");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.syncCalls).toEqual([]);
      activity.listener?.(false);
      await vi.advanceTimersByTimeAsync(1);
      if (turn < 14) {
        expect(harness.syncCalls).toEqual([]);
      }
    }
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([delta(target)]);
  });

  it("keeps pending work when a new turn starts during the quiet period", async () => {
    const first = await append("before-turn");
    await vi.advanceTimersByTimeAsync(29_000);
    activity.listener?.(true);
    const second = await append("during-turn");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.syncCalls).toEqual([]);

    activity.listener?.(false);
    await advanceSessionTime(30_000);
    expect(harness.syncCalls).toEqual([delta(first, second)]);
  });

  it("retries a failed pass with its original targets and updates queued during that pass", async () => {
    const first = await append("first");
    const second = await append("second");
    let third: Awaited<ReturnType<typeof append>> | undefined;
    const sync = vi.spyOn(
      harness as unknown as { sync: (params: { reason?: string }) => Promise<void> },
      "sync",
    );
    sync.mockImplementationOnce(async (params) => {
      harness.syncCalls.push(params);
      third = await append("third");
      await append("first");
      throw new Error("temporary index publication failure");
    });

    await advanceSessionTime(30_000);
    expect(harness.syncCalls).toEqual([delta(first, second)]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(harness.syncCalls).toHaveLength(1);

    await advanceSessionTime(1);
    expect(harness.syncCalls).toEqual([delta(first, second), delta(first, second, third)]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.syncCalls).toHaveLength(2);
    sync.mockRestore();
  });

  it("keeps the final automatic retry until a long rebuild cooldown expires", async () => {
    const target = await append("cooldown");
    const index = vi.fn(async () => {});
    index.mockRejectedValueOnce(
      createMemoryEmbeddingOperationError({
        operation: "batch",
        cause: "embedding backend failed",
      }),
    );
    harness["syncArchiveFiles"] = index;
    harness["activateFallbackProvider"] = vi.fn(async () => true);
    // Earlier rebuild failures have reached the existing thirty-minute cap.
    for (let attempt = 0; attempt < 7; attempt++) {
      harness["recordFullReindexFailure"](false);
    }
    harness["sync"] = async (params) => {
      harness.syncCalls.push(params ?? {});
      if (params?.reason === "session-delta") {
        await harness["syncTargetedSessions"](new Set(["/tmp/cooldown.jsonl"]));
      } else {
        await harness.runSyncForTest(params);
      }
    };

    await advanceSessionTime(30_000);
    expect(index).toHaveBeenCalledTimes(1);
    await advanceSessionTime(60_000);
    await advanceSessionTime(300_000);
    expect(harness.syncCalls).toEqual([
      delta(target),
      { reason: "session-startup-catchup" },
      { reason: "session-startup-catchup" },
    ]);
    await advanceSessionTime(1_800_000 - 390_000 - 1);
    expect(index).toHaveBeenCalledTimes(1);
    expect(harness.syncCalls).toHaveLength(3);

    await advanceSessionTime(1);
    expect(index).toHaveBeenCalledTimes(2);
    expect(harness.syncCalls).toHaveLength(4);
    await advanceSessionTime(3_600_000);
    expect(index).toHaveBeenCalledTimes(2);
  });

  it("backs off handled fallback failures, yields to turns, and stops retrying until new activity", async () => {
    const target = await append("fallback");
    const sessionFile = "/tmp/fallback.jsonl";
    const index = vi.fn(async () => {});
    const error = createMemoryEmbeddingOperationError({
      operation: "batch",
      cause: "embedding backend failed",
    });
    let lastAttemptAt = 0;
    index.mockImplementation(async () => {
      lastAttemptAt = Date.now();
      throw error;
    });
    harness["syncArchiveFiles"] = index;
    harness["activateFallbackProvider"] = vi.fn(async () => true);
    let deferForRebuildCooldown = false;
    harness["sync"] = async (params) => {
      harness.syncCalls.push(params ?? {});
      if (deferForRebuildCooldown) {
        deferForRebuildCooldown = false;
        await harness.runSyncForTest(params);
        return;
      }
      await harness["syncTargetedSessions"](new Set([sessionFile]));
    };

    await advanceSessionTime(30_000);
    expect(index).toHaveBeenCalledTimes(1);
    for (const [attempt, delay] of [60_000, 300_000, 900_000].entries()) {
      await advanceSessionTime(lastAttemptAt + delay - Date.now() - 1);
      expect(index).toHaveBeenCalledTimes(attempt + 1);
      if (attempt === 1) {
        activity.listener?.(true);
        await advanceSessionTime(60_000);
        expect(index).toHaveBeenCalledTimes(attempt + 1);
        activity.listener?.(false);
      }
      await advanceSessionTime(1);
      expect(index).toHaveBeenCalledTimes(attempt + 2);
    }
    await advanceSessionTime(3_600_000);
    expect(index).toHaveBeenCalledTimes(4);
    expect(harness.syncCalls).toEqual([
      delta(target),
      ...Array.from({ length: 3 }, () => ({ reason: "session-startup-catchup" })),
    ]);
    expect(harness["sessionsFullRetryDirty"]).toBe(true);

    index.mockResolvedValue(undefined);
    activity.listener?.(true);
    await advanceSessionTime(30_000);
    expect(index).toHaveBeenCalledTimes(4);
    harness["recordFullReindexFailure"](false);
    deferForRebuildCooldown = true;
    activity.listener?.(false);
    await advanceSessionTime(1);
    expect(index).toHaveBeenCalledTimes(4);
    await advanceSessionTime(59_998);
    expect(index).toHaveBeenCalledTimes(4);
    await advanceSessionTime(2);
    expect(index).toHaveBeenCalledTimes(5);
    await advanceSessionTime(3_600_000);
    expect(index).toHaveBeenCalledTimes(5);
  });
});
