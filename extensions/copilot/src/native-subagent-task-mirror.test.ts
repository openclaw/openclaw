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
    tryCreateRunningTaskRun: vi.fn<AgentHarnessTaskRuntime["tryCreateRunningTaskRun"]>((params) => {
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
    finalizeTaskRunByRunId: vi.fn<AgentHarnessTaskRuntime["finalizeTaskRunByRunId"]>((params) => {
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
    listTaskRecords: vi.fn<AgentHarnessTaskRuntime["listTaskRecords"]>(() => [...records.values()]),
  } satisfies Pick<
    AgentHarnessTaskRuntime,
    "tryCreateRunningTaskRun" | "finalizeTaskRunByRunId" | "listTaskRecords"
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

  it("mirrors start and completion using agentId with toolCallId fallback", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { agentId: "parent-agent", now: () => 100 });

    mirror.handleEvent(
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
    mirror.handleEvent(
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

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledWith({
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
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "copilot-agent:child-1",
      status: "succeeded",
      endedAt: 100,
      lastEventAt: 100,
      progressSummary: "Subagent completed.",
      terminalSummary: "Subagent completed (2 tool calls, 30 tokens).",
    });
  });

  it("uses toolCallId when the SDK omits agentId", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 200 });

    mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-2",
      }),
    );
    mirror.handleEvent(
      makeEvent("subagent.failed", {
        agentDisplayName: "Researcher",
        agentName: "researcher",
        error: "failed",
        toolCallId: "call-2",
      }),
    );

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "copilot-agent:call-2",
        status: "failed",
        error: "failed",
      }),
    );
  });

  it("keeps parallel subagents distinct when they share a parent tool call", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 250 });

    for (const agentId of ["child-1", "child-2"]) {
      mirror.handleEvent(
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
      mirror.handleEvent(
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

    expect(runtime.tryCreateRunningTaskRun).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ runId: "copilot-agent:child-1" }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ runId: "copilot-agent:child-2" }),
    );
  });

  it("finalizes active tasks when the parent attempt tears down", () => {
    const runtime = createRuntime();
    const mirror = createMirror(runtime, { now: () => 300 });

    mirror.handleEvent(
      makeEvent("subagent.started", {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-3",
      }),
    );
    mirror.finalizeActiveRuns();

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith({
      runId: "copilot-agent:call-3",
      status: "cancelled",
      endedAt: 300,
      lastEventAt: 300,
      error: "Subagent ended with its parent attempt.",
      progressSummary: "Subagent cancelled with its parent attempt.",
      terminalSummary: "Subagent cancelled.",
    });
  });

  it.each([
    { terminal: "subagent.completed", failureMode: "throw" },
    { terminal: "subagent.completed", failureMode: "empty" },
    { terminal: "subagent.failed", failureMode: "throw" },
    { terminal: "subagent.failed", failureMode: "empty" },
  ] as const)(
    "retries the original $terminal result after $failureMode",
    ({ terminal, failureMode }) => {
      const runtime = createRuntime();
      let now = 100;
      const mirror = createMirror(runtime, { now: () => now });
      const data = {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-retry",
      };
      mirror.handleEvent(makeEvent("subagent.started", data, "child-retry"));
      if (failureMode === "throw") {
        runtime.finalizeTaskRunByRunId.mockImplementationOnce(() => {
          throw new Error("store unavailable");
        });
      } else {
        runtime.finalizeTaskRunByRunId.mockReturnValueOnce([]);
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
      expect(() =>
        mirror.handleEvent(terminal === "subagent.completed" ? completed : failed),
      ).toThrow(failureMode === "throw" ? "store unavailable" : "did not persist");
      expect([...runtime.records.values()][0]?.status).toBe("running");
      now = 200;
      mirror.handleEvent(terminal === "subagent.completed" ? failed : completed);
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
      mirror.handleEvent(completed);
      mirror.finalizeActiveRuns();
      expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(2);
    },
  );

  it("finalizes every active child and retains failed cancellation for retry", () => {
    const runtime = createRuntime();
    let now = 100;
    const mirror = createMirror(runtime, { now: () => now });
    for (const toolCallId of ["call-1", "call-2"]) {
      mirror.handleEvent(
        makeEvent("subagent.started", {
          agentDescription: "inspect",
          agentDisplayName: "Researcher",
          agentName: "researcher",
          toolCallId,
        }),
      );
    }
    runtime.finalizeTaskRunByRunId.mockImplementationOnce(() => {
      throw new Error("store unavailable");
    });
    expect(() => mirror.finalizeActiveRuns()).toThrow("store unavailable");
    expect([...runtime.records.values()].map((task) => task.status)).toEqual([
      "running",
      "cancelled",
    ]);
    now = 200;
    mirror.finalizeActiveRuns();
    expect([...runtime.records.values()]).toEqual([
      expect.objectContaining({ status: "cancelled", endedAt: 100 }),
      expect.objectContaining({ status: "cancelled", endedAt: 100 }),
    ]);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(3);
  });

  it.each(["removed", "replacement", "terminal"] as const)(
    "accepts empty finalization only when the owned task is %s",
    (disposition) => {
      const runtime = createRuntime();
      const mirror = createMirror(runtime);
      const data = {
        agentDescription: "inspect",
        agentDisplayName: "Researcher",
        agentName: "researcher",
        toolCallId: "call-1",
      };
      mirror.handleEvent(makeEvent("subagent.started", data));
      const task = [...runtime.records.values()][0];
      if (!task) {
        throw new Error("Expected persisted native task");
      }
      runtime.records.delete(task.taskId);
      if (disposition === "replacement") {
        runtime.records.set("replacement", { ...task, taskId: "replacement" });
      } else if (disposition === "terminal") {
        runtime.records.set(task.taskId, { ...task, status: "cancelled", endedAt: 50 });
      }
      mirror.handleEvent(makeEvent("subagent.completed", data));
      mirror.finalizeActiveRuns();
      expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
      expect([...runtime.records.values()].map((record) => record.status)).toEqual(
        disposition === "removed" ? [] : [disposition === "terminal" ? "cancelled" : "running"],
      );
    },
  );
});
