import "./run.overflow-compaction.mocks.shared.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { pickFallbackThinkingLevel } from "../pi-embedded-helpers.js";
import { runEmbeddedPiAgent } from "./run.js";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  mockedCoerceToFailoverError,
  mockedDescribeFailoverError,
  mockedGlobalHookRunner,
  mockedResolveFailoverStatus,
} from "./run.overflow-compaction.mocks.shared.js";
import {
  mockedCompactDirect,
  mockedContextEngine,
  mockedRunEmbeddedAttempt,
  mockedSessionLikelyHasOversizedToolResults,
  mockedTruncateOversizedToolResultsInSession,
  overflowBaseRunParams,
} from "./run.overflow-compaction.shared-test.js";

const mockedPickFallbackThinkingLevel = vi.mocked(pickFallbackThinkingLevel);

describe("timeout-triggered compaction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    mockedPickFallbackThinkingLevel.mockReset();
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
    mockedPickFallbackThinkingLevel.mockReturnValue(undefined);
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
  });

  it("attempts compaction when LLM times out with high prompt token usage (>65%)", async () => {
    // First attempt: timeout with high prompt usage (150k / 200k = 75%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
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
    // First attempt: timeout with high prompt usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 160000 },
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
    // Timeout with high prompt usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
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

  it("does not attempt compaction when prompt token usage is low", async () => {
    // Timeout with low prompt usage (20k / 200k = 10%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 20000 },
        } as never,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // No compaction attempt for low usage
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("does not attempt compaction for low-context timeouts on later retries", async () => {
    mockedPickFallbackThinkingLevel.mockReturnValueOnce("low");
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          promptError: new Error("unsupported reasoning mode"),
        }),
      )
      .mockResolvedValueOnce(
        makeAttemptResult({
          timedOut: true,
          lastAssistant: {
            usage: { input: 20000 },
          } as never,
        }),
      );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("still attempts compaction for timed-out attempts that set aborted", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        aborted: true,
        lastAssistant: {
          usage: { input: 180000 },
        } as never,
      }),
    );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "timeout recovery compaction",
        tokensBefore: 180000,
        tokensAfter: 90000,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.meta.error).toBeUndefined();
  });

  it("does not attempt compaction when timedOutDuringCompaction is true", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        timedOutDuringCompaction: true,
        lastAssistant: {
          usage: { input: 180000 },
        } as never,
      }),
    );

    await runEmbeddedPiAgent(overflowBaseRunParams);

    // timedOutDuringCompaction skips timeout-triggered compaction
    expect(mockedCompactDirect).not.toHaveBeenCalled();
  });

  it("falls through to failover rotation after max timeout compaction attempts", async () => {
    // First attempt: timeout with high prompt usage (150k / 200k = 75%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
        } as never,
      }),
    );
    // Compaction succeeds on first timeout
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "timeout recovery compaction",
        tokensBefore: 150000,
        tokensAfter: 80000,
      }),
    );
    // Second attempt after compaction: also times out with high usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 140000 },
        } as never,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Compaction was only attempted once (first timeout); second timeout
    // should NOT trigger compaction because the counter is exhausted.
    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    // Falls through to timeout error payload (failover rotation path)
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("catches thrown errors from contextEngine.compact during timeout recovery", async () => {
    // Timeout with high prompt usage
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
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

  it("fires compaction hooks during timeout recovery for ownsCompaction engines", async () => {
    mockedContextEngine.info.ownsCompaction = true;
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName) => hookName === "before_compaction" || hookName === "after_compaction",
    );
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          timedOut: true,
          lastAssistant: {
            usage: { input: 160000 },
          } as never,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));
    mockedCompactDirect.mockResolvedValueOnce({
      ok: true,
      compacted: true,
      result: {
        summary: "engine-owned timeout compaction",
        tokensAfter: 70,
      },
    });

    await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedGlobalHookRunner.runBeforeCompaction).toHaveBeenCalledWith(
      { messageCount: -1, sessionFile: "/tmp/session.json" },
      expect.objectContaining({
        sessionKey: "test-key",
      }),
    );
    expect(mockedGlobalHookRunner.runAfterCompaction).toHaveBeenCalledWith(
      {
        messageCount: -1,
        compactedCount: -1,
        tokenCount: 70,
        sessionFile: "/tmp/session.json",
      },
      expect.objectContaining({
        sessionKey: "test-key",
      }),
    );
  });

  it("increments attempt counter even when compaction returns compacted:false", async () => {
    // First timeout: high prompt usage, compaction fails (compacted:false)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
        } as never,
      }),
    );
    mockedCompactDirect.mockResolvedValueOnce({
      ok: false,
      compacted: false,
      reason: "nothing to compact",
    });
    // The failed compaction falls through to timeout error; the runner
    // returns with an error payload (no retry because compacted was false).
    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("increments attempt counter when compact() throws, blocking subsequent attempts", async () => {
    // First timeout: high prompt usage, compact() throws
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
        } as never,
      }),
    );
    mockedCompactDirect.mockRejectedValueOnce(new Error("engine crashed"));
    // Falls through to timeout error on first attempt
    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(result.payloads?.[0]?.isError).toBe(true);
  });

  it("uses prompt/input tokens for ratio, not total tokens", async () => {
    // Timeout where total tokens are high (150k) but input/prompt tokens
    // are low (20k / 200k = 10%).  Should NOT trigger compaction because
    // the ratio is based on prompt tokens, not total.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 20000, total: 150000 },
        } as never,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Despite high total tokens, low prompt tokens mean no compaction
    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });
});
