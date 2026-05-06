import type {
  ReplyBackendCancelReason,
  ReplyBackendHandle,
  ReplyOperation,
} from "../../auto-reply/reply/reply-run-registry.js";
import type { RunEmbeddedPiAgentParams } from "../pi-embedded-runner/run/params.js";
import type {
  AgentRuntimeContext,
  AgentRunEventStream,
  PreparedAgentRun,
} from "../runtime-backend.js";

function emitPreparedRunEvent(params: {
  context: AgentRuntimeContext;
  preparedRun: PreparedAgentRun;
  stream: AgentRunEventStream;
  data: Record<string, unknown>;
}): void | Promise<void> {
  return params.context.emit({
    runId: params.preparedRun.runId,
    stream: params.stream,
    data: params.data,
    sessionKey: params.preparedRun.sessionKey,
  });
}

function createWorkerHasRepliedRef(
  preparedRun: PreparedAgentRun,
  context: AgentRuntimeContext,
): { value: boolean } {
  let value = false;
  const ref = {} as { value: boolean };
  Object.defineProperty(ref, "value", {
    enumerable: true,
    get: () => value,
    set: (next: boolean) => {
      value = next;
      void emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "lifecycle",
        data: { callback: "has_replied", value },
      });
    },
  });
  return ref;
}

function createWorkerReplyOperationBridge(context: AgentRuntimeContext): ReplyOperation {
  let backend: ReplyBackendHandle | undefined;
  let unsubscribeControl: (() => void) | undefined;
  const abortSignal = context.signal ?? new AbortController().signal;
  const forwardCancel = (reason?: ReplyBackendCancelReason) => {
    backend?.cancel(reason);
  };
  unsubscribeControl = context.control?.onMessage(async (message) => {
    if (message.type === "queue_message") {
      if (backend?.queueMessage && backend.isStreaming()) {
        await backend.queueMessage(message.text);
      }
      return;
    }
    if (message.type === "cancel") {
      forwardCancel(message.reason);
    }
  });

  return {
    key: "worker-reply-operation",
    sessionId: "worker-session",
    abortSignal,
    resetTriggered: false,
    phase: "running",
    result: null,
    setPhase: () => {},
    updateSessionId: () => {},
    attachBackend: (handle) => {
      backend = handle;
    },
    detachBackend: (handle) => {
      if (backend === handle) {
        backend = undefined;
        unsubscribeControl?.();
        unsubscribeControl = undefined;
      }
    },
    complete: () => {},
    completeThen: (afterClear) => {
      afterClear();
    },
    fail: () => {},
    abortByUser: () => {
      forwardCancel("user_abort");
    },
    abortForRestart: () => {
      forwardCancel("restart");
    },
  };
}

export function createRunParamsFromPreparedAgentRun(
  preparedRun: PreparedAgentRun,
  context: AgentRuntimeContext,
): RunEmbeddedPiAgentParams {
  const params = {
    ...preparedRun.runParams,
    agentFilesystem: context.filesystem,
    runId: preparedRun.runId,
    sessionId: preparedRun.sessionId,
    ...(preparedRun.sessionKey ? { sessionKey: preparedRun.sessionKey } : {}),
    sessionFile: preparedRun.sessionFile,
    workspaceDir: preparedRun.workspaceDir,
    ...(preparedRun.agentDir ? { agentDir: preparedRun.agentDir } : {}),
    ...(preparedRun.config ? { config: preparedRun.config } : {}),
    prompt: preparedRun.prompt,
    provider: preparedRun.provider,
    model: preparedRun.model,
    timeoutMs: preparedRun.timeoutMs,
    abortSignal: context.signal,
    shouldEmitToolResult: () => preparedRun.deliveryPolicy.emitToolResult,
    shouldEmitToolOutput: () => preparedRun.deliveryPolicy.emitToolOutput,
    onExecutionStarted: () =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "lifecycle",
        data: { callback: "execution_started" },
      }),
    onPartialReply: (payload) =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "final",
        data: { callback: "partial_reply", payload },
      }),
    onAssistantMessageStart: () =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "lifecycle",
        data: { callback: "assistant_message_start" },
      }),
    onBlockReply: (payload) =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "final",
        data: { callback: "block_reply", payload },
      }),
    onBlockReplyFlush: () =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "lifecycle",
        data: { callback: "block_reply_flush" },
      }),
    onReasoningStream: (payload) =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "reasoning",
        data: { callback: "reasoning_stream", payload },
      }),
    onReasoningEnd: () =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "reasoning",
        data: { callback: "reasoning_end" },
      }),
    onToolResult: (payload) =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "tool",
        data: { callback: "tool_result", payload },
      }),
    onAgentEvent: (event) =>
      emitPreparedRunEvent({
        preparedRun,
        context,
        stream: event.stream,
        data: { callback: "agent_event", stream: event.stream, data: event.data },
      }),
    onUserMessagePersisted: (message) => {
      void emitPreparedRunEvent({
        preparedRun,
        context,
        stream: "lifecycle",
        data: { callback: "user_message_persisted", payload: message },
      });
    },
  } satisfies Partial<RunEmbeddedPiAgentParams>;

  return {
    ...params,
    ...(preparedRun.deliveryPolicy.trackHasReplied
      ? { hasRepliedRef: createWorkerHasRepliedRef(preparedRun, context) }
      : {}),
    ...(preparedRun.deliveryPolicy.bridgeReplyOperation
      ? { replyOperation: createWorkerReplyOperationBridge(context) }
      : {}),
  } as RunEmbeddedPiAgentParams;
}
