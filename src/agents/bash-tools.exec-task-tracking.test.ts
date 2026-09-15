import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";

const taskRuntime = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  finalizeTaskRunByRunId: vi.fn(),
}));

vi.mock("../tasks/detached-task-runtime.js", () => taskRuntime);

import {
  createBackgroundExecTask,
  finalizeBackgroundExecTask,
} from "./bash-tools.exec-task-tracking.js";

describe("background exec task tracking", () => {
  beforeEach(() => {
    taskRuntime.createRunningTaskRun.mockReset();
    taskRuntime.finalizeTaskRunByRunId.mockReset();
  });

  it.each([
    {
      command: "pnpm test src/agents/example.test.ts",
      label: "pnpm test src/agents/example.test.ts",
    },
    { command: "\u001b[32mpnpm\u001b[0m\n  run\tbuild ", label: "pnpm run build" },
    {
      command: `curl --token ${"x".repeat(140)} https://example.com`,
      label: "curl --token xxxxxx…xxxx https://example.com",
    },
    { command: `echo ${"x".repeat(130)}`, label: `echo ${"x".repeat(114)}…` },
    { command: " \n\t ", label: "CLI command" },
  ])(
    "creates a silent CLI ledger row with a bounded, redacted command: $label",
    ({ command, label }) => {
      taskRuntime.createRunningTaskRun.mockReturnValue({ taskId: "task-1" });

      const handle = createBackgroundExecTask({
        processSessionId: "amber-reef",
        command,
        sessionKey: "agent:main:main",
        agentId: "main",
        startedAt: 100,
      });

      expect(handle).toEqual({
        taskId: "task-1",
        runId: "exec:amber-reef",
        sessionKey: "agent:main:main",
      });
      expect(taskRuntime.createRunningTaskRun).toHaveBeenCalledWith({
        runtime: "cli",
        taskKind: "exec",
        sourceId: "amber-reef",
        requesterSessionKey: "agent:main:main",
        ownerKey: "agent:main:main",
        scopeKind: "session",
        agentId: "main",
        requesterAgentId: "main",
        runId: "exec:amber-reef",
        label,
        task: label,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        startedAt: 100,
        lastEventAt: 100,
      });
    },
  );

  it.each([
    {
      label: "success",
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        aggregated: "secret output",
        timedOut: false,
      } satisfies ExecProcessOutcome,
      status: "succeeded",
      error: undefined,
    },
    {
      label: "timeout",
      outcome: {
        status: "failed",
        exitCode: null,
        exitSignal: "SIGTERM",
        exitReason: "overall-timeout",
        durationMs: 25,
        aggregated: "secret output",
        timedOut: true,
        failureKind: "overall-timeout",
        reason: "secret output\nCommand timed out",
      } satisfies ExecProcessOutcome,
      status: "timed_out",
      error: "Command timed out",
    },
    {
      label: "nonzero exit",
      outcome: {
        status: "completed",
        exitCode: 17,
        exitSignal: null,
        durationMs: 25,
        aggregated: "secret output",
        timedOut: false,
      } satisfies ExecProcessOutcome,
      status: "failed",
      error: "Command failed (exit code 17)",
    },
    {
      label: "operator cancellation",
      outcome: {
        status: "failed",
        exitCode: null,
        exitSignal: "SIGTERM",
        exitReason: "manual-cancel",
        durationMs: 25,
        aggregated: "secret output",
        timedOut: false,
        failureKind: "signal",
        reason: "secret output\nCommand aborted",
      } satisfies ExecProcessOutcome,
      status: "cancelled",
      error: "Cancelled by operator",
    },
  ])("finalizes $label with a bounded, redacted output tail", ({ outcome, status, error }) => {
    finalizeBackgroundExecTask({
      handle: {
        taskId: "task-1",
        runId: "exec:amber-reef",
        sessionKey: "agent:main:main",
      },
      outcome,
    });

    expect(taskRuntime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "exec:amber-reef",
        runtime: "cli",
        sessionKey: "agent:main:main",
        status,
        ...(error ? { error } : { clearError: true }),
        detail: expect.objectContaining({ outputTail: "secret output" }),
      }),
    );
    expect(JSON.stringify(taskRuntime.finalizeTaskRunByRunId.mock.calls)).not.toContain(
      "processSessionId",
    );
  });

  it("redacts and bounds the stored output tail to the most recent output", () => {
    finalizeBackgroundExecTask({
      handle: {
        taskId: "task-1",
        runId: "exec:amber-reef",
        sessionKey: "agent:main:main",
      },
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        aggregated: `token sk-abcdef1234567890\n${"x".repeat(5_000)}\nEND`,
        timedOut: false,
      },
    });

    const detail = (
      taskRuntime.finalizeTaskRunByRunId.mock.calls[0]?.[0] as {
        detail?: { outputTail?: string };
      }
    )?.detail;
    expect(typeof detail?.outputTail).toBe("string");
    expect(detail?.outputTail).not.toContain("sk-abcdef1234567890");
    expect(detail?.outputTail?.endsWith("END")).toBe(true);
    expect(detail?.outputTail?.startsWith("…")).toBe(true);
    expect(detail?.outputTail?.length).toBeLessThanOrEqual(4_000);
  });

  it("omits the output tail when the command produced no output", () => {
    finalizeBackgroundExecTask({
      handle: {
        taskId: "task-1",
        runId: "exec:amber-reef",
        sessionKey: "agent:main:main",
      },
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        aggregated: "  \n\t ",
        timedOut: false,
      },
    });

    const detail = taskRuntime.finalizeTaskRunByRunId.mock.calls[0]?.[0]?.detail;
    expect(detail).not.toHaveProperty("outputTail");
  });
});
