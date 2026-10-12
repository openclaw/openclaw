import { isResponsesOutputLimitToolCallError } from "@openclaw/ai/diagnostics";
import {
  createEmptyTransportUsage,
  replaceCompactionReplayOwnerContent,
} from "@openclaw/ai/transports";
import {
  appendTextDeltaToAssistantMessage,
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
} from "@openclaw/llm-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ToolResultMessage,
} from "@openclaw/llm-core";
import { uuidv7 } from "./harness/session/uuid.js";
import { copyInternalToolResultState } from "./internal-hooks.js";
import {
  type AgentCoreStreamRuntimeDeps,
  resolveAgentCoreStreamFn,
  runAgentCoreStream,
} from "./runtime-deps.js";
import { createStreamSteering } from "./stream-steering.js";
import { normalizeCoreContextMessages } from "./turn-interruption.js";
import { withToolResultContentSource } from "./turn-taint.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
  ToolLoopIntervention,
  ToolResultContentSource,
} from "./types.js";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

export type AsyncToolBatchScheduling = {
  waitForPrevious: () => Promise<void>;
  onParallelStarted: () => void;
  hasUnobservedAsyncToolResults: boolean;
};

export type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  terminalToolCallIds: string[];
  steeringMessages: AgentMessage[];
  terminate: boolean;
  terminateRun: boolean;
  intervention?: ToolLoopIntervention;
  fatal?: { error: unknown };
};

type AssistantMessageUpdateEvent = Extract<AssistantMessageEvent, { contentIndex: number }>;

function resolveAssistantMessageUpdate(
  event: AssistantMessageUpdateEvent,
  currentMessage: AssistantMessage,
): AssistantMessage {
  if ("partial" in event && event.partial) {
    return event.partial;
  }
  if (event.type !== "text_delta") {
    return currentMessage;
  }
  return appendTextDeltaToAssistantMessage(currentMessage, event.contentIndex, event.delta);
}

function removeNonExecutableToolCalls(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "toolUse") {
    return message;
  }
  const content = message.content.filter((item) => item.type !== "toolCall" || item.async);
  return content.length === message.content.length
    ? message
    : replaceCompactionReplayOwnerContent(message, content);
}

function ensureToolTurnIdentity(message: AssistantMessage): AssistantMessage {
  const executable =
    message.stopReason === "toolUse" ||
    ((message.stopReason === "stop" || message.stopReason === "length") &&
      message.content.some((item) => item.type === "toolCall" && item.async));
  if (!executable || message.responseId?.trim() || message.turnId?.trim()) {
    return message;
  }
  // message_end persists this local identity before any tool can execute.
  return { ...message, turnId: uuidv7() };
}

export async function emitToolResultMessage(
  finalized: {
    toolCall: AgentToolCall;
    result: AgentToolResult<unknown>;
    isError: boolean;
    resultContentSource?: ToolResultContentSource;
  },
  emit: AgentEventSink,
): Promise<ToolResultMessage> {
  const message = copyInternalToolResultState(
    finalized.result,
    withToolResultContentSource(
      {
        role: "toolResult",
        toolCallId: finalized.toolCall.id,
        toolName: finalized.toolCall.name,
        content: finalized.result.content ?? [],
        details: finalized.result.details,
        isError: finalized.isError,
        timestamp: Date.now(),
      },
      finalized.resultContentSource,
    ),
  );
  await emit({ type: "message_start", message });
  const event = { type: "message_end" as const, message };
  await emit(event);
  return event.message;
}

export async function streamAgentResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  newMessages: AgentMessage[],
  executeAsyncTools: (
    message: AssistantMessage,
    calls: AgentToolCall[],
    signal: AbortSignal,
    emit: AgentEventSink,
    scheduling: AsyncToolBatchScheduling,
  ) => Promise<ExecutedToolCallBatch>,
  prepareAssistantMessage: (message: AssistantMessage) => AssistantMessage,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<{
  message: AssistantMessage;
  executedIds: Set<string>;
  batches: ExecutedToolCallBatch[];
  continuationRequired: boolean;
}> {
  const sourceMessages = [...context.messages];
  const convertMessages = async (messages: AgentMessage[], projectionSignal = signal) => {
    const transformed = config.transformContext
      ? await config.transformContext(messages, projectionSignal)
      : messages;
    return config.convertToLlm(normalizeCoreContextMessages(transformed));
  };
  const llmMessages = await convertMessages(sourceMessages);
  let requestPrefix: string | undefined;

  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = resolveAgentCoreStreamFn(runtime, streamFn);

  // Resolve API key (important for expiring tokens)
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const executionAbort = new AbortController();
  const executionSignal = signal
    ? AbortSignal.any([signal, executionAbort.signal])
    : executionAbort.signal;
  const abortFailedResponse = (message?: AssistantMessage) => {
    if (
      message &&
      (message.stopReason === "error" || message.stopReason === "aborted") &&
      !isResponsesOutputLimitToolCallError(message)
    ) {
      executionAbort.abort(new Error(message.errorMessage ?? "Model response interrupted"));
    }
  };
  const steering = createStreamSteering(config, executionSignal, async (pending) => {
    requestPrefix ??= JSON.stringify(llmMessages);
    const projected = await convertMessages([...sourceMessages, ...pending], executionSignal);
    // Live input can only append to the active request. Pruning or rewriting
    // its prefix needs ordinary queued delivery through a fresh request.
    if (JSON.stringify(projected.slice(0, llmMessages.length)) !== requestPrefix) {
      return [];
    }
    return projected.slice(llmMessages.length);
  });
  const executedIds = new Set<string>();
  const batches: ExecutedToolCallBatch[] = [];
  let executions = Promise.resolve();
  let admissions = Promise.resolve();
  let executionFailure: { error: unknown } | undefined;
  const emitToolEvent: AgentEventSink = async (event) => {
    if (event.type !== "message_end" || event.message.role !== "toolResult") {
      await emit(event);
      return;
    }
    const message = event.message;
    const contextIndex = context.messages.push(message) - 1;
    const newIndex = newMessages.push(message) - 1;
    try {
      await emit(event);
    } finally {
      if (event.message !== message && event.message.role === "toolResult") {
        if (context.messages[contextIndex] === message) {
          context.messages[contextIndex] = event.message;
        }
        if (newMessages[newIndex] === message) {
          newMessages[newIndex] = event.message;
        }
      }
    }
  };
  const enqueueTools = (message: AssistantMessage) => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      return;
    }
    const calls = message.content.filter(
      (item): item is AgentToolCall =>
        item.type === "toolCall" &&
        !executedIds.has(item.id) &&
        (message.stopReason === "toolUse" || item.async === true),
    );
    if (calls.length === 0) {
      return;
    }
    const hasUnobservedAsyncToolResults = executedIds.size > 0;
    for (const call of calls) {
      executedIds.add(call.id);
    }
    const previousExecutions = executions;
    const previousAdmission = admissions;
    // SAFETY: Promise construction assigns the admission release synchronously.
    let releaseAdmission!: () => void;
    admissions = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    const execution = previousAdmission
      .then(async () => {
        const batch = await executeAsyncTools(message, calls, executionSignal, emitToolEvent, {
          waitForPrevious: () => previousExecutions,
          onParallelStarted: releaseAdmission,
          hasUnobservedAsyncToolResults,
        });
        batches.push(batch);
        if (batch.fatal || batch.terminateRun) {
          executionAbort.abort(batch.fatal?.error ?? new Error("Tool batch terminated"));
        }
      })
      .catch((error: unknown) => {
        executionFailure ??= { error };
        executionAbort.abort(error);
      })
      .finally(releaseAdmission);
    executions = Promise.all([previousExecutions, execution]).then(() => {});
  };
  try {
    const stream = streamFunction(config.model, llmContext, {
      ...config,
      apiKey: resolvedApiKey,
      signal: executionSignal,
      onActiveResponse: steering.onActiveResponse,
      asyncToolExecution: true,
    });

    return await runAgentCoreStream(
      stream,
      async () => {
        const response = await stream;
        let partialMessage: AssistantMessage | null = null;
        let partialIndex: number | undefined;
        let committedContentCount = 0;
        let streamedTurnId: string | undefined;

        // Result wrappers bind ownership to unchanged content. Only split actual async fragments.
        const remainingFragment = (message: AssistantMessage) =>
          committedContentCount === 0
            ? message
            : replaceCompactionReplayOwnerContent(
                message,
                message.content.slice(committedContentCount),
              );
        const updatePartial = async (message: AssistantMessage) => {
          const fragment = remainingFragment(message);
          if (partialIndex === undefined) {
            partialIndex = context.messages.length;
            context.messages.push(fragment);
            await emit({ type: "message_start", message: { ...fragment } });
          } else {
            context.messages[partialIndex] = fragment;
          }
          return fragment;
        };

        const commitFragment = async (message: AssistantMessage) => {
          if (partialIndex === undefined) {
            context.messages.push(message);
            await emit({ type: "message_start", message: { ...message } });
          } else {
            context.messages.splice(partialIndex, 1);
            context.messages.push(message);
          }
          partialIndex = undefined;
          newMessages.push(message);
          await emit({ type: "message_end", message });
        };

        for await (const event of response) {
          switch (event.type) {
            case "start": {
              const message = event.partial;
              partialMessage = message;
              await updatePartial(message);
              break;
            }

            case "text_start":
            case "text_delta":
            case "text_end":
            case "thinking_start":
            case "thinking_delta":
            case "thinking_end":
            case "toolcall_start":
            case "toolcall_delta":
            case "toolcall_end":
              if (partialMessage) {
                const message = resolveAssistantMessageUpdate(event, partialMessage);
                partialMessage = message;
                if (event.contentIndex < committedContentCount) {
                  break;
                }
                const fragment = await updatePartial(message);
                const fragmentEvent = {
                  ...event,
                  contentIndex: event.contentIndex - committedContentCount,
                  ...("partial" in event ? { partial: fragment } : {}),
                };
                await emit({
                  type: "message_update",
                  assistantMessageEvent: fragmentEvent,
                  message: { ...fragment },
                });
                if (
                  event.type === "toolcall_end" &&
                  event.toolCall.async &&
                  !executedIds.has(event.toolCall.id) &&
                  message.content
                    .slice(committedContentCount, event.contentIndex)
                    .every((item) => item.type !== "toolCall" || item.async === true)
                ) {
                  const prefix = prepareAssistantMessage(
                    ensureToolTurnIdentity({
                      ...replaceCompactionReplayOwnerContent(
                        message,
                        message.content.slice(committedContentCount, event.contentIndex + 1),
                      ),
                      ...(streamedTurnId ? { turnId: streamedTurnId } : {}),
                      stopReason: "toolUse",
                      // Usage belongs to the terminal fragment, once per provider response.
                      usage: createEmptyTransportUsage(),
                    }),
                  );
                  streamedTurnId ??= prefix.turnId;
                  // Await transcript persistence before admitting side effects. The model
                  // may keep sampling, but every executed call has a durable owner.
                  await commitFragment(prefix);
                  committedContentCount = event.contentIndex + 1;
                  enqueueTools(prefix);
                }
              }
              break;

            case "done":
            case "error":
              return await finalizeAssistantMessage(
                event.type === "done" ? event.message : event.error,
              );
          }
        }

        // Stream ended without a terminal event: result() either carries an explicit
        // end(result) value or rejects with the EventStream terminal-contract error,
        // so a contract-violating producer surfaces loudly instead of hanging here.
        return await finalizeAssistantMessage();

        async function finalizeAssistantMessage(terminal?: AssistantMessage) {
          // Output-limit recovery drains admitted tools; other failures fence queued starts.
          abortFailedResponse(terminal);
          const result = await response.result();
          abortFailedResponse(result);
          const outputLimit = isResponsesOutputLimitToolCallError(result);
          if (outputLimit) {
            // Record one provider terminal, with its original usage, after tool outcomes settle.
            await executions;
          }
          const tail = remainingFragment(result);
          const finalMessage = prepareAssistantMessage(
            ensureToolTurnIdentity(
              removeNonExecutableToolCalls({
                ...tail,
                // The provider stop covers the whole response. Its calls were committed
                // with earlier fragments, so a call-free tail is the response's end.
                ...(committedContentCount > 0 &&
                tail.stopReason === "toolUse" &&
                !tail.content.some((item) => item.type === "toolCall")
                  ? { stopReason: "stop" as const }
                  : {}),
                ...(streamedTurnId ? { turnId: streamedTurnId } : {}),
                ...(outputLimit && signal?.aborted
                  ? { stopReason: "aborted" }
                  : outputLimit && batches.length > 0 && batches.every((batch) => batch.terminate)
                    ? { errorCode: PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE }
                    : {}),
              }),
            ),
          );
          await commitFragment(finalMessage);
          if (executedIds.size > 0) {
            enqueueTools(finalMessage);
          }
          await executions;
          if (executionFailure) {
            throw executionFailure.error;
          }
          const continuationRequired = await steering.finish();
          return { message: finalMessage, executedIds, batches, continuationRequired };
        }
      },
      runtime,
    );
  } finally {
    executionAbort.abort(new Error("Model response closed"));
    await executions;
    await steering.finish();
  }
}
