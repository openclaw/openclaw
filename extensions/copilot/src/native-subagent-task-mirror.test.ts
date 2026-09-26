import type { SessionEvent } from "@github/copilot-sdk";
import type {
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntime,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCopilotNativeSubagentTaskMirror } from "./native-subagent-task-mirror.js";

const taskRuntimeMocks = vi.hoisted(() => ({ runtime: undefined as unknown }));

vi.mock("openclaw/plugin-sdk/agent-harness-task-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-task-runtime")>();
  return {
    ...actual,
    createAgentHarnessTaskRuntime: vi.fn(() => taskRuntimeMocks.runtime),
  };
});

type NativeSubagentEventType = "subagent.started" | "subagent.completed" | "subagent.failed";

function makeEvent<T extends NativeSubagentEventType>(
  type: T,
  data: Extract<SessionEvent, { type: T }>["data"],
  agentId?: string,
): Extract<SessionEvent, { type: T }> {
  return {
    data,
    id: `${type}-id`,
    parentId: null,
    timestamp: "2024-01-01T00:00:00.000Z",
    type,
    ...(agentId ? { agentId } : {}),
  } as Extract<SessionEvent, { type: T }>;
}

function createRuntime() {
  const records = new Map<string, AgentHarnessTaskRecord>();
  const runtime = {
    assertTaskAssignmentSupported: vi.fn(),
    createRunningTaskRunAsync: vi.fn<
      NonNullable<AgentHarnessTaskRuntime["createRunningTaskRunAsync"]>
    >(async (params) => {
      const task: AgentHarnessTaskRecord = {
        taskId: `task-${params.runId}`,
        runtime: "subagent",
        taskKind: "copilot-native",
        runId: params.runId,
        requesterSessionKey: "agent:parent:session",
        ownerKey: "agent:parent:session",
        scopeKind: "session",
        task: params.task,
        status: "running",
        deliveryStatus: "not_applicable",
        notifyPolicy: "silent",
        createdAt: 0,
      };
      records.set(task.taskId, task);
      return task;
    }),
    finalizeTaskRunByRunIdAsync: vi.fn<
      NonNullable<AgentHarnessTaskRuntime["finalizeTaskRunByRunIdAsync"]>
    >(async (params) => {
      const current = [...records.values()].find((task) => task.runId === params.runId);
      if (!current) {
        return [];
      }
      const task: AgentHarnessTaskRecord = {
        ...current,
        status: params.status,
        endedAt: params.endedAt,
        lastEventAt: params.lastEventAt,
        error: params.error,
        progressSummary: params.progressSummary ?? undefined,
        terminalSummary: params.terminalSummary ?? undefined,
      };
      records.set(task.taskId, task);
      return [task];
    }),
    prepareTaskRunRead: vi.fn<NonNullable<AgentHarnessTaskRuntime["prepareTaskRunRead"]>>(
      async (runId) => () => [...records.values()].filter((task) => task.runId === runId),
    ),
  } satisfies Required<
    Pick<
      AgentHarnessTaskRuntime,
      | "assertTaskAssignmentSupported"
      | "createRunningTaskRunAsync"
      | "finalizeTaskRunByRunIdAsync"
      | "prepareTaskRunRead"
    >
  >;
  return { ...runtime, records };
}

function createMirror(
  runtime: ReturnType<typeof createRuntime>,
  params: { agentId?: string; now?: () => number } = {},
) {
  taskRuntimeMocks.runtime = runtime;
  const mirror = createCopilotNativeSubagentTaskMirror({
    ...params,
    scope: {} as AgentHarnessTaskRuntimeScope,
  });
  if (!mirror) {
    throw new Error("expected Copilot native subagent task mirror");
  }
  return mirror;
}

describe("CopilotNativeSubagentTaskMirror", () => {
  it("does not create a mirror without a host-issued task scope", () => {
    expect(createCopilotNativeSubagentTaskMirror({})).toBeUndefined();
  });

  it("mirrors start and completion using agentId with toolCallId fallback", async () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { agentId: "parent-agent", now: () => 100 });

    await mirror.handleEvent(
      makeEvent(
        "subagent.started",
        {
          agentDescription: "inspect the repository",
          agentDisplayName: "Researcher",
          agentName: "researcher",
          toolCallId: "call-1",
        },
        "child-1",
      ),
    );
    await mirror.handleEvent(
      makeEvent(
        "subagent.completed",
        {
          agentDisplayName: "Researcher",
          agentName: "researcher",
          toolCallId: "call-1",
          totalToolCalls: 2,
          totalTokens: 30,
        },
        "child-1",
      ),
    );

    expect(runtime.createRunningTaskRunAsync).toHaveBeenCalledWith({
      sourceId: "call-1",
      agentId: "parent-agent",
      runId: "copilot-agent:child-1",
      label: "Researcher",
      task: "inspect the repository",
      notifyPolicy: "silent",
      deliveryStatus: "not_applicable",
      preferMetadata: true,
      startedAt: 100,
      lastEventAt: 100,
      progressSummary: "Subagent started.",
    });
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledWith({
      runId: "copilot-agent:child-1",
      expectedTask: {
        taskId: "task-copilot-agent:child-1",
        runId: "copilot-agent:child-1",
        runtime: "subagent",
        taskKind: "copilot-native",
        ownerKey: "agent:parent:session",
        scopeKind: "session",
        createdAt: 0,
        childSessionKey: undefined,
      },
      status: "succeeded",
      endedAt: 100,
      lastEventAt: 100,
      progressSummary: "Subagent completed.",
      terminalSummary: "Subagent completed (2 tool calls, 30 tokens).",
    });
  });

  it("uses toolCallId when the SDK omits agentId", async () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 200 });

    await mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-2",
      }),
    );
    await mirror.handleEvent(
      makeEvent("subagent.failed", {
        agentDisplayName: "Researcher",
        agentName: "researcher",
        error: "failed",
        toolCallId: "call-2",
      }),
    );

    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "copilot-agent:call-2",
        status: "failed",
        error: "failed",
      }),
    );
  });

  it("keeps parallel subagents distinct when they share a parent tool call", async () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 250 });

    for (const agentId of ["child-1", "child-2"]) {
      await mirror.handleEvent(
        makeEvent(
          "subagent.started",
          {
            agentDescription: `inspect ${agentId}`,
            agentDisplayName: "Researcher",
            agentName: "researcher",
            toolCallId: "call-shared",
          },
          agentId,
        ),
      );
    }
    for (const agentId of ["child-1", "child-2"]) {
      await mirror.handleEvent(
        makeEvent(
          "subagent.completed",
          {
            agentDisplayName: "Researcher",
            agentName: "researcher",
            toolCallId: "call-shared",
          },
          agentId,
        ),
      );
    }

    expect(runtime.createRunningTaskRunAsync).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: "copilot-agent:child-1" }),
    );
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: "copilot-agent:child-2" }),
    );
  });

  it("finalizes active tasks when the parent attempt tears down", async () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 300 });

    await mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-3",
      }),
    );
    await mirror.finalizeActiveRuns();

    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "copilot-agent:call-3",
        status: "cancelled",
        endedAt: 300,
        lastEventAt: 300,
        error: "Subagent ended with its parent attempt.",
        progressSummary: "Subagent cancelled with its parent attempt.",
        terminalSummary: "Subagent cancelled.",
      }),
    );
  });

  it.each([
    { terminal: "subagent.completed", failureMode: "throw" },
    { terminal: "subagent.completed", failureMode: "empty" },
    { terminal: "subagent.completed", failureMode: "read" },
    { terminal: "subagent.failed", failureMode: "throw" },
    { terminal: "subagent.failed", failureMode: "empty" },
    { terminal: "subagent.failed", failureMode: "read" },
  ] as const)(
    "retries the original $terminal result after $failureMode",
    async ({ terminal, failureMode }) => {
      const runtime = createRuntime();
      let now = 100;
      const mirror = createMirror(runtime, { now: () => now });
      const data = {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-retry",
      };
      await mirror.handleEvent(makeEvent("subagent.started", data, "child-retry"));
      if (failureMode === "throw") {
        runtime.finalizeTaskRunByRunIdAsync.mockRejectedValueOnce(new Error("store unavailable"));
      } else if (failureMode === "read") {
        runtime.prepareTaskRunRead.mockResolvedValueOnce(() => {
          throw new Error("store unavailable");
        });
      } else {
        runtime.finalizeTaskRunByRunIdAsync.mockResolvedValueOnce([]);
      }
      const completed = makeEvent(
        "subagent.completed",
        { ...data, totalTokens: 30 },
        "child-retry",
      );
      const failed = makeEvent(
        "subagent.failed",
        { ...data, error: "child failed" },
        "child-retry",
      );
      await expect(
        mirror.handleEvent(terminal === "subagent.completed" ? completed : failed),
      ).rejects.toThrow(failureMode === "empty" ? "did not persist" : "store unavailable");
      expect([...runtime.records.values()][0]?.status).toBe("running");
      now = 200;
      await mirror.handleEvent(terminal === "subagent.completed" ? failed : completed);
      expect([...runtime.records.values()]).toEqual([
        expect.objectContaining({
          taskId: "task-copilot-agent:child-retry",
          status: terminal === "subagent.completed" ? "succeeded" : "failed",
          endedAt: 100,
          lastEventAt: 100,
          error: terminal === "subagent.failed" ? "child failed" : undefined,
          terminalSummary:
            terminal === "subagent.completed"
              ? "Subagent completed (30 tokens)."
              : "Subagent failed.",
        }),
      ]);
      await mirror.handleEvent(completed);
      await mirror.finalizeActiveRuns();
      expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledTimes(
        failureMode === "read" ? 1 : 2,
      );
    },
  );

  it("finalizes every active child and retains failed cancellation for retry", async () => {
    const runtime = createRuntime();
    let now = 100;
    const mirror = createMirror(runtime, { now: () => now });
    for (const toolCallId of ["call-1", "call-2"]) {
      await mirror.handleEvent(
        makeEvent("subagent.started", {
          agentDescription: "inspect",
          agentDisplayName: "Researcher",
          agentName: "researcher",
          toolCallId,
        }),
      );
    }
    runtime.finalizeTaskRunByRunIdAsync.mockRejectedValueOnce(new Error("store unavailable"));
    await expect(mirror.finalizeActiveRuns()).rejects.toThrow("store unavailable");
    expect([...runtime.records.values()].map((task) => task.status)).toEqual([
      "running",
      "cancelled",
    ]);
    now = 200;
    await mirror.finalizeActiveRuns();
    expect([...runtime.records.values()]).toEqual([
      expect.objectContaining({ status: "cancelled", endedAt: 100 }),
      expect.objectContaining({ status: "cancelled", endedAt: 100 }),
    ]);
    expect(runtime.finalizeTaskRunByRunIdAsync).toHaveBeenCalledTimes(3);
  });

  it.each(["removed", "replacement", "same-ID replacement", "terminal"] as const)(
    "skips finalization when the owned task is %s",
    async (disposition) => {
      const runtime = createRuntime();
      const mirror = createMirror(runtime);
      const data = {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-1",
      };
      await mirror.handleEvent(makeEvent("subagent.started", data));
      const task = [...runtime.records.values()][0];
      if (!task) {
        throw new Error("Expected persisted native task");
      }
      runtime.records.delete(task.taskId);
      if (disposition === "replacement") {
        runtime.records.set("replacement", { ...task, taskId: "replacement" });
      } else if (disposition === "same-ID replacement") {
        runtime.records.set(task.taskId, { ...task, createdAt: task.createdAt + 1 });
      } else if (disposition === "terminal") {
        runtime.records.set(task.taskId, { ...task, status: "cancelled", endedAt: 50 });
      }
      await mirror.handleEvent(makeEvent("subagent.completed", data));
      await mirror.finalizeActiveRuns();
      expect(runtime.finalizeTaskRunByRunIdAsync).not.toHaveBeenCalled();
      expect([...runtime.records.values()].map((record) => record.status)).toEqual(
        disposition === "removed" ? [] : [disposition === "terminal" ? "cancelled" : "running"],
      );
    },
  );

  it("retains a failed start for teardown and clears it after creation succeeds", async () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime);
    const data = {
      agentDescription: "inspect",
      agentDisplayName: "Researcher",
      agentName: "researcher",
      toolCallId: "call-start-retry",
    };
    const failure = new Error("creation unavailable");
    runtime.createRunningTaskRunAsync.mockRejectedValueOnce(failure);
    await expect(mirror.handleEvent(makeEvent("subagent.started", data))).rejects.toBe(failure);
    await expect(mirror.finalizeActiveRuns()).rejects.toBe(failure);
    expect(runtime.records.size).toBe(0);

    await mirror.handleEvent(makeEvent("subagent.started", data));
    await mirror.handleEvent(makeEvent("subagent.completed", data));
    await mirror.finalizeActiveRuns();
    expect([...runtime.records.values()]).toEqual([
      expect.objectContaining({ runId: "copilot-agent:call-start-retry", status: "succeeded" }),
    ]);
  });
});
