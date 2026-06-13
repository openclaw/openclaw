import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedClassifyFailoverReason,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

// Regression coverage: runEmbeddedAgent must forward continueWorkOpts
// and requestCompactionOpts into the attempt-layer params so that
// createOpenClawCodingTools (which calls createOpenClawTools) gets the
// callbacks. Without forwarding, the createOpenClawTools warn guard fires and
// only continue_delegate registers in the main-session LLM
// tool-schema — continue_work + request_compaction are absent from the
// LLM-callable function-tool-list even though they are configured.
//
// The caller constructs the opts based on agents.defaults.continuation.enabled;
// this regression test pins runEmbeddedAgent forwarding so the configured opts
// survive the trip to the attempt layer.

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

describe("runEmbeddedAgent continuation opts forwarding", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
    mockedGlobalHookRunner.hasHooks.mockImplementation(() => false);
    mockedClassifyFailoverReason.mockReturnValue(null);
  });

  it("forwards continueWorkOpts to runEmbeddedAttempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const continueWorkOpts = {
      requestContinuation: () => undefined,
    };

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-868-continue-work-forward",
      continueWorkOpts,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const attemptParams = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as {
      continueWorkOpts?: typeof continueWorkOpts;
    };
    expect(attemptParams.continueWorkOpts).toBe(continueWorkOpts);
  });

  it("forwards requestCompactionOpts to runEmbeddedAttempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const requestCompactionOpts = {
      sessionId: "session-868-compaction",
      getContextUsage: () => 0.005,
      triggerCompaction: async () => ({ ok: true, compacted: true }),
    };

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-868-request-compaction-forward",
      requestCompactionOpts,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const attemptParams = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as {
      requestCompactionOpts?: typeof requestCompactionOpts;
    };
    expect(attemptParams.requestCompactionOpts).toBe(requestCompactionOpts);
  });

  it("forwards both continueWorkOpts and requestCompactionOpts in the same call", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    const continueWorkOpts = { requestContinuation: () => undefined };
    const requestCompactionOpts = {
      sessionId: "session-868-both",
      getContextUsage: () => 0,
      triggerCompaction: async () => ({ ok: true, compacted: true }),
    };

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-868-both-forward",
      continueWorkOpts,
      requestCompactionOpts,
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const attemptParams = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as {
      continueWorkOpts?: typeof continueWorkOpts;
      requestCompactionOpts?: typeof requestCompactionOpts;
    };
    expect(attemptParams.continueWorkOpts).toBe(continueWorkOpts);
    expect(attemptParams.requestCompactionOpts).toBe(requestCompactionOpts);
  });

  it("leaves both undefined when caller omits them", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedAgent({
      ...overflowBaseRunParams,
      provider: "openai",
      model: "gpt-5.4",
      runId: "run-868-omitted",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    const attemptParams = mockedRunEmbeddedAttempt.mock.calls[0]?.[0] as {
      continueWorkOpts?: unknown;
      requestCompactionOpts?: unknown;
    };
    expect(attemptParams.continueWorkOpts).toBeUndefined();
    expect(attemptParams.requestCompactionOpts).toBeUndefined();
  });
});
