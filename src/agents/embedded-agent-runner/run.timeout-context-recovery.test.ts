import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeAttemptResult, makeCompactionSuccess } from "./run.overflow-compaction.fixture.js";
import { createRecoveryDefaults, createRecoveryOwner } from "./run.recovery.test-support.js";
import { recoverEmbeddedRunTimeout } from "./run/timeout-context-recovery.js";
import { markActiveEmbeddedRunAbandoned, resolveEmbeddedRunAbandonment } from "./runs.js";
import {
  registerTestEmbeddedRun as setActiveEmbeddedRun,
  createEmbeddedRunHandle,
  testing as runsTesting,
} from "./runs.test-support.js";

const mocks = vi.hoisted(() => ({ compact: vi.fn(), postCompactionSideEffects: vi.fn() }));
vi.mock("./compaction-hooks.js", () => ({
  runPostCompactionSideEffects: mocks.postCompactionSideEffects,
}));
vi.mock("./logger.js", () => ({ log: { info: vi.fn(), warn: vi.fn() } }));

type RecoveryInput = Parameters<typeof recoverEmbeddedRunTimeout>[0];
const successfulCompaction = (sessionId?: string) =>
  makeCompactionSuccess({
    summary: "timeout recovery",
    tokensBefore: 150_000,
    tokensAfter: 80_000,
    sessionId,
  });

function makeInput(overrides: Partial<RecoveryInput> = {}): RecoveryInput {
  const input: RecoveryInput = {
    ...createRecoveryDefaults(mocks.compact, () => input),
    // Admission and writer fencing have composed coverage in run.compaction-runtime.test.ts.
    prepareRecoveryOwner: () => createRecoveryOwner(input, input.assertRecoveryActive),
    prepareRecoverySession: vi.fn<RecoveryInput["prepareRecoverySession"]>(),
    timedOut: true,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    lastRunPromptUsage: { input: 150_000, total: 150_000 },
    attempt: makeAttemptResult({
      terminal: { kind: "timeout", phase: "prompt", source: "runtime" },
      sessionIdUsed: "session-1",
      assistantTexts: [],
    }),
    harnessRuntime: "openclaw",
    ...overrides,
  };
  return input;
}

describe("timeout recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.compact.mockReset().mockResolvedValue(successfulCompaction());
    runsTesting.resetActiveEmbeddedRuns();
  });
  afterEach(() => {
    runsTesting.resetActiveEmbeddedRuns();
    vi.restoreAllMocks();
  });

  it("uses current context pressure at the 65 percent threshold, not aggregate billing", async () => {
    const input = makeInput({
      lastRunPromptUsage: {
        input: 20_000,
        cacheRead: 150_000,
        total: 190_000,
        contextUsage: { state: "available", promptTokens: 130_000, totalTokens: 130_500 },
      },
    });
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(mocks.compact).not.toHaveBeenCalled();
  });

  it.each([
    { sessionId: "session-1", tokensAfter: 80_000 },
    { sessionId: "unaccepted-successor", tokensAfter: undefined },
  ])(
    "does not attribute $sessionId tokens to the predecessor when acceptance is cancelled",
    async ({ sessionId, tokensAfter }) => {
      const controller = new AbortController();
      const callerError = new Error("caller cancelled successor acceptance");
      mocks.compact.mockResolvedValueOnce(successfulCompaction(sessionId));
      const input = makeInput({
        assertRecoveryActive: () => controller.signal.throwIfAborted(),
        adoptCompactionTranscript: vi.fn(async () => {
          controller.abort(callerError);
          throw callerError;
        }),
      });
      input.runParams.abortSignal = controller.signal;
      await expect(recoverEmbeddedRunTimeout(input)).rejects.toBe(callerError);
      expect(input.state.autoCompactionCount).toBe(1);
      expect(input.state.lastCompactionTokensAfter).toBe(tokensAfter);
      expect(mocks.postCompactionSideEffects).not.toHaveBeenCalled();
      expect(input.prepareCompactedTranscriptRetry).not.toHaveBeenCalled();
    },
  );

  it("counts thrown and empty compactions against the shared retry cap", async () => {
    const input = makeInput();
    mocks.compact
      .mockRejectedValueOnce(new Error("engine crashed"))
      .mockResolvedValue({ ok: false, compacted: false, reason: "nothing to compact" });
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(input.state.timeoutCompactionAttempts).toBe(1);
    expect(input.runOwnsCompactionAfterHook).toHaveBeenCalledWith(
      "timeout recovery",
      expect.objectContaining({ compacted: false, reason: "Error: engine crashed" }),
      undefined,
    );
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(await recoverEmbeddedRunTimeout(input)).toBe(false);
    expect(input.state.timeoutCompactionAttempts).toBe(2);
    expect(mocks.compact).toHaveBeenCalledTimes(2);
  });

  it("restores terminal abandonment when the recovery after-hook fails", async () => {
    const handle = createEmbeddedRunHandle({ runId: "run-1" });
    setActiveEmbeddedRun("session-1", handle, "agent:main:session-1");
    expect(
      markActiveEmbeddedRunAbandoned({
        sessionId: "session-1",
        handle,
        sessionKey: "agent:main:session-1",
        reason: "timeout",
      }),
    ).toBe(true);
    const input = makeInput({
      runOwnsCompactionAfterHook: vi.fn().mockRejectedValue(new Error("after-hook failed")),
    });
    await expect(recoverEmbeddedRunTimeout(input)).rejects.toThrow("after-hook failed");
    expect(resolveEmbeddedRunAbandonment({ sessionId: "session-1" })).toBe("timeout");
  });

  it.each(["durable", "detached"] as const)(
    "keeps %s accounting separate from durable side effects",
    async (sessionPersistence) => {
      const input = makeInput({
        getActiveSession: () => ({ id: "rotated", file: "/tmp/rotated.jsonl" }),
      });
      input.contextEngine.info.ownsCompaction = true;
      input.runParams.sessionPersistence = sessionPersistence;
      expect(await recoverEmbeddedRunTimeout(input)).toBe(true);
      expect(input.state.autoCompactionCount).toBe(1);
      expect(input.prepareCompactedTranscriptRetry).toHaveBeenCalledOnce();
      if (sessionPersistence === "detached") {
        expect(mocks.postCompactionSideEffects).not.toHaveBeenCalled();
      } else {
        expect(mocks.postCompactionSideEffects).toHaveBeenCalledWith({
          config: {},
          sessionKey: "agent:main:session-1",
          sessionId: "rotated",
          agentId: "main",
          sessionFile: "/tmp/rotated.jsonl",
          assertActive: input.assertRecoveryActive,
        });
      }
    },
  );
});
