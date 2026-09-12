import type {
  TaskSummary,
  TasksHistoryParams,
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
  const cappedMessageId = "mock-task-full-reply";
  const fullMessage = historyMessage(
    "assistant",
    "The task event reaches the detail panel through its task ID. The child session supplies the transcript.\n\n**Full reply recovered:** the activity feed loads capped replies with the child session and task agent, while keeping the preview visible until the complete message arrives.",
    baseTime + 40 * 60_000 + 17_000,
  );
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
    fullMessage: {
      sessionKey: taskSessionKey,
      agentId: "openclaw-mock",
      messageId: cappedMessageId,
      message: fullMessage,
    },
    sessions: [taskSessionKey].map((key) => ({ key })),
    sessionTranscripts: {
      [taskSessionKey]: {
        messages: [
          historyMessage("assistant", "Starting the run-status investigation.", baseTime),
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
          {
            role: "assistant",
            timestamp: baseTime + 40 * 60_000 + 9_000,
            content: [
              {
                type: "toolCall",
                id: "mock-typecheck",
                name: "exec",
                arguments: {
                  command: "pnpm tsgo --project tsconfig.gateway.json",
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "mock-typecheck",
            toolName: "exec",
            content: [{ type: "text", text: "Typecheck passed." }],
          },
          historyMessage(
            "assistant",
            "The gateway types pass. Next I am checking the rail update path.",
            baseTime + 40 * 60_000 + 12_000,
          ),
          {
            role: "assistant",
            timestamp: baseTime + 40 * 60_000 + 13_000,
            content: [
              {
                type: "toolCall",
                id: "mock-read",
                name: "read",
                arguments: {
                  path: "ui/src/pages/chat/components/chat-task-detail.ts",
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "mock-read",
            toolName: "read",
            content: [{ type: "text", text: "Task detail renderer loaded." }],
          },
          {
            role: "assistant",
            timestamp: baseTime + 40 * 60_000 + 14_000,
            content: [
              {
                type: "toolCall",
                id: "mock-edit",
                name: "edit",
                arguments: {
                  path: "ui/src/styles/chat/sidebar.css",
                  oldText: "display: flex;",
                  newText: "display: flex; flex-direction: column;",
                },
              },
            ],
          },
          {
            role: "toolResult",
            toolCallId: "mock-edit",
            toolName: "edit",
            content: [{ type: "text", text: "Updated task panel layout." }],
          },
          {
            ...historyMessage(
              "assistant",
              "The task event reaches the detail panel through its task ID.\n...(truncated)...",
              fullMessage.timestamp,
            ),
            __openclaw: { id: cappedMessageId, truncated: true, reason: "display-cap" },
          },
          historyMessage(
            "assistant",
            "Checking the narrow panel layout and history paging before reporting the result.",
            baseTime + 40 * 60_000 + 20_000,
          ),
        ].map((message, index) =>
          Object.assign(message, { messageId: `mock-task-message-${index}` }),
        ),
        thinkingLevel: null,
      },
    },
  };
}

function installBackgroundTasksMock(seed: ReturnType<typeof buildBackgroundTasksMock>): void {
  const gateway = (window as Window & { openclawControlUiE2eGateway?: ControlUiMockGateway })
    .openclawControlUiE2eGateway;
  if (!gateway) {
    return;
  }
  const tasks = new Map(seed.tasks.map((task) => [task.id, task]));
  const transcripts = new Map(Object.entries(seed.sessionTranscripts));
  gateway.setRequestHandler("chat.message.get", ({ params: input, respond }) => {
    const params = input as { sessionKey: string; agentId?: string; messageId: string };
    const full = seed.fullMessage;
    respond(
      params.sessionKey === full.sessionKey &&
        params.agentId === full.agentId &&
        params.messageId === full.messageId
        ? { ok: true, message: full.message }
        : { ok: false, unavailableReason: "not_found" },
    );
  });
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
  gateway.setRequestHandler("tasks.history", ({ params: input, respond }) => {
    const params = input as TasksHistoryParams;
    const task = tasks.get(params.taskId);
    const messages = task?.childSessionKey
      ? (transcripts.get(task.childSessionKey)?.messages ?? [])
      : [];
    const end = params.cursor ? Number(params.cursor) : messages.length;
    // Keep one earlier page visible even when the client requests its full limit.
    const start = Math.max(0, end - Math.min(params.limit ?? 11, 11));
    respond({
      messages: messages.slice(start, end),
      ...(start > 0 ? { nextCursor: String(start) } : {}),
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
  return `(() => { const __name = (target) => target; (${installBackgroundTasksMock.toString()})(${JSON.stringify(buildBackgroundTasksMock(baseTime))}); })();`;
}
