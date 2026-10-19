import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
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
  let runtimeConfig: typeof import("../../config/runtime-snapshot.js");

  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    runtimeConfig = await import("../../config/runtime-snapshot.js");
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
          () => {
            const work = task();
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
      const overflow = makeAttemptResult({
        sessionIdUsed: params.sessionId,
        promptError: makeOverflowError(),
        assistantTexts: [],
      });
      const response = setTimeout(() => model.resolve(overflow), 16_000);
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
    runtimeConfig.clearRuntimeConfigSnapshot();
  });
  afterAll(cleanupSharedRunIntegrationSessions);

  async function start(progressRequests = 0) {
    const workspaceDir = tempDirs.make("openclaw-recovery-deadline-");
    const sessionManager = SessionManager.inMemory(workspaceDir);
    const config: OpenClawConfig = {
      agents: { defaults: { compaction: { timeoutSeconds: 180 } } },
    };
    runtimeConfig.setRuntimeConfigSnapshot(config);
    const run = runEmbeddedAgent({
      ...createOverflowRunParams({ workspaceDir }),
      agentHarnessRuntimeOverride: "openclaw",
      provider: "anthropic",
      model: "test-model",
      sessionId: sessionManager.getSessionId(),
      sessionManager,
      sessionPersistence: "detached",
      timeoutMs: 600_000,
      config,
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
    for (let request = 0; request < progressRequests; request += 1) {
      await vi.advanceTimersByTimeAsync(100_000);
      entered.compactionTimeoutReset?.();
    }
    return { observed, compaction: entered };
  }

  it("lets progressing recovery finish within the finite execution budget", async () => {
    const { observed, compaction } = await start(4);
    let settled = false;
    void observed.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(80_000);
    expect(settled ? await observed : undefined).toBeUndefined();
    expect(compaction.abortSignal?.aborted).toBe(false);
    releaseCompaction.resolve({
      ok: true,
      compacted: true,
      result: { summary: "Earlier synthetic work", tokensBefore: 210_000, tokensAfter: 40 },
    });
    expect((await observed).kind).toBe("resolved");
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("propagates the detached execution deadline despite per-request progress", async () => {
    const { observed, compaction } = await start(7);
    await vi.advanceTimersByTimeAsync(110_000);
    expect(compaction.abortSignal?.aborted).toBe(true);
    const result = await observed;
    expect(result).toMatchObject({
      kind: "rejected",
      error: { message: "Detached execution stalled" },
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
    expect(await observed).toMatchObject({
      kind: "resolved",
      result: { meta: { error: { kind: "compaction_failure" } } },
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
