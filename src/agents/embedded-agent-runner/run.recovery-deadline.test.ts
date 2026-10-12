import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { ContextEngine } from "../../context-engine/types.js";
import { SessionManager } from "../sessions/session-manager.js";
import type { CompactEmbeddedAgentSessionRuntimeParams } from "./compact.types.js";
import { makeAttemptResult, makeOverflowError } from "./run.overflow-compaction.fixture.js";
import {
  createOverflowRunParams,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
  type TestRunEmbeddedAgent,
} from "./run.overflow-compaction.harness.js";
import {
  cleanupSharedRunIntegrationSessions,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";
import type { EmbeddedAgentCompactResult } from "./types.js";

const physicalCompaction = vi.hoisted(() =>
  vi.fn<
    (params: CompactEmbeddedAgentSessionRuntimeParams) => Promise<EmbeddedAgentCompactResult>
  >(),
);
vi.mock("./compact.runtime.js", () => ({
  compactEmbeddedAgentSessionOnDemand: physicalCompaction,
}));

// Keep lane admission, attempt deadline production, overflow recovery, the native
// compaction delegate, and both watchdogs real; only provider work is synthetic.
describe("overflow recovery deadline ownership through the public runner", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let runEmbeddedAgent: TestRunEmbeddedAgent;
  let prepareTimeout: typeof import("./run/attempt-timeout-prepare.js").prepareEmbeddedAttemptTimeout;
  let engine: ContextEngine;
  let restoreCompact: () => void;
  let delegate: ContextEngine["compact"];
  let queuedTasks: Promise<unknown>[];
  let restoreQueue: (() => void) | undefined;
  let parent: AbortController;
  let releaseCompaction: ReturnType<typeof createDeferred<EmbeddedAgentCompactResult>>;
  let compactionStarted: ReturnType<
    typeof createDeferred<CompactEmbeddedAgentSessionRuntimeParams>
  >;
  let attemptStarted: ReturnType<typeof createDeferred<void>>;

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ prepareEmbeddedAttemptTimeout: prepareTimeout } =
      await import("./run/attempt-timeout-prepare.js"));
    ({ delegateCompactionToRuntime: delegate } = await import("../../context-engine/delegate.js"));
    engine = await (await import("../../context-engine/registry.js")).resolveContextEngine();
    const originalCompact = Object.getOwnPropertyDescriptor(engine, "compact");
    if (!originalCompact) {
      throw new Error("The shared runner fixture must own its compaction method");
    }
    restoreCompact = () => {
      Object.defineProperty(engine, "compact", originalCompact);
    };
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    engine.compact = delegate;
    engine.info.ownsCompaction = false;
    physicalCompaction.mockReset();
    parent = new AbortController();
    releaseCompaction = createDeferred<EmbeddedAgentCompactResult>();
    compactionStarted = createDeferred<CompactEmbeddedAgentSessionRuntimeParams>();
    attemptStarted = createDeferred();
    queuedTasks = [];
    const queue = await import("../../process/command-queue.js");
    const enqueue = queue.enqueueCommandInLane;
    const observer = vi
      .spyOn(queue, "enqueueCommandInLane")
      .mockImplementation((lane, task, options) =>
        enqueue(
          lane,
          (marker) => {
            const work = task(marker);
            queuedTasks.push(work);
            return work;
          },
          options,
        ),
      );
    restoreQueue = () => observer.mockRestore();
    physicalCompaction.mockImplementation(async (params) => {
      compactionStarted.resolve(params);
      return await releaseCompaction.promise;
    });
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
      const params = input as EmbeddedRunAttemptParams;
      const model = createDeferred<ReturnType<typeof makeAttemptResult>>();
      const timer = prepareTimeout({
        attempt: params,
        activeSession: { isCompacting: false, isStreaming: true },
        compactionState: { isCompacting: () => false },
        compactionTimeoutMs: 180_000,
        runAbortSignal: params.abortSignal!,
        isProbeSession: false,
        abortRun: () => model.reject(new Error("execution budget expired")),
        markTimedOutDuringCompaction: () => {},
        markTimedOutByRunBudget: () => {},
      });
      const response = setTimeout(
        () =>
          model.resolve(
            makeAttemptResult({
              sessionIdUsed: params.sessionId,
              promptError: makeOverflowError(),
              assistantTexts: [],
            }),
          ),
        16_000,
      );
      attemptStarted.resolve();
      try {
        return await model.promise;
      } finally {
        clearTimeout(response);
        timer.clearTimers();
      }
    });
    mockedRunEmbeddedAttempt.mockImplementation(async (params) =>
      makeAttemptResult({
        sessionIdUsed: params.sessionId,
        assistantTexts: ["Recovered"],
      }),
    );
    vi.useFakeTimers();
  });

  afterEach(async () => {
    parent.abort(new Error("test cleanup"));
    releaseCompaction.resolve({ ok: false, compacted: false, reason: "test settled" });
    await Promise.allSettled(queuedTasks);
    restoreQueue?.();
    restoreCompact();
    vi.useRealTimers();
  });
  afterAll(cleanupSharedRunIntegrationSessions);

  async function start() {
    const workspaceDir = tempDirs.make("openclaw-recovery-deadline-");
    const sessionManager = SessionManager.inMemory(workspaceDir);
    const run = runEmbeddedAgent({
      ...createOverflowRunParams({ workspaceDir }),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "anthropic",
      model: "test-model",
      sessionId: sessionManager.getSessionId(),
      sessionManager,
      sessionPersistence: "detached",
      timeoutMs: 600_000,
      config: { agents: { defaults: { compaction: { timeoutSeconds: 180 } } } },
      abortSignal: parent.signal,
    });
    const observed = run.then(
      (result) => ({ kind: "resolved" as const, result }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await Promise.race([attemptStarted.promise, observed]);
    await vi.advanceTimersByTimeAsync(16_000);
    const entered = await Promise.race([compactionStarted.promise, observed]);
    if (!("compactionTimeoutReset" in entered)) {
      throw new Error(`Recovery did not reach the native delegate: ${JSON.stringify(entered)}`);
    }
    return { run, observed, compaction: entered };
  }

  it("lets progressing recovery finish within the finite execution budget", async () => {
    const { observed, compaction } = await start();
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    for (let request = 0; request < 4; request += 1) {
      await vi.advanceTimersByTimeAsync(100_000);
      compaction.compactionTimeoutReset?.();
    }
    await vi.advanceTimersByTimeAsync(80_000);
    expect(
      settled ? await observed : undefined,
      "per-request compaction progress remains valid within the execution budget",
    ).toBeUndefined();
    expect(compaction.abortSignal?.aborted).toBe(false);
    releaseCompaction.resolve({
      ok: true,
      compacted: true,
      result: { summary: "Earlier synthetic work", tokensBefore: 210_000, tokensAfter: 40 },
    });
    expect((await observed).kind).toBe("resolved");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("propagates the queue timeout into active recovery despite per-request progress", async () => {
    const { observed, compaction } = await start();
    for (let request = 0; request < 7; request += 1) {
      await vi.advanceTimersByTimeAsync(100_000);
      compaction.compactionTimeoutReset?.();
    }
    await vi.advanceTimersByTimeAsync(110_000);
    expect(
      compaction.abortSignal?.aborted,
      "queue timeout must reach the active recovery owner",
    ).toBe(true);
    const result = await observed;
    expect(result).toMatchObject({
      kind: "rejected",
      error: { name: "CommandLaneTaskTimeoutError" },
    });
    if (result.kind === "rejected") {
      expect(compaction.abortSignal?.reason).toBe(result.error);
    }
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
  });

  it("still aborts a stalled compaction at its per-request safety window", async () => {
    const { observed, compaction } = await start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(compaction.abortSignal?.aborted).toBe(true);
    releaseCompaction.resolve({ ok: false, compacted: false, reason: "Compaction timed out" });
    const result = await observed;
    expect(result).toMatchObject({
      kind: "resolved",
      result: { meta: { error: { kind: "context_overflow" } } },
    });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
  });

  it("preserves cancellation after the model attempt has returned an overflow", async () => {
    const { observed, compaction } = await start();
    const reason = new Error("caller stopped recovery");
    parent.abort(reason);
    expect(compaction.abortSignal?.aborted).toBe(true);
    releaseCompaction.resolve({ ok: false, compacted: false, reason: "cancelled" });
    expect(await observed).toEqual({ kind: "rejected", error: reason });
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
  });
});
