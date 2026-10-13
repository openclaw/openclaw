import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  captureRuntimeConfigAsyncReader,
  clearConfigCache,
  clearRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { createOpenClawTestState, type OpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryEmbeddingOperationError } from "./manager-embedding-errors.js";
import {
  emitSessionTranscriptUpdate,
  resetTranscriptUpdateListener,
  SessionStartupCatchupHarness,
  startupHarnessDatabases,
} from "./manager-sync-ops.startup-catchup.test-support.js";

const activity = vi.hoisted(() => ({
  listener: undefined as ((busy: boolean) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    observeAgentRunActivity: (_agentId: string, listener: (busy: boolean) => void) => {
      activity.listener = listener;
      listener(false);
      return () => {
        activity.listener = undefined;
      };
    },
  };
});

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
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    harness.startTranscriptListener();
  });

  afterEach(async () => {
    harness.stopTranscriptListener();
    vi.clearAllTimers();
    vi.useRealTimers();
    resetTranscriptUpdateListener();
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

  function append(sessionId: string) {
    const target = { agentId: "main", sessionId, sessionKey: `agent:main:chat:${sessionId}` };
    emitSessionTranscriptUpdate({ target });
    return target;
  }

  it("waits for a fresh quiet period and includes every pending session in one pass", async () => {
    const first = append("first");
    await vi.advanceTimersByTimeAsync(20_000);
    const second = append("second");
    append("first");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(harness.syncCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [first, second], archiveFiles: [] },
    ]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.syncCalls).toHaveLength(1);
  });

  it("bounds continuous transcript deferral at five minutes", async () => {
    const target = append("continuous");
    for (let elapsed = 0; elapsed < 280_000; elapsed += 20_000) {
      await vi.advanceTimersByTimeAsync(20_000);
      append("continuous");
    }
    await vi.advanceTimersByTimeAsync(19_999);
    expect(harness.syncCalls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [target], archiveFiles: [] },
    ]);
  });

  it("starts overdue work as soon as a long running turn settles", async () => {
    activity.listener?.(true);
    const target = append("busy");
    await vi.advanceTimersByTimeAsync(360_000);
    expect(harness.syncCalls).toEqual([]);

    activity.listener?.(false);
    await vi.advanceTimersByTimeAsync(1);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [target], archiveFiles: [] },
    ]);
  });

  it("caps deferral across back-to-back turns and only starts in an idle gap", async () => {
    const target = { agentId: "main", sessionId: "busy", sessionKey: "agent:main:chat:busy" };
    for (let turn = 0; turn < 15; turn++) {
      activity.listener?.(true);
      append("busy");
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.syncCalls).toEqual([]);
      activity.listener?.(false);
      await vi.advanceTimersByTimeAsync(1);
      if (turn < 14) {
        expect(harness.syncCalls).toEqual([]);
      }
    }
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [target], archiveFiles: [] },
    ]);
  });

  it("keeps pending work when a new turn starts during the quiet period", async () => {
    const first = append("before-turn");
    await vi.advanceTimersByTimeAsync(29_000);
    activity.listener?.(true);
    const second = append("during-turn");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(harness.syncCalls).toEqual([]);

    activity.listener?.(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [first, second], archiveFiles: [] },
    ]);
  });

  it("retries a failed pass with its original targets and updates queued during that pass", async () => {
    const first = append("first");
    const second = append("second");
    let third: ReturnType<typeof append> | undefined;
    const sync = vi.spyOn(
      harness as unknown as { sync: (params: { reason?: string }) => Promise<void> },
      "sync",
    );
    sync.mockImplementationOnce(async (params) => {
      harness.syncCalls.push(params);
      third = append("third");
      append("first");
      throw new Error("temporary index publication failure");
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [first, second], archiveFiles: [] },
    ]);
    await vi.advanceTimersByTimeAsync(59_999);
    expect(harness.syncCalls).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(1);
    await harness.waitForSessionSync();
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [first, second], archiveFiles: [] },
      { reason: "session-delta", sessions: [first, second, third], archiveFiles: [] },
    ]);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(harness.syncCalls).toHaveLength(2);
    sync.mockRestore();
  });

  it("backs off handled fallback failures, yields to turns, and stops retrying until new activity", async () => {
    const target = append("fallback");
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

    await vi.advanceTimersByTimeAsync(30_000);
    expect(index).toHaveBeenCalledTimes(1);
    for (const [attempt, delay] of [60_000, 300_000, 900_000].entries()) {
      await vi.advanceTimersByTimeAsync(lastAttemptAt + delay - Date.now() - 1);
      expect(index).toHaveBeenCalledTimes(attempt + 1);
      if (attempt === 1) {
        activity.listener?.(true);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(index).toHaveBeenCalledTimes(attempt + 1);
        activity.listener?.(false);
      }
      await vi.advanceTimersByTimeAsync(1);
      expect(index).toHaveBeenCalledTimes(attempt + 2);
    }
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(index).toHaveBeenCalledTimes(4);
    expect(harness.syncCalls).toEqual([
      { reason: "session-delta", sessions: [target], archiveFiles: [] },
      ...Array.from({ length: 3 }, () => ({ reason: "session-startup-catchup" })),
    ]);
    expect(harness["sessionsFullRetryDirty"]).toBe(true);

    index.mockResolvedValue(undefined);
    activity.listener?.(true);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(index).toHaveBeenCalledTimes(4);
    harness["recordFullReindexFailure"](false);
    deferForRebuildCooldown = true;
    activity.listener?.(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(index).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(59_998);
    expect(index).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(2);
    expect(index).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(index).toHaveBeenCalledTimes(5);
  });
});
