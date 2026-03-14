import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCoerceToFailoverError,
  mockedDescribeFailoverError,
  mockedGlobalHookRunner,
  mockedResolveFailoverStatus,
  mockedContextEngine,
  mockedCompactDirect,
  mockedRunEmbeddedAttempt,
  resetRunOverflowCompactionHarnessMocks,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("timeout-triggered compaction", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedRunEmbeddedAttempt.mockReset();
    mockedCompactDirect.mockReset();
    mockedCoerceToFailoverError.mockReset();
    mockedDescribeFailoverError.mockReset();
    mockedResolveFailoverStatus.mockReset();
    mockedSessionLikelyHasOversizedToolResults.mockReset();
    mockedTruncateOversizedToolResultsInSession.mockReset();
    mockedGlobalHookRunner.runBeforeAgentStart.mockReset();
    mockedGlobalHookRunner.runBeforeCompaction.mockReset();
    mockedGlobalHookRunner.runAfterCompaction.mockReset();
    mockedContextEngine.info.ownsCompaction = false;
    mockedCompactDirect.mockResolvedValue({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    mockedCoerceToFailoverError.mockReturnValue(null);
    mockedDescribeFailoverError.mockImplementation((err: unknown) => ({
      message: err instanceof Error ? err.message : String(err),
      reason: undefined,
      status: undefined,
      code: undefined,
    }));
    mockedSessionLikelyHasOversizedToolResults.mockReturnValue(false);
    mockedTruncateOversizedToolResultsInSession.mockResolvedValue({
      truncated: false,
      truncatedCount: 0,
      reason: "no oversized tool results",
    });
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("attempts compaction when LLM times out with high context usage (>65%)", async () => {
    // First attempt: timeout with high usage (150k / 200k = 75%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { total: 150000 },
        } as never,
      }),
    );
    // Compaction succeeds
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "timeout recovery compaction",
        tokensBefore: 150000,
        tokensAfter: 80000,
      }),
    );
    // Retry after compaction succeeds
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "test-session",
        sessionFile: "/tmp/session.json",
        tokenBudget: 200000,
        force: true,
        compactionTarget: "budget",
        runtimeContext: expect.objectContaining({
          trigger: "timeout_recovery",
          attempt: 1,
          maxAttempts: 1,
        }),
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("retries the prompt after successful timeout compaction", async () => {
    // First attempt: timeout with high usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { total: 160000 },
        } as never,
      }),
    );
    // Compaction succeeds
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "compacted for timeout",
        tokensBefore: 160000,
        tokensAfter: 60000,
      }),
    );
    // Second attempt succeeds
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Verify the loop continued (retry happened)
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("falls through to normal handling when timeout compaction fails", async () => {
    // Timeout with high usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { total: 150000 },
        } as never,
      }),
    );
    // Compaction does not reduce context
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Compaction was attempted but failed → falls through to timeout error payload
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("does not attempt compaction when context usage is low", async () => {
    // Timeout with low usage (20k / 200k = 10%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { total: 20000 },
        } as never,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // No compaction attempt for low usage
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("does not attempt compaction when aborted", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        aborted: true,
        lastAssistant: {
          usage: { total: 180000 },
        } as never,
      }),
    );

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it("does not attempt compaction when timedOutDuringCompaction is true", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        timedOutDuringCompaction: true,
        lastAssistant: {
          usage: { total: 180000 },
        } as never,
      }),
    );

    await runEmbeddedPiAgent(overflowBaseRunParams);

    // timedOutDuringCompaction skips timeout-triggered compaction
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it("catches thrown errors from contextEngine.compact during timeout recovery", async () => {
    // Timeout with high usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { total: 150000 },
        } as never,
      }),
    );
    // Compaction throws
    mockedCompactDirect.mockRejectedValueOnce(new Error("engine crashed"));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Should not crash — falls through to normal timeout handling
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });
});
