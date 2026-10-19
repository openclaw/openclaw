import type {
  deliverAgentHarnessCompletion,
  captureAgentHarnessCompletionCustody,
  createAgentHarnessCompletionEventSink,
  AgentHarnessCompletionScope,
} from "openclaw/plugin-sdk/agent-harness-completion";
import { onTestFinished, vi } from "vitest";
import { createFakeCodexAppServerClient } from "./codex-app-server.test-fixtures.js";
import { CodexNativeSubagentCompletionDelivery } from "./native-subagent-completion-delivery.js";
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

function serverNotification<P extends JsonObject>(method: string, params: P) {
  return { method, params };
}

export function itemNotification(
  item: JsonObject,
  turnId = "parent-turn",
  threadId = "parent-thread",
  phase = "completed",
): CodexServerNotification {
  return { method: `item/${phase}`, params: { threadId, turnId, item } };
}

export function collabItem(
  tool: string,
  receiverThreadIds: string[],
  fields: JsonObject = {},
): JsonObject {
  return {
    type: "collabAgentToolCall",
    tool,
    status: "completed",
    senderThreadId: "parent-thread",
    receiverThreadIds,
    ...fields,
  };
}

function threadOrigin(parentThreadId: string, agentPath?: string) {
  return {
    subAgent: {
      thread_spawn: {
        parent_thread_id: parentThreadId,
        depth: 1,
        ...(agentPath !== undefined ? { agent_path: agentPath } : {}),
      },
    },
  };
}

export function directSpawnItem(
  version: DirectSpawnVersion,
  parentThreadId: string,
  childThreadId: string,
): JsonObject {
  return version === "v1"
    ? collabItem("spawnAgent", [childThreadId], { senderThreadId: parentThreadId })
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
  return serverNotification("rawResponseItem/completed", {
    threadId: params.parentThreadId ?? "parent-thread",
    turnId: params.turnId ?? "parent-turn",
    item: {
      type: "function_call_output",
      call_id: params.callId,
      output: JSON.stringify({ submission_id: params.submissionId }),
    },
  });
}

export const CodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.Monitor;
export const registerCodexNativeSubagentMonitor = codexNativeSubagentMonitorRuntime.register;
type CodexNativeSubagentMonitorInstance = InstanceType<typeof CodexNativeSubagentMonitor>;

export function observeCompletionAttempts() {
  const attempts = new Map<Promise<void>, string>();
  const prototype = CodexNativeSubagentCompletionDelivery.prototype;
  const observer = vi.spyOn(prototype, "deliverPending");
  prototype.deliverPending = function (this: CodexNativeSubagentCompletionDelivery, state, child) {
    const attempt = observer.call(this, state, child);
    attempts.set(attempt, child.runId);
    return attempt;
  };
  onTestFinished(() => observer.mockRestore());
  return {
    async settle(runId?: string) {
      // Join real attempts, including delivery admitted by completion callbacks.
      while (true) {
        const batch = [...attempts].filter(([, id]) => runId === undefined || id === runId);
        if (batch.length === 0) {
          return;
        }
        for (const [attempt] of batch) {
          attempts.delete(attempt);
        }
        await Promise.all(batch.map(([attempt]) => attempt));
      }
    },
    restore: () => observer.mockRestore(),
  };
}

export function createClient() {
  type ThreadReadParams = { threadId?: string; includeTurns?: boolean };
  type ThreadReadFactory = (
    params: ThreadReadParams,
  ) => CodexThreadReadResponse | Promise<CodexThreadReadResponse>;
  const threadReads = new Map<string, CodexThreadReadResponse | Error | ThreadReadFactory>();
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
    if (method !== "thread/read" && method !== "thread/turns/list") {
      throw new Error(`unexpected request: ${method}`);
    }
    const readParams = (params as ThreadReadParams | undefined) ?? {};
    const childThreadId = readParams.threadId ?? "";
    const turns = method === "thread/turns/list";
    const response = turns ? threadTurns.get(childThreadId) : threadReads.get(childThreadId);
    if (response instanceof Error) {
      throw response;
    }
    if (response === undefined) {
      throw new Error(`${turns ? "thread turns" : "thread"} not loaded: ${childThreadId}`);
    }
    return typeof response === "function" ? await response(readParams) : response;
  });
  onTestFinished(async () => {
    fixture.close();
    await Promise.resolve();
  });
  const sender =
    <Args extends unknown[]>(factory: (...args: Args) => CodexServerNotification) =>
    (...args: Args) =>
      fixture.notify(factory(...args));
  return {
    client: fixture.client,
    request: fixture.request,
    setLoadedThreads(threadIds: readonly string[]) {
      loadedThreads = [...threadIds];
    },
    setThreadRead(childThreadId: string, response: CodexThreadReadResponse | Error) {
      threadReads.set(childThreadId, response);
    },
    setThreadReadFactory(childThreadId: string, response: ThreadReadFactory) {
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
    item: sender(itemNotification),
    startTurn: sender(turnStartedNotification),
    completeTurn: sender(childTurnCompletedNotification),
    finishTurn(turnId: string, ...items: JsonValue[]) {
      return sender(childTurnCompletedNotification)({ turnId, status: "completed", items });
    },
    completeNative: sender(nativeCompletionNotification),
    sendInputOutput: sender(successfulSendInputOutput),
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
    deliverAgentHarnessCompletion: vi.fn<typeof deliverAgentHarnessCompletion>(async () => ({
      delivered: true,
      path: "direct",
    })),
  };
}

export function createMonitorFixture(
  options?: ConstructorParameters<typeof CodexNativeSubagentMonitor>[2],
) {
  const client = createClient();
  const runtime = createRuntime();
  const monitor = new CodexNativeSubagentMonitor(client.client, runtime, options);
  const captureSource = async (request: Parameters<typeof monitor.captureModelSource>[0]) =>
    requireNativeModelSourceCapture(await monitor.captureModelSource(request));
  return { client, runtime, monitor, captureSource };
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
  const notification = serverNotification("thread/started", {
    thread: {
      id: childThreadId,
      ...(options.directParentField === false ? {} : { parentThreadId }),
      preview: "inspect the repo",
      source: threadOrigin(parentThreadId, agentPath),
    },
  });
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
  return serverNotification("rawResponseItem/completed", {
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
  });
}

export function deliveredNativeCompletion() {
  return serverNotification("rawResponseItem/completed", {
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
  });
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
  const started = params.method === "item/started";
  return itemNotification(
    collabItem("closeAgent", [childThreadId], {
      id: params.itemId ?? `close-${childThreadId}`,
      status: started ? "inProgress" : "completed",
      senderThreadId: parentThreadId,
      agentsStates: started
        ? {}
        : { [childThreadId]: { status: params.previousStatus ?? "completed" } },
    }),
    params.turnId ?? "parent-turn",
    parentThreadId,
    started ? "started" : "completed",
  );
}

export function turnStartedNotification(
  turnId: string,
  { threadId = "child-thread", ...turn }: { threadId?: string; error?: null } = {},
): CodexServerNotification {
  return serverNotification("turn/started", {
    threadId,
    turn: { id: turnId, status: "inProgress", items: [], ...turn },
  });
}

export function childTurnCompletedNotification(params: {
  status: "completed" | "failed" | "interrupted";
  error?: string;
  turnId?: string;
  threadId?: string;
  items?: JsonValue[];
}): CodexServerNotification {
  return serverNotification("turn/completed", {
    threadId: params.threadId ?? "child-thread",
    turn: {
      id: params.turnId ?? "child-turn",
      status: params.status,
      items: params.items ?? [],
      error: params.error ? { message: params.error } : null,
    },
  });
}

export function agentMessage(
  id: string,
  text: string,
  phase?: "commentary" | "final_answer",
): JsonObject {
  return { id, type: "agentMessage", text, ...(phase ? { phase } : {}) };
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
    ...(params.result ? [agentMessage("message-1", params.result, params.resultPhase)] : []),
    ...(params.trailingCommentary
      ? [agentMessage("message-commentary", params.trailingCommentary, "commentary")]
      : []),
  ];
  return {
    thread: {
      id: childThreadId,
      ...(params.directParentField === false ? {} : { parentThreadId }),
      source: threadOrigin(parentThreadId, params.agentPath || undefined),
      status: { type: params.threadStatus ?? "idle" },
      turns: [
        ...(params.previousResult
          ? [
              {
                id: "turn-previous",
                status: "completed",
                items: [agentMessage("message-previous", params.previousResult)],
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
