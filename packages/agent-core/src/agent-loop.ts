import type { AssistantMessage, ToolResultMessage } from "@openclaw/llm-core";
import { coerceErrorMessage } from "@openclaw/normalization-core/error-coercion";
import {
  commitInputMessages,
  createStreamedSteeringConfig,
  getSteeringAtCheckpoint,
} from "./agent-loop-steering.js";
import {
  prepareToolCallExecution,
  prepareResolvedToolCall,
  launchParallelToolCalls,
  type ToolPlanState,
  type FinalizedToolCallEntry,
  type ReadyPreparedToolCall,
  type StartedToolCall,
  type PreparedToolCall,
  type ExecutedToolCallOutcome,
} from "./agent-loop-tool-execution.js";
import {
  emitToolResultMessage,
  emitToolExecutionStart,
  emitToolExecutionEnd,
  streamAgentResponse,
  type AgentEventSink,
  type AsyncToolBatchScheduling,
  type ExecutedToolCallBatch,
} from "./agent-stream-response.js";
import { TranscriptNotContinuableError } from "./errors.js";
import {
  getInternalBeforeRequest,
  getInternalToolTurnInputScope,
  getInternalSteeringQueueObserver,
  type InternalBeforeRequestHook,
} from "./internal-hooks.js";
import { isOpenClawSystemUpdateMessage } from "./operator-messages.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import type { AgentCoreStreamRuntimeDeps } from "./runtime-deps.js";
import {
  combineExecutedToolBatches,
  drainToolCallGroup,
  mergeRejectedToolOutcomes,
  mergeToolExecutionFailure,
  resolveToolBatchTermination,
} from "./tool-batch-completion.js";
import {
  completeUnstartedToolCall,
  completeStartedToolCall,
  finalizeToolCallOutcome,
  finalizeExecutedToolCall,
  immediateToolCallError,
  hidesToolCallFromChannelProgress,
  type ResolvedToolCallOutcome,
  type FinalizedToolCallOutcome,
  type ImmediateToolCallOutcome,
} from "./tool-call-outcome.js";
import {
  captureAgentToolInputScope,
  resolveAgentAssistantTurnId,
} from "./tool-execution-context.js";
import {
  TOOL_REPEAT_LIMIT_CODE,
  createToolRepeatState,
  createToolRepeatStopResult,
  createToolNoProgressResult,
  formatToolRepeatStopMessage,
  observeToolNoProgress,
  observeToolRepeat,
  recordToolProgress,
  toolProgressOutcome,
  resetToolRepeatState,
  type ToolRepeatState,
  type ToolRepeatVerdict,
  type ToolNoProgressState,
} from "./tool-repeat-guard.js";
import {
  appendInterruptedTurnMessage,
  createFailureMessage,
  isTurnHandoffAbort,
} from "./turn-interruption.js";
import { isActiveTurnTainted, toolResultTaintsTurn, withAssistantTurnTaint } from "./turn-taint.js";
import type {
  AgentContext,
  AgentLoopConfig,
  AgentLoopTurnUpdate,
  AgentMessage,
  AgentToolCall,
  StreamFn,
} from "./types.js";

/** Callback used by synchronous loop runners to publish agent lifecycle events. */
export type { AgentEventSink } from "./agent-stream-response.js";

/** Run a prompt-started loop and emit events through a caller-owned sink. */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [];
  const repeatState = config.toolRepeatState ?? createToolRepeatState();
  const state = { context: { ...context, messages: [...context.messages] } };
  const promptContext = prompts.filter(isOpenClawSystemUpdateMessage);
  const inputPrompts = prompts.filter((message) => !isOpenClawSystemUpdateMessage(message));
  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  await commitInputMessages(inputPrompts, state.context, config, emit, newMessages, () =>
    resetToolRepeatState(repeatState),
  );
  if (inputPrompts.length > 0 && newMessages.length === 0) {
    // A drained queue batch can be cancelled while turn_start listeners settle.
    // Close without a provider call so cancelled input cannot become an empty continuation.
    await emit({ type: "agent_end", messages: [] });
    return [];
  }
  return runLoop(
    state,
    newMessages,
    { ...config, toolRepeatState: repeatState },
    signal,
    emit,
    streamFn,
    runtime,
    promptContext,
    getInternalBeforeRequest(config),
  );
}

/** Continue an existing loop context and emit only newly produced messages. */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AgentMessage[]> {
  const lastMessage = context.messages.at(-1);
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (lastMessage.role === "assistant") {
    throw new TranscriptNotContinuableError(lastMessage.role);
  }
  return runAgentLoop([], context, config, emit, signal, streamFn, runtime);
}

/**
 * Own one replaceable context slot so this async frame does not retain earlier
 * contexts after a next-turn hook replaces them.
 */
async function runLoop(
  state: { context: AgentContext },
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
  initialPromptContext: AgentMessage[] = [],
  beforeRequest?: InternalBeforeRequestHook,
): Promise<AgentMessage[]> {
  let config = initialConfig;
  let promptContext = initialPromptContext;
  let firstTurn = true;
  let prepareContinuation: AgentLoopTurnUpdate["prepareContinuation"];
  let turnOpen = true;
  let turnTainted = isActiveTurnTainted(state.context.messages);
  const toolRepeatState = initialConfig.toolRepeatState ?? createToolRepeatState();
  let pendingMessages: AgentMessage[] = [];
  const stopIfAborted = async (): Promise<boolean> => {
    if (!signal?.aborted) {
      return false;
    }
    if (runtime?.isLocalError?.(signal.reason)) {
      throw signal.reason;
    }
    // Persist an aborted assistant outcome so session post-processing does not
    // compact or continue from the preceding toolUse message.
    const abortedMessage = withAssistantTurnTaint(
      createFailureMessage(
        config.model,
        signal.reason instanceof Error ? signal.reason : new Error("Agent run aborted"),
        true,
      ),
      turnTainted,
    );
    newMessages.push(abortedMessage);
    if (!turnOpen) {
      await emit({ type: "turn_start" });
      turnOpen = true;
    }
    await emit({ type: "message_start", message: abortedMessage });
    await emit({ type: "message_end", message: abortedMessage });
    await emit({ type: "turn_end", message: abortedMessage, toolResults: [] });
    turnOpen = false;
    if (!isTurnHandoffAbort(signal)) {
      await appendInterruptedTurnMessage(newMessages, emit);
    }
    await emit({ type: "agent_end", messages: newMessages });
    return true;
  };

  const commitPendingMessages = () => {
    const messagesToInject = pendingMessages;
    pendingMessages = [];
    return commitInputMessages(messagesToInject, state.context, config, emit, newMessages, () => {
      turnTainted = false;
      resetToolRepeatState(toolRepeatState);
    });
  };
  while (true) {
    let hasMoreToolCalls = firstTurn || !prepareContinuation;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (await stopIfAborted()) {
        return newMessages;
      }

      if (!firstTurn) {
        await emit({ type: "turn_start" });
        turnOpen = true;
      } else {
        firstTurn = false;
      }

      let injectedMessage = false;
      if (pendingMessages.length > 0) {
        injectedMessage = await commitPendingMessages();
        if (!injectedMessage && !hasMoreToolCalls) {
          // The entire drained batch was cancelled before transcript commit.
          // Re-evaluate the loop instead of issuing an empty provider continuation.
          continue;
        }
      }

      if (await stopIfAborted()) {
        return newMessages;
      }

      if (prepareContinuation) {
        const prepare = prepareContinuation;
        const update = await prepare(state.context);
        state.context = {
          ...state.context,
          systemPrompt: update.systemPrompt,
          tools: update.tools,
        };
        if (await stopIfAborted()) {
          return newMessages;
        }
      }

      if (beforeRequest) {
        const requestMessages = await beforeRequest(signal);
        if (requestMessages?.length) {
          state.context.messages.push(...requestMessages);
          newMessages.push(...requestMessages);
        }
        if (await stopIfAborted()) {
          return newMessages;
        }
      }

      // Preparation can admit input after the previous checkpoint. Keep one drained
      // batch per request so one-at-a-time steering retains its delivery order.
      if (!injectedMessage) {
        const steering = getSteeringAtCheckpoint(config);
        pendingMessages = Array.isArray(steering) ? steering : await steering;
        await commitPendingMessages();
        if (await stopIfAborted()) {
          return newMessages;
        }
      }

      const queuedContext =
        getInternalSteeringQueueObserver(config.getSteeringMessages)?.drainContext?.() ?? [];
      if (promptContext.length > 0 || queuedContext.length > 0) {
        pendingMessages = [...promptContext, ...queuedContext];
        promptContext = [];
        await commitPendingMessages();
        if (await stopIfAborted()) {
          return newMessages;
        }
      }

      const toolPlan: ToolPlanState = { executionStarted: false };
      const streamedSteering = createStreamedSteeringConfig(config);
      const streamed = await streamAgentResponse(
        state.context,
        config,
        signal,
        emit,
        newMessages,
        (assistantMessage, toolCalls, executionSignal, toolEmit, scheduling) =>
          executeToolCalls(
            state.context,
            assistantMessage,
            streamedSteering.config,
            executionSignal,
            toolEmit,
            toolRepeatState,
            toolPlan,
            toolCalls,
            scheduling,
            scheduling.hasUnobservedAsyncToolResults,
            runtime?.isLocalError,
          ),
        (message) => withAssistantTurnTaint(message, turnTainted),
        streamFn,
        runtime,
      );
      const { message } = streamed;

      const providerFailed = message.stopReason === "error" || message.stopReason === "aborted";
      const remainingToolCalls = providerFailed
        ? []
        : message.content.filter(
            (item): item is AgentToolCall =>
              item.type === "toolCall" &&
              !streamed.executedIds.has(item.id) &&
              (message.stopReason === "toolUse" || item.async === true),
          );
      const terminalToolBatch =
        remainingToolCalls.length > 0
          ? await executeToolCalls(
              state.context,
              message,
              streamedSteering.getTerminalConfig(),
              signal,
              emit,
              toolRepeatState,
              toolPlan,
              remainingToolCalls,
              undefined,
              streamed.executedIds.size > 0,
              runtime?.isLocalError,
            )
          : undefined;
      const batches = [...streamed.batches, ...(terminalToolBatch ? [terminalToolBatch] : [])];
      const executedToolBatch: ExecutedToolCallBatch | undefined = batches.length
        ? combineExecutedToolBatches(config, message, batches)
        : undefined;
      const toolResults = executedToolBatch?.messages ?? [];
      turnTainted ||= toolResults.some(toolResultTaintsTurn);
      hasMoreToolCalls =
        streamed.continuationRequired ||
        (message.stopReason === "stop" &&
          message.endTurn === false &&
          !executedToolBatch?.terminate) ||
        (executedToolBatch !== undefined && !executedToolBatch.terminate);
      pendingMessages = executedToolBatch?.steeringMessages ?? [];
      for (const result of terminalToolBatch?.messages ?? []) {
        state.context.messages.push(result);
        newMessages.push(result);
      }

      try {
        await emit({ type: "turn_end", message, toolResults });
      } catch (error) {
        throw mergeToolExecutionFailure(executedToolBatch?.fatal, error).error;
      }
      turnOpen = false;
      if (executedToolBatch?.fatal) {
        throw executedToolBatch.fatal.error;
      }
      if (message.stopReason === "aborted" && (!executedToolBatch?.repeatStop || signal?.aborted)) {
        if (signal?.aborted && runtime?.isLocalError?.(signal.reason)) {
          throw signal.reason;
        }
        if (signal?.aborted && !isTurnHandoffAbort(signal)) {
          await appendInterruptedTurnMessage(newMessages, emit);
        }
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }
      if (await stopIfAborted()) {
        return newMessages;
      }
      // Preserve accepted input for the normal commit checkpoint, which also resets the guard.
      const inputOverridesRepeatStop =
        executedToolBatch?.repeatStop !== undefined && pendingMessages.length > 0;
      if (executedToolBatch?.repeatStop && !inputOverridesRepeatStop) {
        const reason = formatToolRepeatStopMessage(executedToolBatch.repeatStop);
        const terminalMessage = {
          ...createFailureMessage(config.model, new Error(reason), false),
          errorCode: TOOL_REPEAT_LIMIT_CODE,
          content: [{ type: "text" as const, text: reason }],
        };
        state.context.messages.push(terminalMessage);
        newMessages.push(terminalMessage);
        await emit({ type: "turn_start" });
        turnOpen = true;
        await emit({ type: "message_start", message: terminalMessage });
        await emit({ type: "message_end", message: terminalMessage });
        await emit({ type: "turn_end", message: terminalMessage, toolResults: [] });
        turnOpen = false;
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }

      if (providerFailed && !inputOverridesRepeatStop) {
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }

      const nextTurnSnapshot = await config.prepareNextTurn?.({
        message,
        toolResults,
        context: state.context,
        newMessages,
      });
      prepareContinuation = nextTurnSnapshot?.prepareContinuation;
      if (nextTurnSnapshot) {
        state.context = nextTurnSnapshot.context ?? state.context;
        const nextModel = nextTurnSnapshot.model ?? config.model;
        const nextThinkingLevel = nextTurnSnapshot.thinkingLevel ?? config.thinkingLevel;
        const shouldResolveReasoning =
          nextTurnSnapshot.thinkingLevel !== undefined ||
          (nextTurnSnapshot.model !== undefined && nextThinkingLevel !== undefined);
        const nextReasoning =
          shouldResolveReasoning && nextThinkingLevel !== undefined
            ? resolveAgentReasoningOption(nextModel, nextThinkingLevel)
            : config.reasoning;
        config = Object.assign({}, config, {
          model: nextModel,
          thinkingLevel: nextThinkingLevel,
          reasoning: nextReasoning,
        });
      }
      if (await stopIfAborted()) {
        return newMessages;
      }

      if (pendingMessages.length === 0) {
        if (
          !nextTurnSnapshot?.stop &&
          (await config.shouldStopAfterTurn?.({
            message,
            toolResults,
            context: state.context,
            newMessages,
          }))
        ) {
          await emit({ type: "agent_end", messages: newMessages });
          return newMessages;
        }

        const steering = getSteeringAtCheckpoint(config);
        pendingMessages = Array.isArray(steering) ? steering : await steering;
      }
      if (await stopIfAborted()) {
        return newMessages;
      }
      if (nextTurnSnapshot?.stop) {
        // The old owner is about to close; commit accepted steering before re-admission.
        await commitPendingMessages();
        await emit({ type: "agent_end", messages: newMessages });
        return newMessages;
      }
    }

    pendingMessages = (await config.getFollowUpMessages?.()) || [];
    if (pendingMessages.length === 0) {
      // Recheck after the awaited follow-up drain so agent_end cannot strand an accepted steer.
      const finalSteering = getSteeringAtCheckpoint(config);
      pendingMessages = Array.isArray(finalSteering) ? finalSteering : await finalSteering;
    }
    if (pendingMessages.length === 0) {
      break;
    }
  }

  await emit({ type: "agent_end", messages: newMessages });
  return newMessages;
}

async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  toolRepeatState: ToolRepeatState,
  toolPlan: ToolPlanState,
  toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall"),
  scheduling?: AsyncToolBatchScheduling,
  hasUnobservedAsyncToolResults = false,
  isLocalError?: AgentCoreStreamRuntimeDeps["isLocalError"],
): Promise<ExecutedToolCallBatch> {
  if (config.completesToolTurn) {
    const inputScope = getInternalToolTurnInputScope(config.completesToolTurn);
    for (const toolCall of toolCalls) {
      captureAgentToolInputScope({ assistantMessage, toolCall }, inputScope);
    }
  }
  const batch: ToolBatchContext = {
    currentContext,
    assistantMessage,
    config,
    signal,
    emit,
    resolved: new Map(),
    onParallelStarted: scheduling?.onParallelStarted,
    onTerminalLoop: scheduling?.onTerminalLoop,
    hasUnobservedAsyncToolResults,
    isLocalError,
    toolPlan,
    noProgress:
      config.toolRepeatGuard !== false
        ? (toolRepeatState.noProgress ??= { history: [], recoveryUsed: false })
        : undefined,
    nestedProgressCalls: new Set(),
    waitForPrevious: scheduling?.waitForPrevious,
  };
  if (config.toolRepeatGuard !== false) {
    // Count in assistant order before anything runs, so a capped batch never starts.
    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        break;
      }
      const resolution = await resolveToolCallTool(batch, toolCall);
      const verdict = observeToolRepeat(
        toolRepeatState,
        toolCall,
        resolution.kind === "resolved" ? resolution.tool : undefined,
      );
      if (verdict) {
        config.onToolRepeat?.(verdict);
      }
      if (verdict?.kind === "stop") {
        return await completeToolRepeatStopBatch(batch, toolCalls, verdict);
      }
      if (verdict) {
        (batch.repeatNotes ??= []).push(verdict);
      }
    }
  }
  let hasSequentialToolCall = false;
  if (config.toolExecution !== "sequential") {
    for (const toolCall of toolCalls) {
      if (signal?.aborted) {
        break;
      }
      const resolution = await resolveToolCallTool(batch, toolCall);
      if (resolution.kind === "resolved" && resolution.tool?.executionMode === "sequential") {
        hasSequentialToolCall = true;
        break;
      }
    }
  }
  const sequential = config.toolExecution === "sequential" || hasSequentialToolCall;
  if (sequential && scheduling) {
    await scheduling.waitForPrevious();
  }
  return executeToolCallGroups(batch, toolCalls, sequential);
}

/** Every call in the capped batch reports the stop; none of them runs. */
async function completeToolRepeatStopBatch(
  batch: ToolBatchContext,
  toolCalls: AgentToolCall[],
  verdict: ToolRepeatVerdict,
): Promise<ExecutedToolCallBatch> {
  // Stop sampling now; results still publish after earlier streamed work.
  batch.onTerminalLoop?.();
  await batch.waitForPrevious?.();
  const messages: ToolResultMessage[] = [];
  for (const toolCall of toolCalls) {
    const hideFromChannelProgress = hidesToolCallFromChannelProgress(batch, toolCall);
    await emitToolExecutionStart(batch, toolCall, hideFromChannelProgress);
    const finalized = await finalizeToolCallOutcome(
      batch,
      {
        toolCall,
        result: createToolRepeatStopResult(verdict),
        isError: true,
        executionStarted: false,
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
      toolCall.arguments,
    );
    await emitToolExecutionEnd(finalized, batch);
    messages.push(await emitToolResultMessage(finalized, batch.emit));
  }
  return {
    messages,
    steeringMessages: [],
    terminalToolCallIds: toolCalls.map((toolCall) => toolCall.id),
    terminate: true,
    repeatStop: verdict,
  };
}

export type ToolBatchContext = {
  currentContext: AgentContext;
  assistantMessage: AssistantMessage;
  config: AgentLoopConfig;
  signal: AbortSignal | undefined;
  emit: AgentEventSink;
  resolved: Map<AgentToolCall, ResolvedToolCallOutcome>;
  repeatNotes?: ToolRepeatVerdict[];
  noProgress?: ToolNoProgressState;
  noProgressStop?: ToolRepeatVerdict;
  noProgressReported?: ToolRepeatVerdict;
  nestedProgressCalls: Set<AgentToolCall>;
  onParallelStarted?: () => void;
  onTerminalLoop?: () => void;
  hasUnobservedAsyncToolResults: boolean;
  toolPlan: ToolPlanState;
  waitForPrevious?: () => Promise<void>;
  isLocalError?: AgentCoreStreamRuntimeDeps["isLocalError"];
};

async function executeToolCallGroups(
  batch: ToolBatchContext,
  toolCalls: AgentToolCall[],
  sequential: boolean,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];
  let steeringMessages: AgentMessage[] = [];
  let cursor = 0;
  let fatal: ExecutedToolCallBatch["fatal"];

  while (cursor < toolCalls.length) {
    if (sequential && batch.toolPlan.executionStarted && !batch.signal?.aborted) {
      const steering = getSteeringAtCheckpoint(batch.config);
      steeringMessages = Array.isArray(steering) ? steering : await steering;
    }
    if (steeringMessages.length > 0) {
      break;
    }

    const entries: FinalizedToolCallEntry[] = [];
    let started: StartedToolCall[] = [];
    let thrown: ExecutedToolCallBatch["fatal"];
    const ordered: Array<FinalizedToolCallOutcome | undefined> = [];
    const settle = async (
      index: number,
      entry: ReadyPreparedToolCall,
      outcome: ExecutedToolCallOutcome,
    ) => {
      const finalized = await completeStartedToolCall(batch, entry, outcome, sequential);
      if (
        batch.noProgress &&
        finalized.executionStarted &&
        !batch.nestedProgressCalls.has(entry.toolCall)
      ) {
        recordToolProgress(
          batch.noProgress,
          { ...entry.toolCall, arguments: entry.execution.args },
          toolProgressOutcome(finalized.result, finalized.isError),
        );
      }
      ordered[index] = finalized;
      return finalized;
    };
    try {
      // Sequential groups commit before preparing the next call. Parallel groups
      // prepare together, then commit in source order after their started work settles.
      try {
        while (cursor < toolCalls.length) {
          const toolCall = toolCalls[cursor++];
          if (!toolCall) {
            continue;
          }
          const entry = await prepareToolCallEntry(batch, toolCall);
          entries.push(entry);
          if (!("kind" in entry)) {
            await emitToolExecutionEnd(entry, batch);
          }
          if (sequential || batch.signal?.aborted) {
            break;
          }
        }
      } catch (error) {
        fatal = mergeToolExecutionFailure(fatal, error);
        throw error;
      }

      if (batch.noProgressReported) {
        // A later prepared call can confirm the loop before any ready sibling starts.
        for (const [index, entry] of entries.entries()) {
          if (!("kind" in entry)) {
            continue;
          }
          entry.execution.dispose();
          const blocked = await finalizeNoProgressToolCall(
            batch,
            entry.toolCall,
            entry.execution.args,
            batch.noProgressReported,
          );
          entries[index] = blocked;
          await emitToolExecutionEnd(blocked, batch);
        }
      }
      const hasReady = entries.some((entry) => "kind" in entry);
      if (sequential && batch.toolPlan.executionStarted && hasReady && !batch.signal?.aborted) {
        const steering = getSteeringAtCheckpoint(batch.config);
        steeringMessages = Array.isArray(steering) ? steering : await steering;
      }
      for (const [index, entry] of entries.entries()) {
        ordered[index] = "kind" in entry ? undefined : entry;
      }

      const launched =
        steeringMessages.length > 0
          ? undefined
          : await launchParallelToolCalls(entries, batch.toolPlan);
      fatal = launched?.rejected ? { error: launched.rejected.error } : undefined;
      started = launched?.started ?? [];
      const startedIndices = new Set(started.map(({ index }) => index));
      // Streamed batches serialize admission until source execution begins.
      // Parallel bodies may overlap; exclusive tools retain the gate until finalization.
      if (!sequential && launched?.started.length && !launched.rejected) {
        batch.onParallelStarted?.();
      }
      for (const { index, entry, outcome } of launched?.completed ?? []) {
        await settle(index, entry, outcome);
      }
      const skippedIndex =
        steeringMessages.length > 0 ? 0 : (launched?.rejected?.index ?? entries.length);
      if (steeringMessages.length > 0) {
        for (const entry of entries) {
          if ("kind" in entry) {
            entry.execution.dispose();
          }
        }
      }
      for (let index = skippedIndex; index < entries.length; index++) {
        const entry = entries[index];
        if (!entry || !("kind" in entry) || startedIndices.has(index) || ordered[index]) {
          continue;
        }
        // A sequential admission failure retains preparation until its synthetic
        // transcript commits; parallel and steering skips release before outcome hooks.
        if (!sequential) {
          entry.execution.dispose();
        }
        ordered[index] = await completeUnstartedToolCall(batch, entry.toolCall, {
          reason: fatal ? "admission" : "steering",
          args: entry.execution.args,
          startEmitted: true,
          hideFromChannelProgress: hidesToolCallFromChannelProgress(batch, entry.toolCall),
        });
      }
      if (launched) {
        // A later admission rejection cannot settle the batch before its active prefix.
        const settled = await Promise.allSettled(
          started.map(async ({ index, entry, outcome }) => settle(index, entry, await outcome)),
        );
        started = [];
        fatal = mergeRejectedToolOutcomes(fatal, settled);
      }
      try {
        for (const finalized of ordered) {
          if (finalized) {
            messages.push(await emitToolResultMessage(finalized, batch.emit));
            finalizedCalls.push(finalized);
          }
        }
      } catch (error) {
        fatal = mergeToolExecutionFailure(fatal, error);
        throw error;
      }
    } catch (error) {
      thrown = mergeToolExecutionFailure(fatal, error);
    } finally {
      // A local persistence failure cannot release another accepted tool while it still runs.
      thrown =
        (await drainToolCallGroup(
          started,
          entries,
          thrown ?? fatal,
          async ({ index, entry }, outcome) => {
            const finalized = await settle(index, entry, outcome);
            messages.push(await emitToolResultMessage(finalized, batch.emit));
            finalizedCalls.push(finalized);
          },
        )) ?? thrown;
    }
    if (thrown) {
      throw thrown.error;
    }
    if (steeringMessages.length > 0 || fatal || batch.signal?.aborted || batch.noProgressStop) {
      break;
    }
  }

  // Steering accepted while tools ran must outrank the stop hook in either mode.
  if (!fatal && !batch.signal?.aborted && steeringMessages.length === 0) {
    const steering = getSteeringAtCheckpoint(batch.config);
    steeringMessages = Array.isArray(steering) ? steering : await steering;
  }
  const skippedReason = fatal ? "admission" : steeringMessages.length > 0 ? "steering" : undefined;
  try {
    for (; cursor < toolCalls.length; cursor++) {
      const toolCall = toolCalls[cursor];
      if (!toolCall) {
        continue;
      }
      const finalized = await completeUnstartedToolCall(batch, toolCall, {
        reason: skippedReason,
        hideFromChannelProgress: hidesToolCallFromChannelProgress(batch, toolCall),
      });
      messages.push(await emitToolResultMessage(finalized, batch.emit));
      finalizedCalls.push(finalized);
    }
  } catch (error) {
    throw mergeToolExecutionFailure(fatal, error).error;
  }

  return {
    messages,
    steeringMessages,
    ...resolveToolBatchTermination(finalizedCalls),
    ...(batch.noProgressStop ? { terminate: true, repeatStop: batch.noProgressStop } : {}),
    ...(fatal ? { fatal } : {}),
  };
}

type ValidatedToolCallOutcome = PreparedToolCall | ImmediateToolCallOutcome;

function reportNoProgressVerdict(batch: ToolBatchContext, verdict: ToolRepeatVerdict): void {
  if (batch.noProgressReported !== verdict) {
    batch.noProgressReported = verdict;
    batch.config.onToolRepeat?.(verdict);
  }
  if (verdict.kind === "stop" && batch.noProgressStop !== verdict) {
    batch.noProgressStop = verdict;
    batch.onTerminalLoop?.();
  }
}

async function finalizeNoProgressToolCall(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
  args: unknown,
  verdict: ToolRepeatVerdict,
): Promise<FinalizedToolCallOutcome> {
  const hideFromChannelProgress = hidesToolCallFromChannelProgress(batch, toolCall);
  return await finalizeToolCallOutcome(
    batch,
    {
      toolCall,
      result: createToolNoProgressResult(verdict),
      isError: true,
      executionStarted: false,
      ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
    },
    args,
  );
}

async function prepareToolCallEntry(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<FinalizedToolCallEntry> {
  const hideFromChannelProgress = hidesToolCallFromChannelProgress(batch, toolCall);
  await emitToolExecutionStart(batch, toolCall, hideFromChannelProgress);
  const preparation = await prepareToolCall(batch, toolCall);
  if (preparation.kind === "immediate") {
    return await finalizeToolCallOutcome(
      batch,
      {
        toolCall,
        result: preparation.result,
        isError: preparation.isError,
        executionStarted: false,
        ...(preparation.errorKind ? { errorKind: preparation.errorKind } : {}),
        ...(hideFromChannelProgress ? { hideFromChannelProgress: true } : {}),
      },
      toolCall.arguments,
    );
  }
  const inputQueue = getInternalSteeringQueueObserver(batch.config.getSteeringMessages);
  const subscribeInput = inputQueue?.subscribe;
  const progressState = batch.noProgress;
  const execution = await prepareToolCallExecution(
    preparation,
    {
      assistantMessage: batch.assistantMessage,
      pendingInput:
        inputQueue && subscribeInput
          ? { hasPending: () => inputQueue.peek().length > 0, subscribe: subscribeInput }
          : undefined,
      toolCall: preparation.toolCall,
      ...(progressState
        ? {
            toolProgress: {
              before: (nestedCall, nestedTool) => {
                batch.nestedProgressCalls.add(toolCall);
                const verdict = observeToolNoProgress(
                  progressState,
                  nestedCall,
                  nestedTool,
                  resolveAgentAssistantTurnId(batch.assistantMessage) ?? batch.assistantMessage,
                );
                if (verdict) {
                  reportNoProgressVerdict(batch, verdict);
                }
                return verdict;
              },
              completed: (nestedCall, outcome) =>
                recordToolProgress(progressState, nestedCall, outcome),
            },
          }
        : {}),
      hasUnobservedAsyncToolResults:
        batch.hasUnobservedAsyncToolResults ||
        batch.assistantMessage.content
          .slice(0, batch.assistantMessage.content.indexOf(toolCall))
          .some((item) => item.type === "toolCall" && item.async === true),
    },
    batch.signal,
    batch.emit,
    batch.isLocalError,
    batch.config.toolInterruptions,
  );
  if (execution.kind === "ready" && batch.noProgress) {
    const verdict = observeToolNoProgress(
      batch.noProgress,
      { ...toolCall, arguments: execution.args },
      preparation.tool,
      resolveAgentAssistantTurnId(batch.assistantMessage) ?? batch.assistantMessage,
    );
    if (verdict) {
      execution.dispose();
      reportNoProgressVerdict(batch, verdict);
      return await finalizeNoProgressToolCall(batch, toolCall, execution.args, verdict);
    }
  }
  return execution.kind === "immediate"
    ? await finalizeExecutedToolCall(batch, preparation, execution.outcome, preparation.args)
    : { ...preparation, execution };
}

async function resolveToolCallTool(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<ResolvedToolCallOutcome> {
  const cached = batch.resolved.get(toolCall);
  if (cached) {
    return cached;
  }
  let resolution: ResolvedToolCallOutcome;
  try {
    let tool = batch.currentContext.tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
      const resolvedTool = await batch.config.resolveDeferredTool?.(
        {
          assistantMessage: batch.assistantMessage,
          toolCall,
          context: batch.currentContext,
        },
        batch.signal,
      );
      // Keep execution and lifecycle/audit identity aligned with the original model call.
      if (resolvedTool && resolvedTool.name !== toolCall.name) {
        throw new Error(
          `Deferred tool resolver returned "${resolvedTool.name}" for requested "${toolCall.name}"`,
        );
      }
      tool = resolvedTool;
      if (tool) {
        // Make the recovered tool visible to later provider continuations in this run.
        batch.currentContext.tools = [...(batch.currentContext.tools ?? []), tool];
      }
    }
    resolution = { kind: "resolved", ...(tool ? { tool } : {}) };
  } catch (error) {
    if (batch.isLocalError?.(error)) {
      throw error;
    }
    resolution = { kind: "error", error };
  }
  batch.resolved.set(toolCall, resolution);
  return resolution;
}

async function prepareToolCall(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  if (batch.signal?.aborted) {
    return immediateToolCallError("Operation aborted");
  }
  const validation = await validateToolCall(batch, toolCall);
  if (validation.kind === "immediate") {
    return validation;
  }
  const { args: validatedArgs } = validation;

  try {
    if (batch.config.beforeToolCall) {
      const beforeResult = await batch.config.beforeToolCall(
        {
          assistantMessage: batch.assistantMessage,
          toolCall,
          args: validatedArgs,
          context: batch.currentContext,
        },
        batch.signal,
      );
      if (batch.signal?.aborted) {
        return immediateToolCallError("Operation aborted");
      }
      if (beforeResult?.block) {
        return immediateToolCallError(beforeResult.reason || "Tool execution was blocked");
      }
    }
    if (batch.signal?.aborted) {
      return immediateToolCallError("Operation aborted");
    }
    return validation;
  } catch (error) {
    if (batch.isLocalError?.(error)) {
      throw error;
    }
    return immediateToolCallError(coerceErrorMessage(error));
  }
}

async function validateToolCall(
  batch: ToolBatchContext,
  toolCall: AgentToolCall,
): Promise<ValidatedToolCallOutcome> {
  const resolution = await resolveToolCallTool(batch, toolCall);
  if (resolution.kind === "error") {
    return immediateToolCallError(
      batch.signal?.aborted ? "Operation aborted" : coerceErrorMessage(resolution.error),
    );
  }
  const tool = resolution.tool;
  if (!tool) {
    return immediateToolCallError(`Tool ${toolCall.name} not found`);
  }

  return prepareResolvedToolCall(tool, toolCall);
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
