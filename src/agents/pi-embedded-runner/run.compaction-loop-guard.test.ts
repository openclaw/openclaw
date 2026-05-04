import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  diagnosticSessionStates as DiagnosticSessionStatesType,
  getDiagnosticSessionState as GetDiagnosticSessionStateType,
  SessionState,
} from "../../logging/diagnostic-session-state.js";
import type { hashToolCall as HashToolCallType } from "../tool-loop-detection.js";
import type { PostCompactionLoopPersistedError as PostCompactionLoopPersistedErrorType } from "./post-compaction-loop-guard.js";
import {
  makeAttemptResult,
  makeCompactionSuccess,
  makeOverflowError,
} from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedContextEngine,
  mockedIsCompactionFailureError,
  mockedIsLikelyContextOverflowError,
  mockedLog,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams as baseParams,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;
// These need to be imported AFTER loadRunOverflowCompactionHarness so that
// they reference the same module instances the (re-imported) runner uses.
// vi.resetModules() inside the harness invalidates any earlier import.
let diagnosticSessionStates: typeof DiagnosticSessionStatesType;
let getDiagnosticSessionState: typeof GetDiagnosticSessionStateType;
let hashToolCall: typeof HashToolCallType;
let PostCompactionLoopPersistedError: typeof PostCompactionLoopPersistedErrorType;

function recordToolOutcome(
  state: SessionState,
  toolName: string,
  toolParams: unknown,
  resultHash: string,
  runId?: string,
): void {
  if (!state.toolCallHistory) {
    state.toolCallHistory = [];
  }
  state.toolCallHistory.push({
    toolName,
    argsHash: hashToolCall(toolName, toolParams),
    resultHash,
    timestamp: Date.now(),
    ...(runId ? { runId } : {}),
  });
}

describe("post-compaction loop guard wired into runEmbeddedPiAgent", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
    // Re-import after the harness reset so we share module instances with
    // the runner. The runner imports both modules through its own graph.
    ({ diagnosticSessionStates, getDiagnosticSessionState } =
      await import("../../logging/diagnostic-session-state.js"));
    ({ hashToolCall } = await import("../tool-loop-detection.js"));
    ({ PostCompactionLoopPersistedError } = await import("./post-compaction-loop-guard.js"));
  });

  beforeEach(() => {
    diagnosticSessionStates.clear();
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedContextEngine.info.ownsCompaction = false;
    mockedLog.debug.mockReset();
    mockedLog.info.mockReset();
    mockedLog.warn.mockReset();
    mockedLog.error.mockReset();
    mockedLog.isEnabled.mockReset();
    mockedLog.isEnabled.mockReturnValue(false);
    mockedIsCompactionFailureError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return lower.includes("request_too_large") && lower.includes("summarization failed");
    });
    mockedIsLikelyContextOverflowError.mockImplementation((msg?: string) => {
      if (!msg) {
        return false;
      }
      const lower = msg.toLowerCase();
      return (
        lower.includes("request_too_large") ||
        lower.includes("request size exceeds") ||
        lower.includes("context window exceeded") ||
        lower.includes("prompt too large")
      );
    });
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized tool results",
    });
  });

  it("aborts the run with PostCompactionLoopPersistedError when identical (tool, args, result) repeats windowSize times after compaction", async () => {
    const overflowError = makeOverflowError();
    const sessionState = getDiagnosticSessionState({
      sessionKey: baseParams.sessionKey,
      sessionId: baseParams.sessionId,
    });

    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
    );
    // Attempt 2: post-compaction. The wrapped tool layer would have
    // recorded `windowSize` identical (tool, args, result) outcomes during
    // this single attempt. The runner's after-attempt guard observation
    // sees all three at once, accumulates matches, and aborts on the third.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      for (let i = 0; i < 3; i += 1) {
        recordToolOutcome(
          sessionState,
          "gateway",
          { action: "lookup", path: "x" },
          "identical-result",
          baseParams.runId,
        );
      }
      return makeAttemptResult({
        promptError: null,
        toolMetas: [{ toolName: "gateway" }, { toolName: "gateway" }, { toolName: "gateway" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    await expect(runEmbeddedPiAgent(baseParams)).rejects.toBeInstanceOf(
      PostCompactionLoopPersistedError,
    );

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("does not abort when the result hash changes across post-compaction attempts (progress was made)", async () => {
    const overflowError = makeOverflowError();
    const sessionState = getDiagnosticSessionState({
      sessionKey: baseParams.sessionKey,
      sessionId: baseParams.sessionId,
    });

    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
    );
    // Attempt 2 (post-compaction): identical args, but DIFFERENT result hash
    // each time. Only one further attempt is needed since the runner exits
    // on a successful prompt with no further retry trigger.
    let callCounter = 0;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      callCounter += 1;
      recordToolOutcome(
        sessionState,
        "gateway",
        { action: "lookup", path: "x" },
        `result-${callCounter}`,
        baseParams.runId,
      );
      return makeAttemptResult({
        promptError: null,
        toolMetas: [{ toolName: "gateway" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent(baseParams);
    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });

  it("disarms after windowSize observations regardless of match, so later identical calls do not abort", async () => {
    // Use windowSize: 2 so the guard disarms after 2 observations.
    const overflowError = makeOverflowError();
    const sessionState = getDiagnosticSessionState({
      sessionKey: baseParams.sessionKey,
      sessionId: baseParams.sessionId,
    });

    // Attempt 1: overflow → triggers compaction.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () =>
      makeAttemptResult({ promptError: overflowError }),
    );
    // Attempt 2 (post-compaction): two distinct records → window full,
    // guard disarms with no abort. We then append more identical records
    // afterwards in this test to confirm they are not observed by the guard.
    mockedRunEmbeddedAttempt.mockImplementationOnce(async () => {
      recordToolOutcome(sessionState, "read", { path: "/a" }, "ra", baseParams.runId);
      recordToolOutcome(sessionState, "write", { path: "/b" }, "rb", baseParams.runId);
      return makeAttemptResult({
        promptError: null,
        toolMetas: [{ toolName: "read" }, { toolName: "write" }],
      });
    });

    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "Compacted session",
        firstKeptEntryId: "entry-5",
        tokensBefore: 150000,
      }),
    );

    const result = await runEmbeddedPiAgent({
      ...baseParams,
      config: {
        tools: {
          loopDetection: {
            postCompactionGuard: { enabled: true, windowSize: 2 },
          },
        },
      } as never,
    });

    expect(result.meta.error).toBeUndefined();
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
  });
});
