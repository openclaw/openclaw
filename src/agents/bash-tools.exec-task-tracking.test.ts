import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ExecProcessOutcome } from "./bash-tools.exec-types.js";

const taskRuntime = vi.hoisted(() => ({
  prepareRunningTaskRun: vi.fn(),
}));

vi.mock("../tasks/detached-task-runtime.js", () => taskRuntime);

import {
  createBackgroundExecTask,
  finalizeBackgroundExecTask,
} from "./bash-tools.exec-task-tracking.js";

describe("background exec task tracking", () => {
  beforeEach(() => {
    taskRuntime.prepareRunningTaskRun.mockReset();
  });

  it("keeps the captured V1 runtime creation and finalization synchronous", () => {
    const finalizeRun = vi.fn();
    taskRuntime.prepareRunningTaskRun.mockReturnValue({
      kind: "legacy",
      task: { taskId: "task-v1" },
      finalizeRun,
    });
    const assertCurrent = vi.fn();
    const handle = createBackgroundExecTask({
      processSessionId: "legacy-exec",
      command: "echo done",
      sessionKey: "agent:main:main",
      startedAt: 100,
      assertCurrent,
    });
    if (!handle || handle instanceof Promise) {
      throw new Error("V1 creation must complete synchronously");
    }
    const pending = finalizeBackgroundExecTask({
      handle,
      outcome: {
        status: "completed",
        exitCode: 0,
        exitSignal: null,
        durationMs: 25,
        aggregated: "",
        timedOut: false,
      },
    });
    expect(pending).toBeUndefined();
    expect(assertCurrent).toHaveBeenCalledOnce();
    expect(finalizeRun).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        runId: "exec:legacy-exec",
        runtime: "cli",
        sessionKey: "agent:main:main",
        status: "succeeded",
        clearError: true,
        detail: { exitCode: 0 },
      }),
    );
  });

  it.each(["create", "finalize"] as const)(
    "settles a worker %s rejection without a synchronous fallback",
    async (phase) => {
      const finalizeActive = vi.fn(async () => {
        throw new Error("worker terminal write refused");
      });
      taskRuntime.prepareRunningTaskRun.mockReturnValue({
        kind: "receipt",
        create: async () => {
          if (phase === "create") {
            throw new Error("worker creation refused");
          }
          return { task: { taskId: "refused-worker" }, finalizeActive };
        },
      });
      const handle = await createBackgroundExecTask({
        processSessionId: "refused-exec",
        command: "echo done",
        sessionKey: "agent:main:main",
        startedAt: 100,
        assertCurrent() {},
      });
      await finalizeBackgroundExecTask({
        handle,
        outcome: {
          status: "completed",
          exitCode: 0,
          exitSignal: null,
          durationMs: 25,
          aggregated: "",
          timedOut: false,
        },
      });
      expect(finalizeActive).toHaveBeenCalledTimes(phase === "create" ? 0 : 1);
      expect(taskRuntime.prepareRunningTaskRun).toHaveBeenCalledOnce();
      expect(handle === null).toBe(phase === "create");
    },
  );

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
    async ({ command, label, task = label }) => {
      taskRuntime.prepareRunningTaskRun.mockReturnValue({
        kind: "receipt",
        create: async () => ({ task: { taskId: "task-1" }, finalizeActive: vi.fn() }),
      });

      const assertCurrent = vi.fn();
      const handle = await createBackgroundExecTask({
        processSessionId: "amber-reef",
        command,
        sessionKey: "agent:main:main",
        agentId: "main",
        startedAt: 100,
        assertCurrent,
      });

      expect(handle).toEqual({
        taskId: "task-1",
        runId: "exec:amber-reef",
        sessionKey: "agent:main:main",
        finalize: expect.any(Function),
      });
      expect(taskRuntime.prepareRunningTaskRun).toHaveBeenCalledWith(
        {
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
        },
        assertCurrent,
      );
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
  ])(
    "finalizes $label before wake without persisting process output",
    async ({ outcome, status, error }) => {
      const finalize = vi.fn();
      await finalizeBackgroundExecTask({
        handle: {
          taskId: "task-1",
          runId: "exec:amber-reef",
          sessionKey: "agent:main:main",
          finalize,
        },
        outcome,
      });

      expect(finalize).toHaveBeenCalledWith(
        expect.objectContaining({
          status,
          ...(error ? { error } : { clearError: true }),
        }),
      );
      expect(JSON.stringify(finalize.mock.calls)).not.toContain("secret output");
      expect(JSON.stringify(finalize.mock.calls)).not.toContain("processSessionId");
    },
  );
});
