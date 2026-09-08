import type {
  TaskSummary,
  TasksListParams,
} from "../packages/gateway-protocol/src/schema/tasks.js";
import type { ControlUiMockGateway } from "../ui/src/test-helpers/control-ui-e2e.ts";

function historyMessage(role: "assistant" | "user", text: string, timestamp: number) {
  return {
    content: [{ type: "text", text }],
    role,
    timestamp,
    __openclaw:
      role === "user" ? { senderId: "mock-operator", senderName: "Riley Example" } : undefined,
  };
}

function finishedTask(n: number, now: number, sessionKey: string): TaskSummary {
  const status = n === 3 ? "failed" : n === 4 ? "cancelled" : n === 5 ? "timed_out" : "completed";
  const task: TaskSummary = {
    id: `task-mock-finished-${n}`,
    taskId: `task-mock-finished-${n}`,
    status,
    runtime: "subagent",
    agentId: "main",
    title: `Finished mock task number ${n} with a fairly long title`,
    createdAt: now - n * 600_000,
    startedAt: now - n * 600_000,
    endedAt: now - n * 500_000,
    updatedAt: now - n * 500_000,
    sessionKey,
    ownerKey: sessionKey,
  };
  if (status === "failed") {
    return { ...task, error: "The fixture audit found an invalid event scope." };
  }
  if (status === "cancelled") {
    return { ...task, terminalSummary: "Cancelled after the parent session changed direction." };
  }
  if (status === "timed_out") {
    return { ...task, error: "Timed out while waiting for the remote preview to become ready." };
  }
  return {
    ...task,
    deliveryStatus: n === 2 ? "session_queued" : "delivered",
    diffStat: { files: n + 1, added: n * 3, removed: n },
    terminalSummary: `Mock task ${n} completed its assigned inspection.`,
  };
}

export function buildBackgroundTasksMock(baseTime: number) {
  const now = Date.now();
  const taskSessionKey = "agent:openclaw-mock:subagent:mock-task-1";
  const requesterSessionKey = "agent:main:main";
  const cliSessionKey = "agent:main:production-export";
  const tasks: TaskSummary[] = [
    {
      id: "task-mock-queued",
      taskId: "task-mock-queued",
      status: "queued",
      runtime: "subagent",
      agentId: "main",
      title: "Capture the narrow mobile layout",
      createdAt: now - 8_000,
      updatedAt: now - 8_000,
      progressSummary: "Waiting for a background-task slot",
      sessionKey: requesterSessionKey,
      ownerKey: requesterSessionKey,
    },
    {
      id: "task-mock-running",
      taskId: "task-mock-running",
      status: "running",
      runtime: "subagent",
      agentId: "openclaw-mock",
      title: "Map run-status indicator code",
      createdAt: now - 25_000,
      startedAt: now - 25_000,
      updatedAt: now,
      toolUseCount: 7,
      diffStat: { files: 3, added: 128, removed: 20 },
      lastToolName: "read",
      progressSummary: "Tracing task events through the background task rail",
      sessionKey: requesterSessionKey,
      ownerKey: requesterSessionKey,
      childSessionKey: taskSessionKey,
    },
    {
      id: "task-mock-running-2",
      taskId: "task-mock-running-2",
      kind: "exec",
      status: "running",
      runtime: "cli",
      agentId: "main",
      title: "Audit gateway event scope guards",
      createdAt: now - 95_000,
      startedAt: now - 95_000,
      updatedAt: now - 1_000,
      progressSummary: "Comparing agent-scoped task event paths",
      diffStat: { files: 2, added: 55, removed: 21 },
      sessionKey: cliSessionKey,
      ownerKey: cliSessionKey,
    },
    finishedTask(1, now, requesterSessionKey),
    finishedTask(2, now, requesterSessionKey),
    finishedTask(3, now, requesterSessionKey),
    finishedTask(4, now, requesterSessionKey),
    finishedTask(5, now, requesterSessionKey),
  ];
  return {
    tasks,
    sessions: [taskSessionKey].map((key) => ({ key })),
    sessionTranscripts: {
      [taskSessionKey]: {
        messages: [
          historyMessage(
            "user",
            "Map the run-status indicator code and report the active execution path.",
            baseTime + 40 * 60_000,
          ),
          historyMessage(
            "assistant",
            "Tracing task events from the gateway through the chat background-tasks rail.",
            baseTime + 40 * 60_000 + 8_000,
          ),
        ],
        thinkingLevel: null,
      },
    },
  };
}

function installBackgroundTasksMock(seed: TaskSummary[]): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const tasks = new Map(seed.map((task) => [task.id, task]));
  gateway.setRequestHandler("tasks.list", ({ params: input, respond }) => {
    const params = (input ?? {}) as TasksListParams;
    const statuses = typeof params.status === "string" ? [params.status] : params.status;
    const sortBy = params.sortBy ?? "updatedAt";
    const rows = Array.from(tasks.values()).filter(
      (task) =>
        (!params.sessionKey ||
          [task.sessionKey, task.childSessionKey, task.ownerKey].includes(params.sessionKey)) &&
        (params.sessionKey || !params.agentId || task.agentId === params.agentId) &&
        (!statuses || statuses.includes(task.status)),
    );
    rows.sort((a, b) => Number(b[sortBy] ?? 0) - Number(a[sortBy] ?? 0));
    const offset = Number(params.cursor ?? 0);
    const limit = params.limit ?? 500;
    respond({
      tasks: rows.slice(offset, offset + limit),
      ...(offset + limit < rows.length ? { nextCursor: String(offset + limit) } : {}),
    });
  });
  gateway.setRequestHandler("tasks.get", ({ params: input, respond }) => {
    const task = tasks.get((input as { taskId: string }).taskId);
    respond(
      task
        ? {
            task: {
              ...task,
              prompt: `Inspect ${task.title?.toLowerCase()} and report the current execution path.`,
            },
          }
        : { __mockError: { code: "INVALID_REQUEST", message: "Mock task not found." } },
    );
  });
  gateway.setRequestHandler("tasks.cancel", ({ params: input, respond, emit }) => {
    const task = tasks.get((input as { taskId: string }).taskId);
    if (!task) {
      respond({ found: false, cancelled: false, reason: "Mock task not found." });
      return;
    }
    const cancelled = task.status === "queued" || task.status === "running";
    if (cancelled) {
      task.status = "cancelled";
      task.endedAt = Date.now();
      task.updatedAt = task.endedAt;
      task.progressSummary = undefined;
      task.terminalSummary = "Cancelled from the Control UI mock.";
    }
    respond({
      found: true,
      cancelled,
      reason: cancelled ? task.terminalSummary : "Task is already terminal.",
      task,
    });
    if (cancelled) {
      emit("task", { action: "upserted", task });
    }
  });
}

export function backgroundTasksMockInitScript(baseTime: number): string {
  return `(() => { const __name = (target) => target; (${installBackgroundTasksMock.toString()})(${JSON.stringify(buildBackgroundTasksMock(baseTime).tasks)}); })();`;
}
