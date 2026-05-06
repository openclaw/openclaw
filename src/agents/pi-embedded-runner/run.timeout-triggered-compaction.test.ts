import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedCompactDirect,
  mockedContextEngine,
  mockedGetApiKeyForModel,
  mockedGlobalHookRunner,
  mockedLog,
  mockedPickFallbackThinkingLevel,
  mockedResolveAuthProfileOrder,
  mockedRunEmbeddedAttempt,
  mockedRunPostCompactionSideEffects,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

const useTwoAuthProfiles = () => {
  mockedResolveAuthProfileOrder.mockReturnValue(["profile-a", "profile-b"]);
  mockedGetApiKeyForModel.mockImplementation(async ({ profileId } = {}) => ({
    apiKey: `test-key-${profileId ?? "profile-a"}`,
    profileId: profileId ?? "profile-a",
    source: "test",
    mode: "api-key",
  }));
};

describe("timeout-triggered compaction", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("attempts compaction when LLM times out with high prompt token usage (>65%)", async () => {
    // First attempt: timeout with high prompt usage (150k / 200k = 75%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        promptCache: {
          retention: "short",
          lastCallUsage: {
            input: 150000,
            cacheRead: 32000,
            total: 182000,
          },
          observation: {
            broke: false,
            cacheRead: 32000,
          },
          lastCacheTouchAt: 1_700_000_000_000,
        },
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
          promptCache: expect.objectContaining({
            retention: "short",
            lastCallUsage: expect.objectContaining({
              input: 150000,
              cacheRead: 32000,
            }),
            observation: expect.objectContaining({
              broke: false,
              cacheRead: 32000,
            }),
            lastCacheTouchAt: 1_700_000_000_000,
          }),
          trigger: "timeout_recovery",
          attempt: 1,
          maxAttempts: 2,
        }),
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    // Regression guard: timeout-compaction path must emit a
    // [context-pressure:fire] anchor in the same format as the overflow path,
    // so operators grepping for mid-turn pressure triggers (trigger F,
    // RFC §4.1) see the timeout-driven compaction that bypasses
    // checkContextPressure() in agent-runner.ts.
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("[context-pressure:fire] mid-turn trigger=timeout"),
    );
    expect(result.meta.error).toBeUndefined();
    expect(result.meta.agentMeta?.compactionTokensAfter).toBe(80_000);
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
        sessionId: "timeout-rotated-session",
        sessionFile: "/tmp/timeout-rotated-session.json",
      }),
    );
    // Second attempt succeeds
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        promptError: null,
        sessionIdUsed: "timeout-rotated-session",
        sessionFileUsed: "/tmp/timeout-rotated-session.json",
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Verify the loop continued (retry happened)
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        sessionId: "timeout-rotated-session",
        sessionFile: "/tmp/timeout-rotated-session.json",
      }),
    );
    expect(mockedRunPostCompactionSideEffects).not.toHaveBeenCalled();
    expect(result.meta.error).toBeUndefined();
  });

  it("passes channel, thread, message, and sender context into timeout compaction", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 160000 },
        } as never,
      }),
    );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "compacted with full runtime context",
        tokensBefore: 160000,
        tokensAfter: 60000,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      messageChannel: "slack",
      messageProvider: "slack",
      agentAccountId: "acct-1",
      currentChannelId: "channel-1",
      currentThreadTs: "thread-1",
      currentMessageId: "message-1",
      senderId: "sender-1",
      senderIsOwner: true,
    });

    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          messageChannel: "slack",
          messageProvider: "slack",
          agentAccountId: "acct-1",
          currentChannelId: "channel-1",
          currentThreadTs: "thread-1",
          currentMessageId: "message-1",
          senderId: "sender-1",
          senderIsOwner: true,
        }),
      }),
    );
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
    expect(result.meta.livenessState).toBe("blocked");
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

  it("points idle-timeout errors at the provider timeout config key", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        idleTimedOut: true,
        lastAssistant: {
          usage: { input: 20000 },
        } as never,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("models.providers.<id>.timeoutSeconds");
    expect(result.payloads?.[0]?.text).not.toContain("agents.defaults.timeoutSeconds");
  });

  it("retries one silent idle timeout before surfacing an error", async () => {
    mockedRunEmbeddedAttempt
      .mockResolvedValueOnce(
        makeAttemptResult({
          timedOut: true,
          idleTimedOut: true,
          assistantTexts: [],
          lastAssistant: {
            usage: { input: 20000 },
          } as never,
        }),
      )
      .mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(2);
    expect(result.payloads?.[0]?.isError).not.toBe(true);
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

  it("falls through to timeout handling after max timeout compaction attempts", async () => {
    // First attempt: timeout with high prompt usage (150k / 200k = 75%)
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
        } as never,
      }),
    );
    // First compaction succeeds
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "timeout recovery compaction 1",
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
    // Second compaction also succeeds
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "timeout recovery compaction 2",
        tokensBefore: 140000,
        tokensAfter: 70000,
      }),
    );
    // Third attempt after second compaction: still times out
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 130000 },
        } as never,
      }),
    );

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    // Both compaction attempts used; third timeout falls through.
    expect(mockedCompactDirect).toHaveBeenCalledTimes(2);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(3);
    // Falls through to timeout error payload once compaction retries are exhausted.
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
    expect(mockedRunPostCompactionSideEffects).toHaveBeenCalledTimes(1);
  });

  it("does not rotate profiles after compacted:false timeout compaction failure", async () => {
    useTwoAuthProfiles();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        aborted: true,
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

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedCompactDirect).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeContext: expect.objectContaining({
          authProfileId: "profile-a",
          attempt: 1,
          maxAttempts: 2,
        }),
      }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ authProfileId: "profile-a" }),
    );
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("does not rotate profiles after thrown timeout compaction failure", async () => {
    useTwoAuthProfiles();
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        aborted: true,
        lastAssistant: {
          usage: { input: 150000 },
        } as never,
      }),
    );
    mockedCompactDirect.mockRejectedValueOnce(new Error("engine crashed"));

    const result = await runEmbeddedPiAgent(overflowBaseRunParams);

    expect(mockedCompactDirect).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(mockedRunEmbeddedAttempt).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ authProfileId: "profile-a" }),
    );
    expect(result.payloads?.[0]?.isError).toBe(true);
    expect(result.payloads?.[0]?.text).toContain("timed out");
  });

  it("emits [session-key:missing] when sessionKey is missing on timeout path", async () => {
    // Same setup as the first test but with empty sessionKey — the
    // enqueueSystemEvent gate should skip and leave a breadcrumb via the
    // canonical session-key skip helper.
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(
      makeAttemptResult({
        timedOut: true,
        lastAssistant: {
          usage: { input: 150000 },
        } as never,
      }),
    );
    mockedCompactDirect.mockResolvedValueOnce(
      makeCompactionSuccess({
        summary: "timeout recovery compaction",
        tokensBefore: 150000,
        tokensAfter: 80000,
      }),
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({ ...overflowBaseRunParams, sessionKey: "" });

    // The mid-turn [context-pressure:fire] anchor still emits (it uses
    // sessionKey ?? sessionId as a display value, not as a gate).
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("[context-pressure:fire] mid-turn trigger=timeout"),
    );
    // But the system-event enqueue was skipped → canonical breadcrumb emitted.
    expect(mockedLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("[session-key:missing] site=pi-runner.timeout-compaction"),
    );
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
