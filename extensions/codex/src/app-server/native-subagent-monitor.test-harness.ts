import type {
  AgentHarnessScopedSetDeliveryStatusParams,
  AgentHarnessTaskRecord,
  AgentHarnessTaskRuntime,
  AgentHarnessTaskRuntimeScope,
} from "openclaw/plugin-sdk/agent-harness-task-runtime";
import { onTestFinished, vi } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { createCodexNativeSubagentHistoryOwner } from "./native-subagent-history-owner.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type {
  CodexAppServerRequestResult,
  CodexServerNotification,
  JsonObject,
  JsonValue,
} from "./protocol.js";
// Codex tests cover native subagent monitor plugin behavior.

export type CodexThreadReadResponse = CodexAppServerRequestResult<"thread/read">;
type DirectSpawnVersion = "v1" | "v2";

export function directSpawnItem(
  version: DirectSpawnVersion,
  parentThreadId: string,
  childThreadId: string,
): JsonObject {
  return version === "v1"
    ? {
        type: "collabAgentToolCall" as const,
        tool: "spawnAgent" as const,
        status: "completed" as const,
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
      }
    : {
        type: "subAgentActivity" as const,
        kind: "started" as const,
        agentThreadId: childThreadId,
        agentPath: `/root/${childThreadId}`,
      };
}

export const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;
export const registerCodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.register;
type CodexNativeSubagentMonitorInstance = InstanceType<typeof CodexNativeSubagentMonitor>;

export function createClient() {
  type ThreadReadParams = { threadId?: string; includeTurns?: boolean };
  type ThreadTurnsParams = { threadId?: string };
  const threadReads = new Map<
    string,
    | CodexThreadReadResponse
    | Error
    | ((params: ThreadReadParams) => CodexThreadReadResponse | Promise<CodexThreadReadResponse>)
  >();
  const threadTurns = new Map<string, JsonValue | Error>();
  const fixture = createFakeCodexAppServerClient(async (method: string, params?: unknown) => {
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
  onTestFinished(async () => {
    fixture.close();
    await Promise.resolve();
  });
  return {
    request: fixture.request,
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
    addNotificationHandler: fixture.client.addNotificationHandler.bind(fixture.client),
    addRequestHandler: fixture.client.addRequestHandler.bind(fixture.client),
    addCloseHandler: fixture.client.addCloseHandler.bind(fixture.client),
    getTransportPid: fixture.client.getTransportPid.bind(fixture.client),
    notify: (notification: CodexServerNotification) => fixture.notify(notification),
    close: () => fixture.close(),
  };
}

export function createRuntime() {
  type DeliveryResult = {
    delivered: boolean;
    path: "direct" | "steered" | "none";
    error?: string;
    recoveryPending?: true;
    recoveryBlocked?: true;
  };
  const createRunningTaskRun = vi.fn((params): AgentHarnessTaskRecord => ({
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
  }));
  const taskRuntime = {
    createRunningTaskRun,
    tryCreateRunningTaskRun: vi.fn((params) => createRunningTaskRun(params)),
    recordTaskRunProgressByRunId: vi.fn(() => []),
    finalizeTaskRunByRunId: vi.fn<AgentHarnessTaskRuntime["finalizeTaskRunByRunId"]>((params) => [
      {
        ...taskRecord({
          childThreadId: params.runId.slice("codex-thread:".length),
          status: params.status,
          endedAt: params.endedAt,
        }),
        runId: params.runId,
      },
    ]),
    listTaskRecords: vi.fn((): AgentHarnessTaskRecord[] => []),
    setDetachedTaskDeliveryStatusByRunId: vi.fn(
      (params: AgentHarnessScopedSetDeliveryStatusParams): AgentHarnessTaskRecord[] => [
        {
          ...taskRecord({
            childThreadId: params.runId.slice("codex-thread:".length),
            status: "succeeded",
          }),
          ...params,
        },
      ],
    ),
  };
  return {
    ...taskRuntime,
    createAgentHarnessTaskRuntime: vi.fn(() => taskRuntime),
    deliverAgentHarnessTaskCompletion: vi.fn(async (): Promise<DeliveryResult> => ({
      delivered: true,
      path: "direct",
    })),
  };
}

export function createTaskScope(requesterSessionKey = "agent:main:discord:channel:C123") {
  return { requesterSessionKey } as AgentHarnessTaskRuntimeScope;
}

function nativeHistoryOwner(parentThreadId = "parent-thread") {
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId,
    sessionId: "physical-1",
    lifecycleRevision: "revision-1",
    binding: {
      threadId: parentThreadId,
      cwd: "/workspace",
      appServerRuntimeFingerprint: "connection-A",
    },
  });
  if (!owner) {
    throw new Error("expected a production native history owner");
  }
  return owner;
}

export function registerParent(
  monitor: CodexNativeSubagentMonitorInstance,
  parentThreadId = "parent-thread",
  requesterSessionKey = "agent:main:discord:channel:C123",
) {
  return monitor.registerParent({
    parentThreadId,
    requesterSessionKey,
    taskRuntimeScope: createTaskScope(requesterSessionKey),
    agentId: "main",
    historyOwner: nativeHistoryOwner(parentThreadId),
  });
}

export async function notifyChildStarted(
  client: ReturnType<typeof createClient>,
  parentThreadId = "parent-thread",
  childThreadId = "child-thread",
  agentPath = childThreadId,
  options: { directParentField?: boolean } = {},
): Promise<CodexServerNotification> {
  const notification: CodexServerNotification = {
    method: "thread/started",
    params: {
      thread: {
        id: childThreadId,
        ...(options.directParentField === false ? {} : { parentThreadId }),
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

export async function registerDetachedChild(
  client: ReturnType<typeof createClient>,
  monitor: CodexNativeSubagentMonitorInstance,
): Promise<void> {
  const owner = registerParent(monitor);
  await notifyChildStarted(client);
  owner.unregister();
}

export function nativeCompletionNotification(
  params: {
    agentPath?: string;
    statusLabel?: string;
    result?: string | null;
    parentThreadId?: string;
    turnId?: string;
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
      ...(params.turnId ? { turnId: params.turnId } : {}),
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

export function closeAgentNotification(params: {
  method: "item/started" | "item/completed";
  childThreadId?: string;
  previousStatus?: "completed" | "running";
}): CodexServerNotification {
  const childThreadId = params.childThreadId ?? "child-thread";
  return {
    method: params.method,
    params: {
      threadId: "parent-thread",
      item: {
        type: "collabAgentToolCall",
        tool: "closeAgent",
        status: params.method === "item/started" ? "inProgress" : "completed",
        senderThreadId: "parent-thread",
        receiverThreadIds: [childThreadId],
        agentsStates:
          params.method === "item/completed"
            ? { [childThreadId]: { status: params.previousStatus ?? "completed" } }
            : {},
      },
    },
  };
}

export function childTurnCompletedNotification(params: {
  status: "completed" | "failed" | "interrupted";
  error?: string;
  turnId?: string;
  items?: JsonValue[];
}): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: "child-thread",
      turn: {
        id: params.turnId ?? "child-turn",
        status: params.status,
        items: params.items ?? [],
        error: params.error ? { message: params.error } : null,
      },
    },
  };
}

export function threadRead(
  params: {
    childThreadId?: string;
    parentThreadId?: string;
    agentPath?: string;
    status?: "completed" | "failed" | "interrupted" | "inProgress";
    result?: string;
    error?: string;
    completedAt?: number;
    previousResult?: string;
    resultPhase?: "commentary" | "final_answer";
    trailingCommentary?: string;
    threadStatus?: "active" | "idle" | "notLoaded" | "systemError";
    directParentField?: boolean;
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
      ...(params.directParentField === false ? {} : { parentThreadId }),
      source: {
        subAgent: {
          thread_spawn: {
            parent_thread_id: parentThreadId,
            depth: 1,
            ...(params.agentPath ? { agent_path: params.agentPath } : {}),
          },
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

export function taskRecord(params: {
  childThreadId: string;
  parentThreadId?: string;
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
    detail: { nativeHistory: nativeHistoryOwner(params.parentThreadId) },
  };
}
