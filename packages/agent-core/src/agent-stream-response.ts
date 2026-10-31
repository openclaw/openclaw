import { isResponsesOutputLimitToolCallError } from "@openclaw/ai/diagnostics";
import { prepareSystemPrompt } from "@openclaw/ai/internal/shared";
import {
  createEmptyTransportUsage,
  replaceCompactionReplayOwnerContent,
} from "@openclaw/ai/transports";
import {
  appendTextDeltaToAssistantMessage,
  PROVIDER_FAILURE_WITH_OUTPUT_ERROR_CODE,
  REPETITIVE_OUTPUT_ERROR_CODE,
} from "@openclaw/llm-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  ToolResultMessage,
} from "@openclaw/llm-core";
import { AssistantRepetitionGuard } from "./assistant-repetition-guard.js";
import { REPETITIVE_OUTPUT_ERROR_MESSAGE } from "./errors.js";
import { uuidv7 } from "./harness/session/uuid.js";
import { copyInternalToolResultState } from "./internal-hooks.js";
import {
  type AgentCoreStreamRuntimeDeps,
  resolveAgentCoreStreamFn,
  runAgentCoreStream,
} from "./runtime-deps.js";
import { createStreamSteering } from "./stream-steering.js";
import { mergeToolExecutionFailure } from "./tool-batch-completion.js";
import type { FinalizedToolCallOutcome } from "./tool-call-outcome.js";
import { resolveAgentAssistantTurnId } from "./tool-execution-context.js";
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
  onTerminalLoop: () => void;
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

function removeNonExecutableToolCalls(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "toolUse") {
    return message;
  }
  const failed = message.stopReason === "aborted" || message.stopReason === "error";
  // Executed async calls already own earlier fragments; a failed tail cannot admit another call.
  const content = message.content.filter(
    (item) => item.type !== "toolCall" || (!failed && item.async),
  );
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

export function emitToolExecutionStart(
  batch: { emit: AgentEventSink },
  toolCall: AgentToolCall,
  hideFromChannelProgress: boolean,
): ReturnType<AgentEventSink> {
  return batch.emit({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
    ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
  });
}

export function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  batch: { emit: AgentEventSink; assistantMessage: AssistantMessage },
): ReturnType<AgentEventSink> {
  const assistantTurnId = resolveAgentAssistantTurnId(batch.assistantMessage);
  return batch.emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    ...(assistantTurnId ? { assistantTurnId } : {}),
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
    executionStarted: finalized.executionStarted,
    ...(finalized.errorKind ? { errorKind: finalized.errorKind } : {}),
    ...(finalized.hideFromChannelProgress === true ? { hideFromChannelProgress: true } : {}),
  });
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
    return config.convertToLlm(
      transformed.map<AgentMessage>((message) => {
        if (message.role !== "custom" || message.customType !== "openclaw:turn-aborted") {
          return message;
        }
        return {
          role: "user",
          content:
            typeof message.content === "string"
              ? [{ type: "text", text: message.content }]
              : message.content,
          timestamp: message.timestamp,
        };
      }),
    );
  };
  const llmMessages = await convertMessages(sourceMessages);
  let requestPrefix: string | undefined;

  context.preparedSystemPrompt = prepareSystemPrompt(
    context.systemPrompt,
    context.preparedSystemPrompt,
  );
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    preparedSystemPrompt: context.preparedSystemPrompt,
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
  const modelAbort = new AbortController();
  const requestSignal = AbortSignal.any([executionSignal, modelAbort.signal]);
  let repeatedToolErrorTerminated = false;
  const onTerminalLoop = () => {
    // Stop sampling before ordered publication waits for already-started effects.
    repeatedToolErrorTerminated = true;
    modelAbort.abort(new Error("Tool batch terminated"));
  };
  const abortFailedResponse = (message?: AssistantMessage) => {
    if (
      message &&
      !repeatedToolErrorTerminated &&
      (message.stopReason === "error" || message.stopReason === "aborted") &&
      message.errorCode !== REPETITIVE_OUTPUT_ERROR_CODE &&
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
        // Later queued batches complete as unstarted calls without cancelling active work.
        let batchSignal = executionSignal;
        if (repeatedToolErrorTerminated) {
          batchSignal = AbortSignal.abort(new Error("Tool-loop recovery ended"));
          // Suppressed batches skip admission and its lifecycle publication barrier.
          // Sampling already stopped; keep their synthetic results behind earlier work.
          await previousExecutions;
        }
        const batch = await executeAsyncTools(message, calls, batchSignal, emitToolEvent, {
          waitForPrevious: () => previousExecutions,
          onParallelStarted: releaseAdmission,
          onTerminalLoop,
          hasUnobservedAsyncToolResults,
        });
        batches.push(batch);
        if (
          batch.fatal ||
          (batch.terminateRun && batch.intervention?.detector !== "repeated_tool_error")
        ) {
          executionAbort.abort(batch.fatal?.error ?? new Error("Tool batch terminated"));
        }
      })
      .catch((error: unknown) => {
        executionFailure = mergeToolExecutionFailure(executionFailure, error);
        executionAbort.abort(error);
      })
      .finally(releaseAdmission);
    executions = Promise.all([previousExecutions, execution]).then(() => {});
  };
  let responseFailure: ExecutedToolCallBatch["fatal"];
  try {
    const stream = streamFunction(config.model, llmContext, {
      ...config,
      apiKey: resolvedApiKey,
      signal: requestSignal,
      onActiveResponse: steering.onActiveResponse,
      // Async results reach the model only when it calls sessions_yield, the result
      // collector. Without it (cron runs) the model would answer before any result.
      asyncToolExecution: llmContext.tools?.some((tool) => tool.name === "sessions_yield") === true,
    });

    return await runAgentCoreStream(
      stream,
      async () => {
        const response = await stream;
        const repetitionGuard = config.repetitionGuard?.(config.model)
          ? new AssistantRepetitionGuard()
          : undefined;
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

        function projectEvent(
          event: Extract<AssistantMessageEvent, { contentIndex: number }>,
          fragment: AssistantMessage,
          completedToolCall: boolean,
        ) {
          // Keep completion events isolated: their original fields govern admission after emit.
          if (
            committedContentCount === 0 &&
            !completedToolCall &&
            (!("partial" in event) || event.partial === fragment)
          ) {
            return event;
          }
          const projected = { ...event, contentIndex: event.contentIndex - committedContentCount };
          if ("partial" in event) {
            projected.partial = fragment;
          }
          return projected;
        }

        for await (const event of response) {
          switch (event.type) {
            case "start": {
              const message = event.partial;
              partialMessage = message;
              partialIndex = context.messages.length;
              context.messages.push(message);
              await emit({ type: "message_start", message: { ...message } });
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
                // Only updates assembled here prove appends; provider snapshots can correct text.
                let append: { offset: number; delta: string } | undefined;
                if (repetitionGuard && event.type === "text_delta" && event.partial === undefined) {
                  const priorBlock = partialMessage.content[event.contentIndex];
                  append = {
                    offset: priorBlock?.type === "text" ? priorBlock.text.length : 0,
                    delta: event.delta,
                  };
                }
                let message: AssistantMessage = partialMessage;
                if ("partial" in event && event.partial) {
                  message = event.partial;
                } else if (event.type === "text_delta") {
                  message = appendTextDeltaToAssistantMessage(
                    partialMessage,
                    event.contentIndex,
                    event.delta,
                  );
                }
                partialMessage = message;
                if (event.contentIndex < committedContentCount) {
                  break;
                }
                const stopped = repetitionGuard?.check(
                  message,
                  committedContentCount,
                  event.type === "toolcall_end" ? undefined : event.contentIndex,
                  append,
                );
                if (stopped) {
                  modelAbort.abort(new Error(REPETITIVE_OUTPUT_ERROR_MESSAGE));
                  return await finalizeAssistantMessage(stopped);
                }
                const fragment = remainingFragment(message);
                if (partialIndex === undefined) {
                  partialIndex = context.messages.length;
                  context.messages.push(fragment);
                  await emit({ type: "message_start", message: { ...fragment } });
                } else {
                  context.messages[partialIndex] = fragment;
                }
                const completedToolCall = event.type === "toolcall_end";
                const fragmentEvent = projectEvent(event, fragment, completedToolCall);
                await emit({
                  type: "message_update",
                  assistantMessageEvent: fragmentEvent,
                  // Partial-free text already has a fresh envelope; providers still own snapshots.
                  message:
                    event.type === "text_delta" && !event.partial
                      ? Object.freeze(fragment)
                      : { ...fragment },
                });
                if (
                  completedToolCall &&
                  event.toolCall.async &&
                  !executedIds.has(event.toolCall.id) &&
                  message.content
                    .slice(committedContentCount, event.contentIndex)
                    .every((item) => item.type !== "toolCall" || item.async === true)
                ) {
                  // Persistence takes ownership and freezes nested values. Detach the
                  // completed prefix after reindexing checkpoints using original block identity.
                  let prefix = structuredClone(
                    replaceCompactionReplayOwnerContent(
                      message,
                      message.content.slice(committedContentCount, event.contentIndex + 1),
                    ),
                  );
                  if (streamedTurnId) {
                    prefix.turnId = streamedTurnId;
                  }
                  prefix.stopReason = "toolUse";
                  // Usage belongs to the terminal fragment, once per provider response.
                  prefix.usage = createEmptyTransportUsage();
                  prefix = prepareAssistantMessage(ensureToolTurnIdentity(prefix));
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
          const stoppedTerminal =
            terminal?.errorCode === REPETITIVE_OUTPUT_ERROR_CODE
              ? terminal
              : terminal && repetitionGuard?.check(terminal, committedContentCount);
          if (stoppedTerminal) {
            modelAbort.abort(new Error(REPETITIVE_OUTPUT_ERROR_MESSAGE));
          }
          // Classify first: repetition drains admitted tools even in a provider error snapshot.
          abortFailedResponse(stoppedTerminal ?? terminal);
          const providerResult = await response.result();
          const stopped =
            stoppedTerminal ?? repetitionGuard?.check(providerResult, committedContentCount);
          if (stopped) {
            modelAbort.abort(new Error(REPETITIVE_OUTPUT_ERROR_MESSAGE));
          }
          const result = stopped ? { ...stopped, usage: providerResult.usage } : providerResult;
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
  } catch (error) {
    responseFailure = { error };
    throw error;
  } finally {
    executionAbort.abort(new Error("Model response closed"));
    await executions;
    if (executionFailure) {
      responseFailure = mergeToolExecutionFailure(responseFailure, executionFailure.error);
    }
    if (responseFailure) {
      for (const batch of batches) {
        if (batch.fatal) {
          responseFailure = mergeToolExecutionFailure(responseFailure, batch.fatal.error);
        }
      }
    }
    try {
      await steering.finish();
    } catch (error) {
      if (!responseFailure) {
        for (const batch of batches) {
          if (batch.fatal) {
            responseFailure = mergeToolExecutionFailure(responseFailure, batch.fatal.error);
          }
        }
      }
      responseFailure = mergeToolExecutionFailure(responseFailure, error);
    }
    if (responseFailure) {
      // oxlint-disable-next-line eslint/no-unsafe-finally -- Rethrow the primary and drained failures together.
      throw responseFailure.error;
    }
  }
}
