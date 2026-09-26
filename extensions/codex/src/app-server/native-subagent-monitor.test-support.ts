import type {
  deliverAgentHarnessCompletion,
  captureAgentHarnessCompletionCustody,
  createAgentHarnessCompletionEventSink,
  AgentHarnessCompletionDelivery,
  AgentHarnessCompletionScope,
} from "openclaw/plugin-sdk/agent-harness-completion";
import { onTestFinished, vi } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import {
  createCodexNativeSubagentHistoryOwner,
  type CodexNativeSubagentHistoryOwner,
} from "./native-subagent-history-owner.js";
import type {
  NativeModelSource,
  NativeModelSourceCapture,
} from "./native-subagent-monitor-types.js";
import { codexNativeSubagentMonitorRuntime } from "./native-subagent-monitor.js";
import type {
  CodexAppServerRequestResult,
  CodexServerNotification,
  JsonObject,
  JsonValue,
} from "./protocol.js";

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

export function successfulSendInputOutput(params: {
  callId: string;
  submissionId: string;
  parentThreadId?: string;
  turnId?: string;
}): CodexServerNotification {
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: params.parentThreadId ?? "parent-thread",
      turnId: params.turnId ?? "parent-turn",
      item: {
        type: "function_call_output",
        call_id: params.callId,
        output: JSON.stringify({ submission_id: params.submissionId }),
      },
    },
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
  let loadedThreads: readonly string[] | undefined;
  const fixture = createFakeCodexAppServerClient(async (method: string, params?: unknown) => {
    if (method === "thread/unsubscribe") {
      return {};
    }
    if (method === "thread/loaded/list") {
      if (!loadedThreads) {
        throw new Error("loaded threads not configured");
      }
      return { data: [...loadedThreads], nextCursor: null };
    }
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
    client: fixture.client,
    request: fixture.request,
    setLoadedThreads(threadIds: readonly string[]) {
      loadedThreads = [...threadIds];
    },
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
  return {
    captureAgentHarnessCompletionCustody: vi.fn<typeof captureAgentHarnessCompletionCustody>(
      async () => undefined,
    ),
    createAgentHarnessCompletionEventSink: vi.fn<typeof createAgentHarnessCompletionEventSink>(() =>
      vi.fn(),
    ),
    deliverAgentHarnessCompletion: vi.fn(
      async (
        _params: Parameters<typeof deliverAgentHarnessCompletion>[0],
      ): Promise<AgentHarnessCompletionDelivery> => ({ delivered: true, path: "direct" }),
    ),
  };
}

export function createCompletionScope(requesterSessionKey = "agent:main:discord:channel:C123") {
  return { requesterSessionKey, requesterAgentId: "main" } satisfies AgentHarnessCompletionScope;
}

export function nativeHistoryOwner(parentThreadId = "parent-thread") {
  const owner = createCodexNativeSubagentHistoryOwner({
    parentThreadId,
    sessionId: "physical-1",
    lifecycleRevision: "revision-1",
    binding: {
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
  historyOwner?: CodexNativeSubagentHistoryOwner,
) {
  return monitor.registerParent({
    parentThreadId,
    requesterSessionKey,
    completionScope: createCompletionScope(requesterSessionKey),
    agentId: "main",
    ...(historyOwner ? { historyOwner } : {}),
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
  const owner = await registerParent(monitor);
  await notifyChildStarted(client);
  await owner.unregister();
}

export function nativeCompletionNotification(
  params: {
    agentPath?: string;
    parentThreadId?: string;
    turnId?: string;
  } & (
    | { statusLabel?: "completed"; result?: string | null }
    | { statusLabel: "errored"; result: string }
    | { statusLabel: "shutdown" | "not_found"; result?: never }
  ) = {},
): CodexServerNotification {
  const agentPath = params.agentPath ?? "child-thread";
  const statusLabel = params.statusLabel ?? "completed";
  const result = params.result === undefined ? "child final result" : params.result;
  const status =
    statusLabel === "shutdown" || statusLabel === "not_found"
      ? statusLabel
      : { [statusLabel]: result };
  const content = `<subagent_notification>${JSON.stringify({ agent_path: agentPath, status })}</subagent_notification>`;
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: params.parentThreadId ?? "parent-thread",
      ...(params.turnId ? { turnId: params.turnId } : {}),
      item: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: content }],
        internal_chat_message_metadata_passthrough: {
          content_item_kinds: ["multi_agent.subagent_notification"],
        },
      },
    },
  };
}

export function deliveredNativeCompletion() {
  return {
    method: "rawResponseItem/completed",
    params: {
      threadId: "parent-thread",
      turnId: "parent-turn",
      item: {
        type: "agent_message",
        author: "/root/worker",
        recipient: "/root",
        content: [
          {
            type: "input_text",
            text: "Message Type: FINAL_ANSWER\nTask name: /root\nSender: /root/worker\nPayload:\nThe build passed.",
          },
        ],
      },
    },
  } satisfies CodexServerNotification;
}

export function closeAgentNotification(params: {
  method: "item/started" | "item/completed";
  parentThreadId?: string;
  turnId?: string;
  itemId?: string;
  childThreadId?: string;
  previousStatus?: "completed" | "running";
}): CodexServerNotification {
  const parentThreadId = params.parentThreadId ?? "parent-thread";
  const childThreadId = params.childThreadId ?? "child-thread";
  return {
    method: params.method,
    params: {
      threadId: parentThreadId,
      turnId: params.turnId ?? "parent-turn",
      item: {
        id: params.itemId ?? `close-${childThreadId}`,
        type: "collabAgentToolCall",
        tool: "closeAgent",
        status: params.method === "item/started" ? "inProgress" : "completed",
        senderThreadId: parentThreadId,
        receiverThreadIds: [childThreadId],
        agentsStates:
          params.method === "item/completed"
            ? { [childThreadId]: { status: params.previousStatus ?? "completed" } }
            : {},
      },
    },
  };
}

export function turnStartedNotification(
  turnId: string,
  { threadId = "child-thread", ...turn }: { threadId?: string; error?: null } = {},
): CodexServerNotification {
  return {
    method: "turn/started",
    params: {
      threadId,
      turn: { id: turnId, status: "inProgress", items: [], ...turn },
    },
  };
}

export function childTurnCompletedNotification(params: {
  status: "completed" | "failed" | "interrupted";
  error?: string;
  turnId?: string;
  threadId?: string;
  items?: JsonValue[];
}): CodexServerNotification {
  return {
    method: "turn/completed",
    params: {
      threadId: params.threadId ?? "child-thread",
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
    turnId?: string;
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
          id: params.turnId ?? "turn-1",
          status,
          items,
          error: params.error ? { message: params.error } : null,
          completedAt: params.completedAt ?? 1_779_063_288,
        },
      ],
    },
  } as unknown as CodexThreadReadResponse;
}
export function createNativeModelSourceFixture(models: readonly string[]): NativeModelSource {
  let released = false;
  const assertCurrent = () => {
    if (released) {
      throw new Error("Test model source was released");
    }
  };
  return {
    assertCurrent,
    sourceIdentity: {},
    modelPolicyRequired: true,
    bindModelExecution: (model) => {
      assertCurrent();
      if (model?.provider !== "test-provider" || !models.includes(model.model)) {
        throw new Error("Test source does not admit this model");
      }
      return { signal: new AbortController().signal, assertCurrent, release: () => {} };
    },
    release: vi.fn(() => {
      released = true;
    }),
  };
}

export function requireNativeModelSourceCapture(
  capture: NativeModelSourceCapture | undefined,
): NativeModelSourceCapture {
  if (!capture) {
    throw new Error("Expected admitted native model source");
  }
  onTestFinished(capture.release);
  return capture;
}
