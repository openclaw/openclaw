import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecProcessOutcome } from "./bash-tools.exec-runtime.js";

const taskRuntime = vi.hoisted(() => ({
  createRunningTaskRun: vi.fn(),
  finalizeTaskRunByRunId: vi.fn(),
  recordTaskRunProgressByRunId: vi.fn(),
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
    taskRuntime.recordTaskRunProgressByRunId.mockReset();
  });

  it.each([
    {
      command: "pnpm test src/agents/example.test.ts",
      label: "pnpm test src/agents/example.test.ts",
    },
    {
      command: "\u001b[32mpnpm\u001b[0m\n  run\tbuild ",
      label: "pnpm run build",
      task: "pnpm\n  run\tbuild",
    },
    {
      command: `curl --token ${"x".repeat(140)} https://example.com`,
      label: "curl --token xxxxxx…xxxx https://example.com",
    },
    {
      command: `echo ${"x".repeat(130)}`,
      label: `echo ${"x".repeat(114)}…`,
      task: `echo ${"x".repeat(130)}`,
    },
    { command: " \n\t ", label: "CLI command" },
  ])(
    "creates a silent CLI ledger row with a bounded, redacted command: $label",
    ({ command, label, task = label }) => {
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
        task,
        notifyPolicy: "silent",
        deliveryStatus: "not_applicable",
        startedAt: 100,
        lastEventAt: 100,
      });
    },
  );

  it("heartbeats a live detached exec and stops heartbeating after finalization", () => {
    vi.useFakeTimers();
    try {
      taskRuntime.createRunningTaskRun.mockReturnValue({ taskId: "task-1" });
      vi.setSystemTime(1_000);

      const handle = createBackgroundExecTask({
        processSessionId: "quiet-run",
        command: "sleep 3600",
        sessionKey: "agent:main:main",
        agentId: "main",
        startedAt: 100,
      });
      expect(handle).not.toBeNull();

      vi.advanceTimersByTime(60_000);
      expect(taskRuntime.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(1);
      expect(taskRuntime.recordTaskRunProgressByRunId).toHaveBeenLastCalledWith({
        runId: "exec:quiet-run",
        runtime: "cli",
        sessionKey: "agent:main:main",
        lastEventAt: 61_000,
        progressSummary: "Command running",
      });

      finalizeBackgroundExecTask({
        handle,
        outcome: {
          status: "completed",
          exitCode: 0,
          exitSignal: null,
          durationMs: 60_000,
          aggregated: "",
          timedOut: false,
        },
      });
      vi.advanceTimersByTime(120_000);
      expect(taskRuntime.recordTaskRunProgressByRunId).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

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
  ])(
    "finalizes $label before wake without persisting process output",
    ({ outcome, status, error }) => {
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
        }),
      );
      expect(JSON.stringify(taskRuntime.finalizeTaskRunByRunId.mock.calls)).not.toContain(
        "secret output",
      );
      expect(JSON.stringify(taskRuntime.finalizeTaskRunByRunId.mock.calls)).not.toContain(
        "processSessionId",
      );
    },
  );
});
