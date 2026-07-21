// Coverage for terminating an embedded run after a trusted critical loop signal.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolOutcomeObservation } from "../agent-tools.before-tool-call.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams as baseParams,
  resetRunOverflowCompactionHarnessMocks,
  warmRunOverflowCompactionHarness,
} from "./run.overflow-compaction.harness.js";
import type { EmbeddedRunAttemptParams } from "./run/types.js";

let runEmbeddedAgent: typeof import("./run.js").runEmbeddedAgent;

const criticalSignal = {
  detector: "generic_repeat",
  count: 20,
  toolName: "read",
  message: "CRITICAL: repeated read outcomes",
} as const;

const siblingOutcome: ToolOutcomeObservation = {
  toolName: "write",
  argsHash: "args",
  resultHash: "result",
};

function createBlockingPersistenceRecorder() {
  const message = { role: "user" as const, content: "test prompt", timestamp: 1 };
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waitForRuntimePersistence = vi.fn(async () => {
    await pending;
  });
  return {
    release,
    waitForRuntimePersistence,
    recorder: {
      message,
      resolveMessage: vi.fn(async () => message),
      markRuntimePersistencePending: vi.fn(),
      markRuntimePersisted: vi.fn(),
      markBlocked: vi.fn(),
      hasPersisted: vi.fn(() => false),
      isBlocked: vi.fn(() => false),
      hasRuntimePersistencePending: vi.fn(() => true),
      waitForRuntimePersistence,
      persistApproved: vi.fn(async () => undefined),
      persistBlocked: vi.fn(async () => undefined),
      persistFallback: vi.fn(async () => undefined),
    },
  };
}

describe("critical tool loop run termination", () => {
  beforeAll(async () => {
    ({ runEmbeddedAgent } = await loadRunOverflowCompactionHarness());
    await warmRunOverflowCompactionHarness(runEmbeddedAgent);
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it.each(["outcome-first", "critical-first"] as const)(
    "keeps the terminal signal sticky when a sibling tool outcome arrives %s",
    async (order) => {
      const setTerminalLifecycleMeta = vi.fn();
      mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams: unknown) => {
        const params = rawParams as Pick<
          EmbeddedRunAttemptParams,
          "abortSignal" | "onCriticalToolLoop" | "onToolOutcome"
        >;
        if (order === "outcome-first") {
          params.onToolOutcome?.(siblingOutcome);
        }
        params.onCriticalToolLoop?.(criticalSignal);
        if (order === "critical-first") {
          params.onToolOutcome?.(siblingOutcome);
        }

        expect(params.abortSignal?.aborted).toBe(true);
        expect(params.abortSignal?.reason).toMatchObject({
          name: "CriticalToolLoopError",
          detector: "generic_repeat",
          count: 20,
          toolName: "read",
        });
        return makeAttemptResult({ setTerminalLifecycleMeta });
      });

      const result = await runEmbeddedAgent({
        ...baseParams,
        runId: `critical-loop-${order}`,
      });

      expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
      expect(setTerminalLifecycleMeta.mock.lastCall?.[0]).toMatchObject({
        replayInvalid: true,
        livenessState: "blocked",
      });
      expect(result).toMatchObject({
        payloads: [{ text: criticalSignal.message, isError: true }],
        meta: {
          replayInvalid: true,
          livenessState: "blocked",
          error: { kind: "hook_block", message: criticalSignal.message },
        },
      });
    },
  );

  it("preserves the critical reason when backend cancellation rejects", async () => {
    const persistence = createBlockingPersistenceRecorder();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams: unknown) => {
      const params = rawParams as Pick<
        EmbeddedRunAttemptParams,
        "abortSignal" | "onCriticalToolLoop"
      >;
      params.onCriticalToolLoop?.(criticalSignal);
      expect(params.abortSignal?.aborted).toBe(true);
      throw new Error("backend stopped after cancellation");
    });

    let settled = false;
    const runPromise = runEmbeddedAgent({
      ...baseParams,
      runId: "critical-loop-backend-rejection",
      userTurnTranscriptRecorder: persistence.recorder,
    });
    void runPromise.finally(() => {
      settled = true;
    });

    await vi.waitFor(() => {
      expect(persistence.waitForRuntimePersistence).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    persistence.release();
    const result = await runPromise;

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.meta).toMatchObject({
      replayInvalid: true,
      livenessState: "blocked",
      error: { kind: "hook_block", message: criticalSignal.message },
    });
  });

  it("keeps caller cancellation when a detector signal arrives afterward", async () => {
    const controller = new AbortController();
    const callerAbort = new Error("caller cancelled first");
    callerAbort.name = "AbortError";
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams: unknown) => {
      const params = rawParams as Pick<EmbeddedRunAttemptParams, "onCriticalToolLoop">;
      controller.abort(callerAbort);
      params.onCriticalToolLoop?.(criticalSignal);
      throw new Error("backend stopped after cancellation");
    });

    await expect(
      runEmbeddedAgent({
        ...baseParams,
        runId: "caller-abort-before-critical-loop",
        abortSignal: controller.signal,
      }),
    ).rejects.toBe(callerAbort);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("does not replace a plugin-owned abort rejection with a late detector signal", async () => {
    const backendAbort = new Error("plugin transport stopped after abort");
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams: unknown) => {
      const params = rawParams as Pick<
        EmbeddedRunAttemptParams,
        "onAttemptAbort" | "onCriticalToolLoop"
      >;
      params.onAttemptAbort?.();
      params.onCriticalToolLoop?.(criticalSignal);
      throw backendAbort;
    });

    await expect(
      runEmbeddedAgent({
        ...baseParams,
        runId: "attempt-abort-before-critical-loop",
      }),
    ).rejects.toBe(backendAbort);
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("normalizes caller cancellation when it follows a detector signal", async () => {
    const controller = new AbortController();
    const callerAbort = new Error("caller cancelled after detector");
    callerAbort.name = "AbortError";
    const persistence = createBlockingPersistenceRecorder();
    const setTerminalLifecycleMeta = vi.fn();
    const lateAssistant = {
      role: "assistant",
      stopReason: "stop",
      provider: "openai",
      model: "gpt-5.5",
      content: [{ type: "text", text: "Late answer" }],
    } as const;
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams: unknown) => {
      const params = rawParams as Pick<EmbeddedRunAttemptParams, "onCriticalToolLoop">;
      params.onCriticalToolLoop?.(criticalSignal);
      return makeAttemptResult({
        assistantTexts: ["Late answer"],
        lastAssistant: lateAssistant as never,
        currentAttemptAssistant: lateAssistant as never,
        setTerminalLifecycleMeta,
      });
    });

    const runPromise = runEmbeddedAgent({
      ...baseParams,
      runId: "caller-abort-after-critical-loop",
      abortSignal: controller.signal,
      userTurnTranscriptRecorder: persistence.recorder,
    });
    await vi.waitFor(() => {
      expect(persistence.waitForRuntimePersistence).toHaveBeenCalledOnce();
    });
    controller.abort(callerAbort);
    persistence.release();
    const result = await runPromise;

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
    expect(result.payloads).toBeUndefined();
    expect(result.meta).toMatchObject({ aborted: true });
    expect(result.meta?.error).toBeUndefined();
    expect(setTerminalLifecycleMeta.mock.lastCall?.[0]).toMatchObject({
      aborted: true,
      livenessState: "blocked",
      stopReason: "aborted",
    });
  });

  it("finishes canonical attempt bookkeeping before returning a critical block", async () => {
    const persistedMessage = {
      role: "user" as const,
      content: "test prompt",
      timestamp: 1,
    };
    let resolvePersistApproved!: (result: {
      sessionFile: string;
      sessionEntry: undefined;
      messageId: string;
      message: typeof persistedMessage;
    }) => void;
    let pendingPersistence: Promise<void> | undefined;
    const persistApproved = vi.fn(
      () =>
        new Promise<{
          sessionFile: string;
          sessionEntry: undefined;
          messageId: string;
          message: typeof persistedMessage;
        }>((resolve) => {
          resolvePersistApproved = resolve;
        }),
    );
    const setTerminalLifecycleMeta = vi.fn();
    mockedRunEmbeddedAttempt.mockImplementationOnce(async (rawParams: unknown) => {
      const params = rawParams as Pick<
        EmbeddedRunAttemptParams,
        "onCriticalToolLoop" | "onUserMessagePersisted"
      >;
      params.onUserMessagePersisted?.(persistedMessage as never);
      params.onCriticalToolLoop?.(criticalSignal);
      return makeAttemptResult({
        sessionIdUsed: "critical-loop-rotated-session",
        sessionFileUsed: "/tmp/critical-loop-rotated.jsonl",
        attemptUsage: { input: 120, output: 30, total: 150 },
        setTerminalLifecycleMeta,
      });
    });

    let settled = false;
    const runPromise = runEmbeddedAgent({
      ...baseParams,
      runId: "critical-loop-canonical-bookkeeping",
      userTurnTranscriptRecorder: {
        message: persistedMessage,
        resolveMessage: vi.fn(async () => persistedMessage),
        markRuntimePersistencePending: vi.fn((pending: Promise<void>) => {
          pendingPersistence = pending;
        }),
        markRuntimePersisted: vi.fn(),
        markBlocked: vi.fn(),
        hasPersisted: vi.fn(() => false),
        isBlocked: vi.fn(() => false),
        hasRuntimePersistencePending: vi.fn(() => pendingPersistence !== undefined),
        waitForRuntimePersistence: vi.fn(async () => {
          await pendingPersistence;
        }),
        persistApproved,
        persistBlocked: vi.fn(async () => undefined),
        persistFallback: vi.fn(async () => undefined),
      },
    });
    void runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await vi.waitFor(() => {
      expect(persistApproved).toHaveBeenCalledOnce();
    });
    expect(settled).toBe(false);
    resolvePersistApproved({
      sessionFile: "/tmp/openclaw-transcript.jsonl",
      sessionEntry: undefined,
      messageId: "critical-loop-user-message",
      message: persistedMessage,
    });

    const result = await runPromise;
    expect(result.meta).toMatchObject({
      replayInvalid: true,
      livenessState: "blocked",
      agentMeta: {
        sessionId: "critical-loop-rotated-session",
        sessionFile: "/tmp/critical-loop-rotated.jsonl",
        usage: { input: 120, output: 30, total: 150 },
      },
    });
    expect(setTerminalLifecycleMeta.mock.lastCall?.[0]).toMatchObject({
      replayInvalid: true,
      livenessState: "blocked",
    });
  });
});
