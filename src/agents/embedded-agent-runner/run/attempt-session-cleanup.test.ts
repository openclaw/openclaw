import { beforeEach, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({ cleanup: vi.fn(), clear: vi.fn(), flush: vi.fn() }));

vi.mock("../../tool-search.js", () => ({ clearToolSearchCatalog: hoisted.clear }));
vi.mock("../logger.js", () => ({ log: { warn: vi.fn() } }));
vi.mock("./attempt-trajectory-flush.js", () => ({
  flushEmbeddedAttemptTrajectoryRecorder: hoisted.flush,
}));
vi.mock("./attempt-subscription-cleanup.js", () => ({
  cleanupEmbeddedAttemptResources: hoisted.cleanup,
}));

import { createDeferred } from "../../../../test/helpers/promise.js";
import type { AgentRunAttemptTerminal } from "../../agent-run-terminal-outcome.js";
import { cleanupEmbeddedAttemptSessionPhase } from "./attempt-session-settle.js";

function createInput(overrides: Record<string, unknown> = {}) {
  const state: { terminal: AgentRunAttemptTerminal; beforeAgentRunBlockedBy?: string } = {
    terminal: { kind: "ok" },
  };
  return {
    attempt: { runId: "run-1", sessionId: "session-1" },
    transcriptLifecycle: {
      beginCleanup: vi.fn(async (onDrained?: () => void) => onDrained?.()),
      dispose: vi.fn(async () => undefined),
    },
    toolSearchCatalogRef: {},
    buildAbortSettlePromise: () => null,
    trajectoryRecorder: { recordEvent: vi.fn() },
    trajectoryEndRecorded: false,
    emitDiagnosticRunCompleted: vi.fn(),
    state,
    ...overrides,
  };
}

function expectResourceCleanup(fields: Record<string, unknown>) {
  expect(hoisted.cleanup).toHaveBeenCalledWith(expect.objectContaining(fields));
}

beforeEach(() => {
  vi.clearAllMocks();
  hoisted.cleanup.mockResolvedValue(undefined);
  hoisted.flush.mockResolvedValue(undefined);
});

it("records the terminal event before transcript-safe resource cleanup", async () => {
  const clearTranscriptRunCallbacks = vi.fn();
  const input = createInput({ sessionManager: { clearTranscriptRunCallbacks } });
  hoisted.cleanup.mockImplementation(async () => {
    expect(clearTranscriptRunCallbacks).toHaveBeenCalledOnce();
  });

  await cleanupEmbeddedAttemptSessionPhase(input as never);

  expect(input.trajectoryRecorder.recordEvent).toHaveBeenCalledWith(
    "session.ended",
    expect.objectContaining({ status: "cleanup", aborted: false }),
  );
  expect(hoisted.flush).toHaveBeenCalledWith(
    expect.objectContaining({
      runId: "run-1",
      sessionId: "session-1",
      trajectoryRecorder: input.trajectoryRecorder,
    }),
  );
  expect(hoisted.clear).toHaveBeenCalledWith({ catalogRef: input.toolSearchCatalogRef });
  expectResourceCleanup({ aborted: false });
  expect(input.transcriptLifecycle.beginCleanup).toHaveBeenCalledOnce();
  expect(input.transcriptLifecycle.dispose).toHaveBeenCalledOnce();
  expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith("completed", null, undefined);
});

it.each(["compaction observation", "blocked", "abort during flush"] as const)(
  "reports cleanup status for %s",
  async (kind) => {
    const input = createInput();
    const error = new Error("request aborted");
    if (kind === "blocked") {
      input.state.beforeAgentRunBlockedBy = "before_agent";
    } else if (kind === "abort during flush") {
      hoisted.flush.mockImplementation(async () => {
        input.state.terminal = {
          kind: "timeout",
          source: "external",
          phase: "prompt",
          aborted: true,
          failure: { source: "prompt", error },
        };
      });
    } else {
      input.state.terminal = { kind: "timeout", phase: "compaction", source: "observation" };
    }
    await cleanupEmbeddedAttemptSessionPhase(input as never);
    expectResourceCleanup({ aborted: kind !== "blocked" });
    expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledWith(
      kind === "abort during flush" ? "error" : kind === "blocked" ? "blocked" : "completed",
      kind === "abort during flush" ? error : null,
      kind === "blocked" ? { blockedBy: "before_agent" } : undefined,
    );
  },
);

it("re-reads cancellation after draining transcript writes before resource cleanup", async () => {
  const controller = new AbortController();
  const drain = createDeferred();
  const draining = createDeferred();
  const abortSettle = createDeferred();
  const buildAbortSettlePromise = vi.fn(() => abortSettle.promise);
  const input = createInput({
    attempt: { runId: "run-1", sessionId: "session-1", abortSignal: controller.signal },
    buildAbortSettlePromise,
  });
  input.transcriptLifecycle.beginCleanup.mockImplementation(async () => {
    draining.resolve();
    await drain.promise;
  });
  const cleanup = cleanupEmbeddedAttemptSessionPhase(input as never);
  await draining.promise;
  controller.abort();
  expect(hoisted.cleanup).not.toHaveBeenCalled();
  drain.resolve();
  await cleanup;
  expectResourceCleanup({
    aborted: true,
    abortSignal: controller.signal,
    abortSettlePromise: abortSettle.promise,
  });
  expect(buildAbortSettlePromise).toHaveBeenCalledOnce();
  expect(input.transcriptLifecycle.dispose).toHaveBeenCalledOnce();
  expect(input.emitDiagnosticRunCompleted).toHaveBeenCalledOnce();
  abortSettle.resolve();
});
