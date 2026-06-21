// Codex tests cover native subagent monitor plugin behavior.
import type {
  AgentHarnessScopedSetDeliveryStatusParams,
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  CodexNativeSubagentMonitor,
  registerCodexNativeSubagentMonitor,
} from "./native-subagent-monitor.js";
import type { CodexServerNotification, CodexThreadReadResponse, JsonValue } from "./protocol.js";

function createClient(options: { serverVersion?: string } = {}) {
  type ThreadReadParams = { threadId?: string; includeTurns?: boolean };
  type ThreadTurnsParams = { threadId?: string };
  type NotificationHandler = (notification: CodexServerNotification) => Promise<void> | void;
  const notificationHandlers = new Set<NotificationHandler>();
  const requestHandlers = new Set<(request: never) => unknown>();
  const closeHandlers = new Set<() => void>();
  const threadReads = new Map<
    string,
    | CodexThreadReadResponse
    | Error
    | ((params: ThreadReadParams) => CodexThreadReadResponse | Promise<CodexThreadReadResponse>)
  >();
  const threadTurns = new Map<string, JsonValue | Error>();
  const request = vi.fn(async (method: string, params?: unknown) => {
    if (method === "thread/turns/list") {
      const childThreadId = ((params as ThreadTurnsParams | undefined) ?? {}).threadId ?? "";
      const response = threadTurns.get(childThreadId);
      if (response instanceof Error) {
        throw response;
      }
      if (response === undefined) {
        throw new Error(`thread turns not loaded: ${childThreadId}`);
      }
      return response;
    }
    if (method !== "thread/read") {
      throw new Error(`unexpected request: ${method}`);
    }
    const readParams = (params as ThreadReadParams | undefined) ?? {};
    const childThreadId = readParams.threadId ?? "";
    const response = threadReads.get(childThreadId);
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error(`thread not loaded: ${childThreadId}`);
    }
    return typeof response === "function" ? await response(readParams) : response;
  });
  return {
    request,
    getServerVersion: () => options.serverVersion ?? "0.139.0",
    setThreadRead(childThreadId: string, response: CodexThreadReadResponse | Error) {
      threadReads.set(childThreadId, response);
    },
    setThreadReadFactory(
      childThreadId: string,
      response: (
        params: ThreadReadParams,
      ) => CodexThreadReadResponse | Promise<CodexThreadReadResponse>,
    ) {
      threadReads.set(childThreadId, response);
    },
    setThreadTurns(childThreadId: string, response: JsonValue | Error) {
      threadTurns.set(childThreadId, response);
    },
    addNotificationHandler(handler: NotificationHandler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    addRequestHandler(handler: (request: never) => unknown) {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    },
    addCloseHandler(handler: (client: never) => void) {
      const closeHandler = () => handler(undefined as never);
      closeHandlers.add(closeHandler);
      return () => closeHandlers.delete(closeHandler);
    },
    async notify(notification: CodexServerNotification) {
      await Promise.all(
        [...notificationHandlers].map(async (handler) => await handler(notification)),
      );
    },
    close() {
      for (const handler of closeHandlers) {
        handler();
      }
    },
  };
}

function createRuntime() {
  type DeliveryResult = {
    delivered: boolean;
    path: "direct" | "steered" | "none";
    error?: string;
  };
  const createRunningTaskRun = vi.fn(
    (params): AgentHarnessTaskRecord => ({
      taskId: params.sourceId ?? params.runId,
      runtime: "subagent",
      taskKind: "codex-native",
      sourceId: params.sourceId,
      requesterSessionKey: "agent:main:main",
      ownerKey: "agent:main:main",
      scopeKind: "session",
      agentId: params.agentId,
      runId: params.runId,
      label: params.label,
      task: params.task,
      status: "running",
      deliveryStatus: params.deliveryStatus ?? "not_applicable",
      notifyPolicy: params.notifyPolicy ?? "silent",
      createdAt: params.startedAt ?? Date.now(),
      startedAt: params.startedAt,
      lastEventAt: params.lastEventAt,
      progressSummary: params.progressSummary,
    }),
  );
  const taskRuntime = {
    createRunningTaskRun,
    tryCreateRunningTaskRun: vi.fn((params) => createRunningTaskRun(params)),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn(() => []),
    listTaskRecords: vi.fn((): AgentHarnessTaskRecord[] => []),
    setDetachedTaskDeliveryStatusByRunId: vi.fn(
      (_params: AgentHarnessScopedSetDeliveryStatusParams): AgentHarnessTaskRecord[] => [],
    ),
  };
  return {
    ...taskRuntime,
    createAgentHarnessTaskRuntime: vi.fn(() => taskRuntime),
    deliverAgentHarnessTaskCompletion: vi.fn(
      async (): Promise<DeliveryResult> => ({ delivered: true, path: "direct" }),
    ),
  };
}

function createTaskScope(requesterSessionKey = "agent:main:discord:channel:C123") {
  return { requesterSessionKey } as AgentHarnessTaskRuntimeScope;
}

function registerParent(
  monitor: CodexNativeSubagentMonitor,
  parentThreadId = "parent-thread",
  requesterSessionKey = "agent:main:discord:channel:C123",
) {
  return monitor.registerParent({
    parentThreadId,
    requesterSessionKey,
    taskRuntimeScope: createTaskScope(requesterSessionKey),
    agentId: "main",
  });
}

async function notifyChildStarted(
  client: ReturnType<typeof createClient>,
  parentThreadId = "parent-thread",
  childThreadId = "child-thread",
  agentPath = childThreadId,
): Promise<CodexServerNotification> {
  const notification: CodexServerNotification = {
    method: "thread/started",
    params: {
      thread: {
        id: childThreadId,
        preview: "inspect the repo",
        source: {
          subAgent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              depth: 1,
              agent_path: agentPath,
            },
          },
        },
      },
    },
  };
  await client.notify(notification);
  return notification;
}

function nativeCompletionNotification(
  params: {
    agentPath?: string;
    statusLabel?: string;
    result?: string | null;
    parentThreadId?: string;
  } = {},
): CodexServerNotification {
  const agentPath = params.agentPath ?? "child-thread";
  const statusLabel = params.statusLabel ?? "completed";
  const result = params.result === undefined ? "child final result" : params.result;
  const statusValue = result === null ? "null" : JSON.stringify(result);
  const content =
    `<subagent_notification>{"agent_path":${JSON.stringify(agentPath)},"status":{` +
    `${JSON.stringify(statusLabel)}:${statusValue}}}</subagent_notification>`;
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: params.parentThreadId ?? "parent-thread",
      item: {
        type: "message",
        role: "assistant",
        phase: "commentary",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              author: agentPath,
              recipient: "/root",
              other_recipients: [],
              content,
              trigger_turn: false,
            }),
          },
        ],
      },
    },
  };
}

function threadRead(
  params: {
    childThreadId?: string;
    parentThreadId?: string;
    status?: "completed" | "failed" | "interrupted" | "inProgress";
    result?: string;
    error?: string;
    completedAt?: number;
    directParentField?: boolean;
    previousResult?: string;
    resultPhase?: "commentary" | "final_answer";
    trailingCommentary?: string;
    threadStatus?: "active" | "idle" | "notLoaded" | "systemError";
  } = {},
): CodexThreadReadResponse {
  const childThreadId = params.childThreadId ?? "child-thread";
  const parentThreadId = params.parentThreadId ?? "parent-thread";
  const status = params.status ?? "completed";
  const items: JsonValue[] = [
    ...(params.result
      ? [
          {
            id: "message-1",
            type: "agentMessage",
            text: params.result,
            ...(params.resultPhase ? { phase: params.resultPhase } : {}),
          },
        ]
      : []),
    ...(params.trailingCommentary
      ? [
          {
            id: "message-commentary",
            type: "agentMessage",
            text: params.trailingCommentary,
            phase: "commentary",
          },
        ]
      : []),
  ];
  return {
    thread: {
      id: childThreadId,
      ...(params.directParentField ? { parentThreadId } : {}),
      source: {
        subAgent: {
          thread_spawn: { parent_thread_id: parentThreadId, depth: 1 },
        },
      },
      status: { type: params.threadStatus ?? "idle" },
      turns: [
        ...(params.previousResult
          ? [
              {
                id: "turn-previous",
                status: "completed",
                items: [
                  { id: "message-previous", type: "agentMessage", text: params.previousResult },
                ],
                completedAt: 1_779_000_000,
              },
            ]
          : []),
        {
          id: "turn-1",
          status,
          items,
          error: params.error ? { message: params.error } : null,
          completedAt: params.completedAt ?? 1_779_063_288,
        },
      ],
    },
  } as unknown as CodexThreadReadResponse;
}

function taskRecord(params: {
  childThreadId: string;
  requesterSessionKey?: string;
  status?: AgentHarnessTaskRecord["status"];
  deliveryStatus?: AgentHarnessTaskRecord["deliveryStatus"];
  endedAt?: number;
}): AgentHarnessTaskRecord {
  const requesterSessionKey = params.requesterSessionKey ?? "agent:main:discord:channel:C123";
  return {
    taskId: `task-${params.childThreadId}`,
    runtime: "subagent",
    taskKind: "codex-native",
    requesterSessionKey,
    ownerKey: requesterSessionKey,
    scopeKind: "session",
    runId: `codex-thread:${params.childThreadId}`,
    task: "check the weather",
    status: params.status ?? "running",
    deliveryStatus: params.deliveryStatus ?? "not_applicable",
    notifyPolicy: "silent",
    createdAt: Date.now(),
    endedAt: params.endedAt,
  };
}

describe("CodexNativeSubagentMonitor", () => {
  it("keeps native subagent task mirroring on the shared client", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);

    await notifyChildStarted(client);
    await client.notify({
      method: "thread/status/changed",
      params: { threadId: "child-thread", status: { type: "idle" } },
    });

    expect(runtime.createRunningTaskRun).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        task: "inspect the repo",
      }),
    );
    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        progressSummary: "Codex native subagent is idle.",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
  });

  it("keeps collab completion as progress while app-server recovery is authoritative", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor, "parent-thread", "agent:main:main");

    await notifyChildStarted(client, "parent-thread", "child-thread", "");
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "parent-thread",
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          senderThreadId: "parent-thread",
          agentsStates: {
            "child-thread": {
              status: "completed",
              message: "child final result",
            },
          },
        },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        progressSummary: "child final result",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    monitor.dispose();
  });

  it("does not complete mirrored task rows from idle status before native completion", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();

    await client.notify(
      nativeCompletionNotification({
        agentPath: "child-thread",
        statusLabel: "completed",
        result: "child final result",
      }),
    );

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        status: "succeeded",
        terminalSummary: "child final result",
      }),
    );
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        result: "child final result",
      }),
    );
  });

  it("delivers a completed child turn with its final agent message", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify({
      method: "item/started",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: {
          type: "agentMessage",
          id: "msg-child-final",
          phase: "final_answer",
          text: "",
        },
      },
    });
    await client.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        itemId: "msg-child-final",
        delta: "child ",
      },
    });
    await client.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        itemId: "msg-child-final",
        delta: "final result",
      },
    });

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();

    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    await client.notify(childTurnCompletedNotification({ status: "completed" }));

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        status: "succeeded",
        terminalSummary: "child final result",
      }),
    );
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        status: "succeeded",
        statusLabel: "turn_completed",
        result: "child final result",
      }),
    );

    client.close();
  });

  it("does not deliver a commentary delta when the completion snapshot is absent", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify({
      method: "item/started",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: {
          type: "agentMessage",
          id: "msg-child-commentary",
          phase: "commentary",
          text: "",
        },
      },
    });
    await client.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        itemId: "msg-child-commentary",
        delta: "checking now",
      },
    });
    await client.notify(childTurnCompletedNotification({ status: "completed" }));

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        result: "Codex native subagent completed without a final assistant message.",
      }),
    );

    client.close();
  });

  it("does not complete commentary-only child messages before a terminal turn", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify({
      method: "item/agentMessage/delta",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        itemId: "msg-child-commentary",
        delta: "checking now",
      },
    });
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: {
          type: "agentMessage",
          id: "msg-child-commentary",
          phase: "commentary",
          text: "checking now",
        },
      },
    });
    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).not.toHaveBeenCalled();
    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();

    await client.notify(childTurnCompletedNotification({ status: "completed" }));

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        result: "Codex native subagent completed without a final assistant message.",
      }),
    );

    client.close();
  });

  it("delivers a completed child turn with its snapshot-only final message", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify(
      childTurnCompletedNotification({
        status: "completed",
        items: [
          {
            id: "msg-child-snapshot",
            type: "agentMessage",
            phase: "final_answer",
            text: "snapshot final result",
          },
        ],
      }),
    );

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        result: "snapshot final result",
      }),
    );

    client.close();
  });

  it("reconciles transcript text for a completed child turn without a final message", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-subagent-"));
    const codexHome = path.join(tempDir, "codex-home");
    const transcriptDir = path.join(codexHome, "sessions", "2026", "06", "09");
    await fs.mkdir(transcriptDir, { recursive: true });
    await fs.writeFile(
      path.join(transcriptDir, "rollout-2026-06-09T10-11-12-child-thread.jsonl"),
      [
        JSON.stringify({
          type: "session_meta",
          payload: {
            source: {
              subagent: {
                thread_spawn: {
                  parent_thread_id: "parent-thread",
                  depth: 1,
                },
              },
            },
          },
        }),
        JSON.stringify({
          timestamp: "2026-06-09T10:12:00.000Z",
          type: "event_msg",
          payload: {
            type: "task_complete",
            last_agent_message: "child turn transcript result",
            completed_at: 1781009520,
          },
        }),
        "",
      ].join("\n"),
    );
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client, runtime, {
      codexHome,
      transcriptPollDelaysMs: [60_000],
    });
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify(childTurnCompletedNotification({ status: "completed" }));

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        statusLabel: "task_complete",
        result: "child turn transcript result",
      }),
    );

    client.close();
  });

  it("does not reuse an interrupted child turn's message after resuming", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify({
      method: "item/completed",
      params: {
        threadId: "child-thread",
        turnId: "child-turn",
        item: {
          type: "agentMessage",
          id: "msg-child-partial",
          text: "partial child result",
        },
      },
    });
    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });
    await client.notify(childTurnCompletedNotification({ status: "interrupted" }));

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();

    await client.notify(
      childTurnCompletedNotification({ status: "completed", turnId: "resumed-child-turn" }),
    );

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        status: "succeeded",
        result: "Codex native subagent completed without a final assistant message.",
      }),
    );

    client.close();
  });

  it("keeps late idle lifecycle updates from overwriting native completion results", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify(
      nativeCompletionNotification({
        agentPath: "child-thread",
        statusLabel: "completed",
        result: "child final result",
      }),
    );
    runtime.recordTaskRunProgressByRunId.mockClear();

    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "idle" },
      },
    });

    expect(runtime.recordTaskRunProgressByRunId).not.toHaveBeenCalled();
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        status: "succeeded",
        terminalSummary: "child final result",
      }),
    );
  });

  it("keeps later lifecycle errors from rewriting native completion results", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    monitor.registerParent({
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:discord:channel:C123",
      taskRuntimeScope: createTaskScope(),
      agentId: "main",
    });

    await notifyChildStarted(client);
    await client.notify(
      nativeCompletionNotification({
        agentPath: "child-thread",
        statusLabel: "completed",
        result: "child final result",
      }),
    );

    await client.notify({
      method: "thread/status/changed",
      params: {
        threadId: "child-thread",
        status: { type: "systemError" },
      },
    });

    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledTimes(1);
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "codex-thread:child-thread",
        status: "succeeded",
        terminalSummary: "child final result",
      }),
    );
    client.close();
  });

  it("delivers notification results without reading thread history", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    const completion = nativeCompletionNotification();
    await client.notify(completion);

    expect(client.request).not.toHaveBeenCalled();
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        childSessionId: "child-thread",
        status: "succeeded",
        statusLabel: "completed",
        result: "child final result",
      }),
    );
    client.close();
  });

  it("recovers a missing final message through thread/read", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({ result: "history final result", directParentField: true }),
    );
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await client.notify(nativeCompletionNotification({ result: null }));

    expect(client.request).toHaveBeenCalledWith(
      "thread/read",
      { threadId: "child-thread", includeTurns: true },
      { timeoutMs: 30_000 },
    );
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        result: "history final result",
        statusLabel: "task_complete",
      }),
    );
    expect(runtime.finalizeTaskRunByRunId).toHaveBeenCalledWith(
      expect.objectContaining({ endedAt: 1_779_063_288_000 }),
    );
    client.close();
  });

  it("falls back to a typed no-final completion when history stays unavailable", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await client.notify(nativeCompletionNotification({ result: null }));
      await vi.advanceTimersByTimeAsync(20);

      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          statusLabel: "completed_without_final_message",
          result: "Codex native subagent completed without a final assistant message.",
        }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a typed no-final fallback across completed history reads", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      client.setThreadRead("child-thread", threadRead({ status: "completed" }));
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await client.notify(nativeCompletionNotification({ result: null }));
      await vi.advanceTimersByTimeAsync(20);

      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ statusLabel: "completed_without_final_message" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers failed child turns and their app-server error", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({
        status: "failed",
        error: "child exploded",
      }),
    );
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", result: "child exploded" }),
    );
    client.close();
  });

  it("does not recover an older result while the newest child turn is active", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({ status: "inProgress", previousResult: "stale result" }),
    );
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it("does not recover persisted completion while the child thread is active", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({
        threadStatus: "active",
        status: "completed",
        result: "stale persisted result",
      }),
    );
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it("does not replay stale history while a system-error child still has an active turn", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({
        threadStatus: "systemError",
        status: "failed",
        error: "stale persisted failure",
      }),
    );
    client.setThreadTurns("child-thread", {
      data: [{ id: "current-turn", status: "inProgress", items: [] }],
    });
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(false);

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it("recovers the authoritative latest failed turn after a system error", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({
        threadStatus: "systemError",
        status: "completed",
        result: "stale persisted result",
      }),
    );
    client.setThreadTurns("child-thread", {
      data: [
        {
          id: "current-turn",
          status: "failed",
          items: [],
          error: { message: "current child failure" },
        },
      ],
    });
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ status: "failed", result: "current child failure" }),
    );
    client.close();
  });

  it("delivers a bounded system-error fallback on older supported app-servers", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient({ serverVersion: "0.125.0" });
      client.setThreadRead(
        "child-thread",
        threadRead({
          threadStatus: "systemError",
          status: "failed",
          error: "possibly stale failure",
        }),
      );
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
        retainClient: () => releaseClient,
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "systemError" } },
      });
      await vi.advanceTimersByTimeAsync(0);

      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        expect.objectContaining({ threadId: "child-thread" }),
        expect.anything(),
      );
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(20);

      expect(client.request).not.toHaveBeenCalledWith(
        "thread/turns/list",
        expect.anything(),
        expect.anything(),
      );
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          result: "Codex app-server reported a system error for the native subagent thread.",
        }),
      );
      expect(releaseClient).toHaveBeenCalledTimes(1);
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels an older-server system-error fallback when recovery sees an active child", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient({ serverVersion: "0.125.0" });
      client.setThreadRead(
        "child-thread",
        threadRead({ threadStatus: "systemError", status: "failed" }),
      );
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
        retainClient: () => releaseClient,
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "systemError" } },
      });
      await vi.advanceTimersByTimeAsync(0);

      client.setThreadRead(
        "child-thread",
        threadRead({ threadStatus: "active", status: "inProgress" }),
      );
      await vi.advanceTimersByTimeAsync(30);

      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(releaseClient).not.toHaveBeenCalled();
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not re-arm an older-server fallback from a stale system-error read", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient({ serverVersion: "0.125.0" });
      let resolveStaleRead!: (value: CodexThreadReadResponse) => void;
      const staleRead = new Promise<CodexThreadReadResponse>((resolve) => {
        resolveStaleRead = resolve;
      });
      let readCount = 0;
      client.setThreadReadFactory("child-thread", async () => {
        readCount += 1;
        return readCount === 1
          ? await staleRead
          : threadRead({ threadStatus: "active", status: "inProgress" });
      });
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
        retainClient: () => releaseClient,
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "systemError" } },
      });
      await Promise.resolve();
      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        expect.objectContaining({ threadId: "child-thread" }),
        expect.anything(),
      );

      await client.notify({
        method: "thread/status/changed",
        params: { threadId: "child-thread", status: { type: "active", activeFlags: [] } },
      });
      resolveStaleRead(
        threadRead({ threadStatus: "systemError", status: "failed", error: "stale failure" }),
      );
      await vi.advanceTimersByTimeAsync(30);

      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(releaseClient).not.toHaveBeenCalled();
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers the final answer instead of later commentary", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({
        result: "child final result",
        resultPhase: "final_answer",
        trailingCommentary: "post-final progress noise",
      }),
    );
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client);

    await expect(monitor.reconcileChildThread("child-thread")).resolves.toBe(true);

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ result: "child final result" }),
    );
    client.close();
  });

  it("maps Codex agent_path completion notifications to child thread ids", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await notifyChildStarted(client, "parent-thread", "child-thread", "1.2");

    await client.notify(nativeCompletionNotification({ agentPath: "1.2" }));

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "child-thread" }),
    );
    client.close();
  });

  it("ignores completion text for an unregistered child", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);

    await client.notify(nativeCompletionNotification({ agentPath: "unknown-child" }));

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it("does not let a second parent adopt an existing child thread", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor, "parent-a", "agent:main:a");
    registerParent(monitor, "parent-b", "agent:main:b");
    await notifyChildStarted(client, "parent-a", "child-thread");
    await notifyChildStarted(client, "parent-b", "child-thread");

    await client.notify(
      nativeCompletionNotification({
        parentThreadId: "parent-b",
        agentPath: "child-thread",
      }),
    );
    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();

    await client.notify(
      nativeCompletionNotification({
        parentThreadId: "parent-a",
        agentPath: "child-thread",
      }),
    );
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("retries terminal delivery after releasing and closing the physical client", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      runtime.deliverAgentHarnessTaskCompletion
        .mockResolvedValueOnce({ delivered: false, path: "direct", error: "pending" })
        .mockResolvedValueOnce({ delivered: true, path: "direct" });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        retainClient: () => releaseClient,
      });
      registerParent(monitor);
      await notifyChildStarted(client);
      await client.notify(nativeCompletionNotification());
      expect(releaseClient).toHaveBeenCalledTimes(1);
      client.close();

      await vi.advanceTimersByTimeAsync(10);

      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(2);
      expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith(
        expect.objectContaining({ deliveryStatus: "delivered" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps one terminal delivery owner across physical client replacement", async () => {
    vi.useFakeTimers();
    try {
      const firstClient = createClient();
      const replacementClient = createClient();
      let resolveReadStarted!: () => void;
      const readStarted = new Promise<void>((resolve) => {
        resolveReadStarted = resolve;
      });
      replacementClient.setThreadReadFactory("child-thread", () => {
        resolveReadStarted();
        return threadRead({ result: "child final result" });
      });
      const runtime = createRuntime();
      let recordsVisible = false;
      let task = taskRecord({
        childThreadId: "child-thread",
        status: "succeeded",
        deliveryStatus: "not_applicable",
        endedAt: Date.now(),
      });
      runtime.listTaskRecords.mockImplementation(() => (recordsVisible ? [task] : []));
      runtime.setDetachedTaskDeliveryStatusByRunId.mockImplementation((params) => {
        task = { ...task, deliveryStatus: params.deliveryStatus };
        return [task];
      });
      runtime.deliverAgentHarnessTaskCompletion
        .mockResolvedValueOnce({ delivered: false, path: "direct", error: "pending" })
        .mockResolvedValueOnce({ delivered: true, path: "direct" });
      const firstMonitor = new CodexNativeSubagentMonitor(firstClient as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
      });
      registerParent(firstMonitor);
      await notifyChildStarted(firstClient);
      await firstClient.notify(nativeCompletionNotification());
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);

      recordsVisible = true;
      firstClient.close();
      const replacementMonitor = new CodexNativeSubagentMonitor(
        replacementClient as never,
        runtime,
      );
      registerParent(replacementMonitor);
      await readStarted;
      await vi.advanceTimersByTimeAsync(0);

      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(10);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(2);
      replacementClient.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds permanently non-durable completion retries", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const releaseClient = vi.fn();
      runtime.deliverAgentHarnessTaskCompletion.mockResolvedValue({
        delivered: false,
        path: "direct",
        error: "pending",
      });
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        completionDeliveryRetryDelaysMs: [10],
        completionDeliveryMaxAttempts: 2,
        retainClient: () => releaseClient,
      });
      registerParent(monitor);
      await notifyChildStarted(client);
      await client.notify(nativeCompletionNotification());

      expect(releaseClient).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(100);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(3);
      expect(runtime.setDetachedTaskDeliveryStatusByRunId).toHaveBeenLastCalledWith(
        expect.objectContaining({ deliveryStatus: "pending", error: "pending" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retains the physical client until detached child delivery finishes", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const releaseClient = vi.fn();
    const retainClient = vi.fn(() => releaseClient);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      retainClient,
      recoveryPollDelaysMs: [],
    });
    registerParent(monitor);

    await notifyChildStarted(client);
    expect(retainClient).toHaveBeenCalledTimes(1);
    expect(releaseClient).not.toHaveBeenCalled();

    await client.notify(nativeCompletionNotification());
    expect(releaseClient).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("releases the physical client only after every child is terminal", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const releaseClient = vi.fn();
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      retainClient: () => releaseClient,
      recoveryPollDelaysMs: [],
    });
    registerParent(monitor);
    await notifyChildStarted(client, "parent-thread", "child-a");
    await notifyChildStarted(client, "parent-thread", "child-b");

    await client.notify(nativeCompletionNotification({ agentPath: "child-a" }));
    expect(releaseClient).not.toHaveBeenCalled();
    await client.notify(nativeCompletionNotification({ agentPath: "child-b" }));
    expect(releaseClient).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("rejects a second requester for the same parent thread", () => {
    const client = createClient();
    const monitor = new CodexNativeSubagentMonitor(client as never, createRuntime());
    registerParent(monitor, "shared-parent", "agent:main:first");

    expect(() => registerParent(monitor, "shared-parent", "agent:main:second")).toThrow(
      "already bound to another session",
    );
    client.close();
  });

  it("reconciles only task rows owned by the registered requester", async () => {
    const client = createClient();
    client.setThreadRead(
      "owned-child",
      threadRead({ childThreadId: "owned-child", result: "owned result" }),
    );
    client.setThreadRead(
      "foreign-child",
      threadRead({ childThreadId: "foreign-child", result: "foreign result" }),
    );
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([
      taskRecord({ childThreadId: "owned-child" }),
      taskRecord({ childThreadId: "foreign-child", requesterSessionKey: "agent:main:other" }),
    ]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor);
    await vi.waitFor(() =>
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1),
    );

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "thread/read",
      expect.objectContaining({ threadId: "owned-child" }),
      expect.any(Object),
    );
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({ childSessionId: "owned-child", result: "owned result" }),
    );
    client.close();
  });

  it("scopes registration recovery to that parent instead of rescanning the client", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-a",
      threadRead({ parentThreadId: "parent-a", childThreadId: "child-a", result: "result a" }),
    );
    client.setThreadRead(
      "child-b",
      threadRead({ parentThreadId: "parent-b", childThreadId: "child-b", result: "result b" }),
    );
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([
      taskRecord({ childThreadId: "child-a", requesterSessionKey: "requester-a" }),
      taskRecord({ childThreadId: "child-b", requesterSessionKey: "requester-b" }),
    ]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    monitor.registerParent({
      parentThreadId: "parent-a",
      requesterSessionKey: "requester-a",
      taskRuntimeScope: createTaskScope("requester-a"),
      agentId: "main",
    });
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));

    expect(runtime.listTaskRecords).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "thread/read",
      expect.objectContaining({ threadId: "child-a" }),
      expect.any(Object),
    );
    client.close();
  });

  it("single-flights detached task-row recovery across registrations", async () => {
    const client = createClient();
    let releaseRead!: () => void;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    client.setThreadReadFactory("child-thread", async () => {
      await readGate;
      return threadRead({ result: "single result" });
    });
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([taskRecord({ childThreadId: "child-thread" })]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    const first = registerParent(monitor);
    const second = registerParent(monitor);
    expect(client.request).toHaveBeenCalledTimes(1);
    releaseRead();
    await vi.waitFor(() =>
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1),
    );

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
    first.unregister();
    second.unregister();
    client.close();
  });

  it("discards stale task-row history when the child becomes active during the read", async () => {
    const client = createClient({ serverVersion: "0.125.0" });
    let resolveRead!: (value: CodexThreadReadResponse) => void;
    const pendingRead = new Promise<CodexThreadReadResponse>((resolve) => {
      resolveRead = resolve;
    });
    client.setThreadReadFactory("child-thread", async () => await pendingRead);
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([taskRecord({ childThreadId: "child-thread" })]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      recoveryPollDelaysMs: [],
    });
    registerParent(monitor);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));

    await notifyChildStarted(client);
    await client.notify({
      method: "thread/status/changed",
      params: { threadId: "child-thread", status: { type: "active", activeFlags: [] } },
    });
    resolveRead(threadRead({ result: "stale completed result" }));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it("uses metadata lineage until task-row history is materialized", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const metadata = threadRead();
      metadata.thread.turns = [];
      let fullReadCount = 0;
      client.setThreadReadFactory("child-thread", (params) => {
        if (params.includeTurns === false) {
          return metadata;
        }
        fullReadCount += 1;
        if (fullReadCount === 1) {
          throw new Error("history is not materialized");
        }
        return threadRead({ result: "eventual history result" });
      });
      const runtime = createRuntime();
      runtime.listTaskRecords.mockReturnValue([taskRecord({ childThreadId: "child-thread" })]);
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      registerParent(monitor);
      await vi.advanceTimersByTimeAsync(0);
      expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
      expect(client.request).toHaveBeenCalledWith(
        "thread/read",
        { threadId: "child-thread", includeTurns: false },
        { timeoutMs: 30_000 },
      );

      await vi.advanceTimersByTimeAsync(10);

      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ result: "eventual history result" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("recovers same-requester task rows from an authoritative old parent", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({ parentThreadId: "old-parent", result: "old parent result" }),
    );
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([taskRecord({ childThreadId: "child-thread" })]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor, "current-parent");
    await vi.waitFor(() =>
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1),
    );

    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
      expect.objectContaining({
        announceId: "codex-native:old-parent:child-thread:succeeded",
        result: "old parent result",
      }),
    );
    client.close();
  });

  it("rejects task-row recovery through a foreign requester's parent", async () => {
    const client = createClient();
    client.setThreadRead(
      "child-thread",
      threadRead({ parentThreadId: "foreign-parent", result: "foreign parent result" }),
    );
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([taskRecord({ childThreadId: "child-thread" })]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime);
    registerParent(monitor, "current-parent", "agent:main:discord:channel:C123");
    registerParent(monitor, "foreign-parent", "agent:main:other");
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(runtime.deliverAgentHarnessTaskCompletion).not.toHaveBeenCalled();
    client.close();
  });

  it("does not keep old terminal task rows forever-recent", async () => {
    const client = createClient();
    client.setThreadRead(
      "recent-child",
      threadRead({ childThreadId: "recent-child", result: "recent result" }),
    );
    const runtime = createRuntime();
    runtime.listTaskRecords.mockReturnValue([
      taskRecord({ childThreadId: "old-child", status: "succeeded", endedAt: 1 }),
      taskRecord({ childThreadId: "recent-child", status: "succeeded", endedAt: 100_000 }),
    ]);
    const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
      now: () => 100_000,
    });
    registerParent(monitor);
    await vi.waitFor(() => expect(client.request).toHaveBeenCalledTimes(1));

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith(
      "thread/read",
      expect.objectContaining({ threadId: "recent-child" }),
      expect.any(Object),
    );
    client.close();
  });

  it("uses a per-child recovery timer and stops after terminal recovery", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      let readCount = 0;
      client.setThreadReadFactory("child-thread", () => {
        readCount += 1;
        return threadRead({
          status: readCount === 1 ? "inProgress" : "completed",
          result: readCount === 1 ? undefined : "eventual result",
        });
      });
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(10);
      await vi.advanceTimersByTimeAsync(100);

      expect(client.request).toHaveBeenCalledTimes(2);
      expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledWith(
        expect.objectContaining({ result: "eventual result" }),
      );
      client.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ref-counts shared parent registrations", async () => {
    const client = createClient();
    const runtime = createRuntime();
    const first = registerCodexNativeSubagentMonitor({
      client: client as never,
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      taskRuntimeScope: createTaskScope("agent:main:main"),
      runtime,
    });
    const second = registerCodexNativeSubagentMonitor({
      client: client as never,
      parentThreadId: "parent-thread",
      requesterSessionKey: "agent:main:main",
      taskRuntimeScope: createTaskScope("agent:main:main"),
      runtime,
    });
    first.unregister();
    await notifyChildStarted(client);
    await client.notify(nativeCompletionNotification());

    expect(runtime.createRunningTaskRun).toHaveBeenCalledTimes(1);
    expect(runtime.deliverAgentHarnessTaskCompletion).toHaveBeenCalledTimes(1);
    second.unregister();
    await notifyChildStarted(client, "parent-thread", "late-child");
    expect(runtime.createRunningTaskRun).toHaveBeenCalledTimes(1);
    client.close();
  });

  it("clears child recovery timers when the app-server client closes", async () => {
    vi.useFakeTimers();
    try {
      const client = createClient();
      const runtime = createRuntime();
      const monitor = new CodexNativeSubagentMonitor(client as never, runtime, {
        recoveryPollDelaysMs: [10],
      });
      registerParent(monitor);
      await notifyChildStarted(client);

      client.close();
      await vi.advanceTimersByTimeAsync(30);

      expect(client.request).not.toHaveBeenCalled();
      monitor.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
