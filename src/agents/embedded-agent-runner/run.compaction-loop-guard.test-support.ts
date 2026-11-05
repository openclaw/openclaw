// Full-entry coverage for wiring the post-compaction loop guard into embedded runs.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type {
  diagnosticSessionStates as DiagnosticSessionStatesType,
  getDiagnosticSessionState as GetDiagnosticSessionStateType,
  SessionState,
} from "../../logging/diagnostic-session-state.js";
import type {
  ToolOutcomeObserver,
  wrapToolWithBeforeToolCallHook as WrapToolWithBeforeToolCallHookType,
} from "../agent-tools.before-tool-call.js";
import type {
  recordToolCallOutcome as RecordToolCallOutcomeType,
  recordToolCall as RecordToolCallType,
} from "../tool-loop-detection.js";
import {
  type makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  mockedAcquireAgentRunPreparedModelRuntime,
  mockedCompactDirect,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedRunEmbeddedAttempt,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";
import type { EmbeddedRunAttemptInternalParams } from "./run/internal-params.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let baseParams: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>["runParams"];
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;
// Import after the shared harness loads so these references point at the
// same module instances as the re-imported runner graph.
let diagnosticSessionStates: typeof DiagnosticSessionStatesType;
let getDiagnosticSessionState: typeof GetDiagnosticSessionStateType;
let recordToolCall: typeof RecordToolCallType;
let recordToolCallOutcome: typeof RecordToolCallOutcomeType;
let wrapToolWithBeforeToolCallHook: typeof WrapToolWithBeforeToolCallHookType;

// The default history cap distinguishes sequence-based observation from an index cursor.
const HISTORY_TRIM_CAP = 30;
const POST_COMPACTION_ABORT_DETAILS = {
  name: "PostCompactionLoopPersistedError",
  detector: "compaction_loop_persisted",
  count: 3,
  toolName: "gateway",
  message:
    "CRITICAL: tool gateway repeated 3 times with identical arguments and identical results within 3 attempts after auto-compaction. The compaction did not break the loop. Aborting to prevent runaway resource use.",
};

function seedToolHistory(state: SessionState) {
  const runId = baseParams.runId;
  for (let i = 0; i < HISTORY_TRIM_CAP; i += 1) {
    const toolParams = { iter: i };
    const toolCallId = `seed-${state.toolCallHistory?.length ?? 0}`;
    recordToolCall(state, "seed", toolParams, toolCallId, { runId });
    recordToolCallOutcome(state, {
      toolName: "seed",
      toolParams,
      toolCallId,
      result: `seed-result-${i}`,
      runId,
    });
  }
}

let liveToolCallSeq = 0;

function prepareCompactedAttempt() {
  mockedRunEmbeddedAttempt.mockResolvedValueOnce(
    sessionResult({ terminal: { kind: "failed", source: "prompt", error: makeOverflowError() } }),
  );
  mockedCompactDirect.mockResolvedValueOnce(
    makeCompactionSuccess({
      summary: "Compacted session",
      firstKeptEntryId: "entry-5",
      tokensBefore: 150000,
    }),
  );
}

let sessionResult: typeof makeAttemptResult;
async function repeatToolOutcome(onToolOutcome?: ToolOutcomeObserver) {
  for (let i = 0; i < 3; i += 1) {
    // Use the real wrapper so the guard sees live tool outcomes, not seeded history.
    const tool = wrapToolWithBeforeToolCallHook(
      { name: "gateway", execute: vi.fn(async () => "identical-result") } as never,
      {
        agentId: "main",
        sessionKey: baseParams.sessionKey,
        sessionId: baseParams.sessionId,
        runId: baseParams.runId,
        onToolOutcome,
      },
    );
    await tool.execute(
      `gateway-${++liveToolCallSeq}`,
      { action: "lookup", path: "x" },
      undefined,
      undefined,
    );
  }
}

function observeSettlement(run: ReturnType<typeof runEmbeddedAgent>) {
  const state = { settled: false };
  void run
    .finally(() => {
      state.settled = true;
    })
    .catch(() => {});
  return state;
}

async function withHeldAttempt(
  overrides: Partial<Parameters<typeof runEmbeddedAgent>[0]>,
  enter: (params: EmbeddedRunAttemptInternalParams) => void | Promise<void>,
  verify: (
    run: ReturnType<typeof runEmbeddedAgent>,
    started: Promise<void>,
    completion: { settled: boolean },
    settleAttempt: () => void,
  ) => Promise<void>,
) {
  vi.useFakeTimers();
  const held = createDeferred<ReturnType<typeof makeAttemptResult>>();
  const started = createDeferred();
  mockedRunEmbeddedAttempt.mockImplementationOnce(async (input) => {
    const params = input as EmbeddedRunAttemptInternalParams;
    await enter(params);
    started.resolve();
    const result = await held.promise;
    params.abortSignal?.throwIfAborted();
    return result;
  });
  const run = runEmbeddedAgent({ ...baseParams, ...overrides });
  try {
    await verify(run, started.promise, observeSettlement(run), () => held.resolve(sessionResult()));
  } finally {
    held.resolve(sessionResult());
    await run.catch(() => undefined);
    vi.useRealTimers();
  }
}

describe("post-compaction loop guard wired into runEmbeddedAgent", () => {
  let queuedTasks: Promise<unknown>[];
  let pendingTasks: Set<Promise<unknown>>;
  let restoreQueueObserver: (() => void) | undefined;
  let session: Awaited<ReturnType<typeof createSharedRunIntegrationSession>>;
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
    ({ diagnosticSessionStates, getDiagnosticSessionState } =
      await import("../../logging/diagnostic-session-state.js"));
    ({ recordToolCall, recordToolCallOutcome } = await import("../tool-loop-detection.js"));
    ({ wrapToolWithBeforeToolCallHook } = await import("../agent-tools.before-tool-call.js"));
  });

  beforeEach(async () => {
    liveToolCallSeq = 0;
    diagnosticSessionStates.clear();
    resetSharedRunIntegrationHarnessMocks();
    session = await createSharedRunIntegrationSession();
    sessionResult = session.makeAttemptResult;
    baseParams = session.runParams;
    const queue = await import("../../process/command-queue.js");
    const enqueue = queue.enqueueCommandInLane;
    queuedTasks = [];
    pendingTasks = new Set();
    // Observe the callback, not the caller's timeout race. Delegate unchanged so
    // the real queue still owns scheduling, errors and AsyncLocalStorage capture.
    const observe: typeof enqueue = (lane, task, options) =>
      enqueue(
        lane,
        () => {
          const work = task();
          queuedTasks.push(work);
          pendingTasks.add(work);
          void work.then(
            () => pendingTasks.delete(work),
            () => pendingTasks.delete(work),
          );
          return work;
        },
        options,
      );
    const spy = vi.spyOn(queue, "enqueueCommandInLane").mockImplementation(observe);
    restoreQueueObserver = () => spy.mockRestore();
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      const lower = msg?.toLowerCase() ?? "";
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      const lower = msg?.toLowerCase() ?? "";
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
  });

  afterEach(async () => {
    // The ignored backend must settle before canonical cleanup removes its files.
    // If this join fails, leave the fixture owned by the proof process.
    try {
      await Promise.allSettled(queuedTasks);
      expect(queuedTasks.length, "post-reset queue observer captured actual work").toBeGreaterThan(
        0,
      );
      expect(pendingTasks.size).toBe(0);
      await session?.cleanup();
    } finally {
      restoreQueueObserver?.();
    }
  });

  it.each([false, true])(
    "aborts repeated post-compaction work and releases children only for a current owner (revoked=%s)",
    async (revoked) => {
      const { prepareSystemAgentRunAdmission } = await import("../admitted-run-context.js");
      const { createSubagentRunRecord } = await import("../subagent-test-fixtures.test-helpers.js");
      const { subagentRuns } = await import("../subagents/registry/subagent-registry-memory.js");
      const { mutateSubagentRuns } =
        await import("../subagents/registry/subagent-registry-persistence.js");
      const { addSubagentRunForTests } =
        await import("../subagents/registry/subagent-registry.test-helpers.js");
      const admission = prepareSystemAgentRunAdmission(
        {},
        baseParams.runId,
        "main",
        "compaction-child-test",
      );
      const child = createSubagentRunRecord({
        runId: "compaction-child",
        childSessionKey: "agent:main:subagent:compaction-child",
        requesterSessionKey: baseParams.sessionKey,
        requesterAgentId: "main",
        requesterTurnRunId: baseParams.runId,
        expectsCompletionMessage: true,
        completion: { required: true },
        delivery: { status: "pending" },
      });
      let attemptReturned = false;
      let attemptSignalAborted = false;
      let attemptSignalReason: unknown;

      prepareCompactedAttempt();
      // Abort inside the live attempt; raise the loop error after it unwinds.
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
        const { abortSignal, onToolOutcome } = attemptParams as {
          abortSignal?: AbortSignal;
          onToolOutcome?: ToolOutcomeObserver;
        };
        await repeatToolOutcome(onToolOutcome);
        attemptSignalAborted = abortSignal?.aborted ?? false;
        attemptSignalReason = abortSignal?.reason;
        attemptReturned = true;
        if (revoked) {
          admission.close();
        }
        return session.makeAttemptResult({
          toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
          acceptedSessionSpawns: [
            {
              runId: child.runId,
              childSessionKey: child.childSessionKey,
              expectsCompletionMessage: true,
            },
          ],
        });
      });

      try {
        await addSubagentRunForTests(child);
        const run = runEmbeddedAgent({ ...session.runParams, preparedRunAdmission: admission });
        await expect(run).rejects.toMatchObject(POST_COMPACTION_ABORT_DETAILS);
        await expect(run).rejects.toBe(attemptSignalReason);
        const current = subagentRuns.get(child.runId);
        expect(current).toBeDefined();
        expect(current?.requesterTurnRunId).toBe(revoked ? baseParams.runId : undefined);
        expect(current?.requesterSettleWake).toBeUndefined();
      } finally {
        try {
          await mutateSubagentRuns([child.runId], () => ({
            value: undefined,
            postimages: new Map([[child.runId, null]]),
          }));
        } finally {
          admission.close();
        }
      }

      expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
      expect(attemptReturned).toBe(true);
      expect(attemptSignalAborted).toBe(true);
      expect(attemptSignalReason).toBeInstanceOf(Error);
    },
  );

  it("retains the lane after a post-compaction abort until the backend settles", async () => {
    let attemptAborted = false;
    prepareCompactedAttempt();
    await withHeldAttempt(
      { runId: "run-post-compaction-abort-lane-release", timeoutMs: 48 * 60 * 60 * 1000 },
      async ({ abortSignal, onToolOutcome }) => {
        await repeatToolOutcome(onToolOutcome);
        attemptAborted = abortSignal?.aborted ?? false;
      },
      async (run, started, completion, settleAttempt) => {
        await Promise.race([started, run]);
        expect(attemptAborted).toBe(true);
        await vi.advanceTimersByTimeAsync(30_001);
        expect(completion.settled).toBe(false);
        expect(pendingTasks.size, "backend still runs after the outer timeout").toBeGreaterThan(0);
        settleAttempt();
        await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
        expect(completion.settled).toBe(true);
      },
    );
  });

  it.each([false, true])(
    "keeps cold runtime acquisition outside execution budget (stop=%s)",
    async (stop) => {
      vi.useFakeTimers();
      const acquisitionStarted = createDeferred();
      const resumeAcquisition = createDeferred();
      const parent = new AbortController();
      const acquire = mockedAcquireAgentRunPreparedModelRuntime.getMockImplementation();
      if (!acquire) {
        throw new Error("Missing prepared runtime fixture");
      }
      let acquisitionSignal: AbortSignal | undefined;
      mockedAcquireAgentRunPreparedModelRuntime.mockImplementationOnce(
        async (input, options?: { abortSignal?: AbortSignal }) => {
          acquisitionSignal = options?.abortSignal;
          acquisitionStarted.resolve();
          await resumeAcquisition.promise;
          acquisitionSignal?.throwIfAborted();
          return await acquire(input);
        },
      );
      if (!stop) {
        mockedRunEmbeddedAttempt.mockResolvedValueOnce(session.makeAttemptResult());
      }
      const run = runEmbeddedAgent({
        ...baseParams,
        runId: `run-cold-acquisition-${stop}`,
        timeoutMs: 1,
        abortSignal: parent.signal,
      });
      let settled = false;
      const observed = run
        .finally(() => {
          settled = true;
        })
        .catch((error: unknown) => error);
      try {
        await Promise.race([acquisitionStarted.promise, run]);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(settled).toBe(false);
        expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
        if (stop) {
          parent.abort(new Error("stopped during preparation"));
          expect(acquisitionSignal?.aborted).toBe(true);
        }
        resumeAcquisition.resolve();
        if (stop) {
          await expect(run).rejects.toThrow("stopped during preparation");
          expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
        } else {
          await run;
          expect(mockedRunEmbeddedAttempt).toHaveBeenCalledOnce();
        }
      } finally {
        resumeAcquisition.resolve();
        await observed;
        vi.useRealTimers();
      }
    },
  );

  it("enforces the runtime deadline after a paused built-in attempt resumes", async () => {
    let publishDeadline: EmbeddedRunAttemptParams["onAttemptDeadlineChanged"];
    let attemptSignal: AbortSignal | undefined;
    let replyOperation: EmbeddedRunAttemptInternalParams["replyOperation"];
    await withHeldAttempt(
      {
        runId: "run-builtin-deadline-handoff",
        timeoutMs: 1,
        agentHarnessRuntimeOverride: "openclaw",
      },
      (params) => {
        const operation = params.replyOperation;
        if (!operation) {
          throw new Error("Built-in attempt requires controller admission");
        }
        replyOperation = operation;
        params.bindWatchdogAttempt?.(
          operation.watchdog.attachAttempt({ assertCurrent: () => undefined }),
        );
        publishDeadline = params.onAttemptDeadlineChanged;
        attemptSignal = params.abortSignal;
        // The legacy notification must not substitute a heartbeat for the owner's deadline.
        params.onAttemptTimeoutArmed?.();
        publishDeadline?.({ kind: "unlimited" });
      },
      async (run, started, completion, settleAttempt) => {
        await vi.advanceTimersByTimeAsync(0);
        await Promise.race([started, run]);
        await vi.advanceTimersByTimeAsync(30_001);
        expect(completion.settled).toBe(false);

        publishDeadline?.({ kind: "bounded", deadlineAtMs: Date.now() + 10 });
        await vi.advanceTimersByTimeAsync(30_011);
        expect(replyOperation?.watchdog.snapshot().executionDeadlineAtMs).toBeLessThanOrEqual(
          Date.now(),
        );
        await replyOperation?.watchdog.tick();
        expect(completion.settled).toBe(false);
        expect(pendingTasks.size, "backend still runs after the owner deadline").toBeGreaterThan(0);
        settleAttempt();
        await expect(run).rejects.toMatchObject({
          name: "CommandLaneTaskTimeoutError",
        });
        expect(attemptSignal?.aborted).toBe(true);
        expect(completion.settled).toBe(true);
      },
    );
  });

  it.each(["timeout", "abort"] as const)(
    "retains a native lane after %s until the attempt settles",
    async (kind) => {
      const stopped = createDeferred();
      let attemptSignal: AbortSignal | undefined;
      await withHeldAttempt(
        {
          runId: `run-native-${kind}-lane-release`,
          timeoutMs: 48 * 60 * 60 * 1000,
          agentHarnessRuntimeOverride: "openclaw",
        },
        ({ abortSignal, onAttemptTimeoutArmed, onAttemptTimeout, onAttemptAbort }) => {
          attemptSignal = abortSignal;
          abortSignal?.addEventListener("abort", () => stopped.resolve(), { once: true });
          onAttemptTimeoutArmed?.();
          if (kind === "timeout") {
            onAttemptTimeout?.(new Error("attempt timed out"));
          } else {
            onAttemptAbort?.();
          }
        },
        async (run, started, completion, settleAttempt) => {
          await vi.advanceTimersByTimeAsync(0);
          await started;
          await vi.advanceTimersByTimeAsync(30_001);
          // Writer fencing is asynchronous; timer advancement does not join its receipt.
          await Promise.race([stopped.promise, run]);

          expect(completion.settled).toBe(false);
          expect(attemptSignal?.aborted).toBe(true);
          expect(pendingTasks.size, "backend still runs after the outer timeout").toBeGreaterThan(
            0,
          );
          settleAttempt();
          await expect(run).rejects.toMatchObject({ name: "CommandLaneTaskTimeoutError" });
          if (kind === "timeout") {
            await expect(run).rejects.toBe(attemptSignal?.reason);
          }
          expect(attemptSignal?.reason).toMatchObject(
            kind === "timeout"
              ? { name: "CommandLaneTaskTimeoutError" }
              : { name: "AbortError", message: "agent run aborted" },
          );
          expect(completion.settled).toBe(true);
        },
      );
    },
  );

  it("does not arm the post-compaction guard when loop detection is disabled", async () => {
    prepareCompactedAttempt();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      await repeatToolOutcome(onToolOutcome);
      return session.makeAttemptResult({
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    const result = await runEmbeddedAgent({
      ...session.runParams,
      config: {
        tools: {
          loopDetection: {
            enabled: false,
          },
        },
      } as never,
    });

    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("aborts post-compaction loop from the live tool path even when toolCallHistory is at its trim cap", async () => {
    const sessionState = getDiagnosticSessionState({
      sessionKey: baseParams.sessionKey,
      sessionId: baseParams.sessionId,
    });

    seedToolHistory(sessionState);
    expect(sessionState.toolCallHistory?.length).toBe(HISTORY_TRIM_CAP);

    prepareCompactedAttempt();
    // Attempt 2 (post-compaction): three identical live tool outcomes while
    // history is already at the cap. The guard aborts on the third result
    // before the mocked attempt can return.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (attemptParams: unknown) => {
      const onToolOutcome = (attemptParams as { onToolOutcome?: ToolOutcomeObserver })
        .onToolOutcome;
      await repeatToolOutcome(onToolOutcome);
      // History is still capped at HISTORY_TRIM_CAP after the trim.
      expect(sessionState.toolCallHistory?.length).toBe(HISTORY_TRIM_CAP);
      return session.makeAttemptResult({
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    await expect(runEmbeddedAgent(session.runParams)).rejects.toMatchObject(
      POST_COMPACTION_ABORT_DETAILS,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });
});
