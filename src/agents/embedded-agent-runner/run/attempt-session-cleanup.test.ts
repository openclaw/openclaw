import { beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  cleanupEmbeddedAttemptResources: vi.fn(),
  clearToolSearchCatalog: vi.fn(),
  flushEmbeddedAttemptTrajectoryRecorder: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../tool-search.js", () => ({
  clearToolSearchCatalog: hoisted.clearToolSearchCatalog,
}));
vi.mock("../logger.js", () => ({
  log: { warn: hoisted.warn },
}));
vi.mock("./attempt-trajectory-flush-cleanup.js", () => ({
  flushEmbeddedAttemptTrajectoryRecorder: hoisted.flushEmbeddedAttemptTrajectoryRecorder,
}));
vi.mock("./attempt.subscription-cleanup.js", () => ({
  cleanupEmbeddedAttemptResources: hoisted.cleanupEmbeddedAttemptResources,
}));

import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-cleanup.js";

const attempt = {
  runId: "run-1",
  sessionId: "session-1",
  sessionFile: "/tmp/session.jsonl",
} as never;

function createInput(overrides: Record<string, unknown> = {}) {
  const sessionLockController = {
    acquireForCleanup: vi.fn(async () => ({ release: vi.fn() })),
    hasSessionTakeover: vi.fn(() => false),
  };
  const emitDiagnosticRunCompleted = vi.fn();
  const trajectoryRecorder = {
    recordEvent: vi.fn(),
    describeFlushState: vi.fn(),
    flush: vi.fn(),
  };
  const state = {
    aborted: false,
    externalAbort: false,
    timedOut: false,
    idleTimedOut: false,
    timedOutDuringCompaction: false,
    timedOutDuringToolExecution: false,
    timedOutByRunBudget: false,
    promptError: null,
    beforeAgentRunBlocked: false,
  };
  return {
    attempt,
    sessionLockController,
    sessionAgentId: "main",
    buildAbortSettlePromise: () => null,
    trajectoryRecorder,
    trajectoryEndRecorded: false,
    trajectoryTerminalStatus: "success" as const,
    cleanupYieldAborted: false,
    emitDiagnosticRunCompleted,
    readState: () => state,
    ...overrides,
  };
}

describe("cleanupEmbeddedAttemptSessionPhase", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.cleanupEmbeddedAttemptResources.mockResolvedValue(undefined);
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockResolvedValue(undefined);
  });

  it("records session.ended after resource cleanup and preserves terminal status", async () => {
    const order: string[] = [];
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockImplementation(async () => {
      order.push("flush");
    });
    hoisted.cleanupEmbeddedAttemptResources.mockImplementation(async () => {
      order.push("cleanup");
    });
    const input = createInput({
      trajectoryRecorder: {
        recordEvent: vi.fn((type: string) => {
          order.push(type);
        }),
        describeFlushState: vi.fn(),
        flush: vi.fn(),
      },
    });

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(order).toEqual(["flush", "cleanup", "session.ended", "flush"]);
    expect(input.trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({ status: "success", aborted: false }),
    );
    expect(hoisted.clearToolSearchCatalog).toHaveBeenCalledWith(
      expect.objectContaining({ runId: "run-1", sessionId: "session-1", agentId: "main" }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
  });

  it("derives session.ended status from cleanup failures", async () => {
    hoisted.cleanupEmbeddedAttemptResources.mockRejectedValue(new Error("cleanup boom"));
    const input = createInput({
      trajectoryTerminalStatus: "success",
    });

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toThrow(
      "cleanup boom",
    );
    expect(input.trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
      "session.ended",
      expect.objectContaining({ status: "error" }),
    );
  });

  it("re-reads abort state after trajectory flushing", async () => {
    let aborted = false;
    hoisted.flushEmbeddedAttemptTrajectoryRecorder.mockImplementation(async () => {
      aborted = true;
    });
    const input = createInput({
      readState: () => ({
        aborted,
        externalAbort: aborted,
        timedOut: aborted,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        promptError: aborted ? new Error("request aborted") : null,
        beforeAgentRunBlocked: false,
      }),
    });

    await cleanupEmbeddedAttemptSessionPhase(input as never);

    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ aborted: true }),
    );
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
      "error",
      expect.objectContaining({ message: "request aborted" }),
      undefined,
    );
  });

  it("preserves the prompt error when cleanup detects session takeover", async () => {
    const promptError = new Error("prompt failed");
    const sessionLockController = {
      acquireForCleanup: vi.fn(async () => ({ release: vi.fn() })),
      hasSessionTakeover: vi.fn(() => true),
    };
    const emitDiagnosticRunCompleted = vi.fn();
    const input = createInput({
      sessionLockController,
      emitDiagnosticRunCompleted,
      trajectoryRecorder: null,
      readState: () => ({
        aborted: false,
        externalAbort: false,
        timedOut: false,
        idleTimedOut: false,
        timedOutDuringCompaction: false,
        timedOutDuringToolExecution: false,
        timedOutByRunBudget: false,
        promptError,
        beforeAgentRunBlocked: false,
      }),
    });

    await expect(cleanupEmbeddedAttemptSessionPhase(input as never)).rejects.toMatchObject({
      name: "EmbeddedAttemptSessionTakeoverError",
      promptError,
    });
    expect(hoisted.cleanupEmbeddedAttemptResources).toHaveBeenCalledWith(
      expect.objectContaining({ skipSessionFlush: true }),
    );
    expect(emitDiagnosticRunCompleted).toHaveBeenCalledWith("error", promptError, undefined);
  });
});
