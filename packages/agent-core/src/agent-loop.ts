// Keep the runtime class on the package specifier so built agent-core shares
// constructor identity with @openclaw/llm-core; source types keep SDK d.ts bundled.
import { EventStream as LlmEventStream } from "@openclaw/llm-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  EventStream,
  ToolResultMessage,
} from "../../llm-core/src/index.js";
import type { EventStream as SourceEventStream } from "../../llm-core/src/index.js";
import { resolveAgentReasoningOption } from "./reasoning.js";
import { type AgentCoreStreamRuntimeDeps, resolveAgentCoreStreamFn } from "./runtime-deps.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolCall,
  AgentToolResult,
  StreamFn,
} from "./types.js";
import {
  formatToolNotFoundMessage,
  resolveToolByName,
  resolveToolNameCandidates,
  validateToolArguments,
} from "./validation.js";

/** Callback used by synchronous loop runners to publish agent lifecycle events. */
export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

const EMPTY_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const EventStreamConstructor: typeof SourceEventStream = LlmEventStream;

type AssistantMessageUpdateEvent = Extract<
  AssistantMessageEvent,
  {
    type:
      | "text_start"
      | "text_delta"
      | "text_end"
      | "thinking_start"
      | "thinking_delta"
      | "thinking_end"
      | "toolcall_start"
      | "toolcall_delta"
      | "toolcall_end";
  }
>;

function appendTextDeltaToAssistantMessage(
  message: AssistantMessage,
  contentIndex: number,
  delta: string,
): AssistantMessage {
  const content = [...message.content];
  const currentContent = content[contentIndex];
  content[contentIndex] =
    currentContent?.type === "text"
      ? { ...currentContent, text: currentContent.text + delta }
      : { type: "text", text: delta };
  return { ...message, content };
}

function resolveAssistantMessageUpdate(
  event: AssistantMessageUpdateEvent,
  currentMessage: AssistantMessage,
): AssistantMessage {
  if ("partial" in event && event.partial) {
    return event.partial;
  }
  if (event.type === "text_delta") {
    return appendTextDeltaToAssistantMessage(currentMessage, event.contentIndex, event.delta);
  }
  return currentMessage;
}

function removeNonExecutableToolCalls(message: AssistantMessage): AssistantMessage {
  if (message.stopReason === "toolUse") {
    return message;
  }
  const content = message.content.filter((item) => item.type !== "toolCall");
  return content.length === message.content.length ? message : { ...message, content };
}

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();

  void runAgentLoop(
    prompts,
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
    runtime,
  )
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      pushLoopFailure(stream, config, error, signal?.aborted === true);
    });

  return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const stream = createAgentStream();

  void runAgentLoopContinue(
    context,
    config,
    async (event) => {
      stream.push(event);
    },
    signal,
    streamFn,
    runtime,
  )
    .then((messages) => {
      stream.end(messages);
    })
    .catch((error: unknown) => {
      pushLoopFailure(stream, config, error, signal?.aborted === true);
    });

  return stream;
}

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
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = {
    ...context,
    messages: [...context.messages, ...prompts],
  };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const prompt of prompts) {
    await emit({ type: "message_start", message: prompt });
    await emit({ type: "message_end", message: prompt });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn, runtime);
  return newMessages;
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
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }

  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn, runtime);
  return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStreamConstructor<AgentEvent, AgentMessage[]>(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

function createLoopFailureMessage(
  config: AgentLoopConfig,
  error: unknown,
  aborted: boolean,
): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: "" }],
    api: config.model.api,
    provider: config.model.provider,
    model: config.model.id,
    usage: EMPTY_USAGE,
    stopReason: aborted ? "aborted" : "error",
    errorMessage: error instanceof Error ? error.message : String(error),
    timestamp: Date.now(),
  };
}

function pushLoopFailure(
  stream: EventStream<AgentEvent, AgentMessage[]>,
  config: AgentLoopConfig,
  error: unknown,
  aborted: boolean,
): void {
  const failureMessage = createLoopFailureMessage(config, error, aborted);
  stream.push({ type: "message_start", message: failureMessage });
  stream.push({ type: "message_end", message: failureMessage });
  stream.push({ type: "turn_end", message: failureMessage, toolResults: [] });
  stream.push({ type: "agent_end", messages: [failureMessage] });
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
  initialContext: AgentContext,
  newMessages: AgentMessage[],
  initialConfig: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<void> {
  let currentContext = initialContext;
  let config = initialConfig;
  let firstTurn = true;
  let turnOpen = true;
  // Check for steering messages at start (user may have typed while waiting)
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];
  const stopIfAborted = async (): Promise<boolean> => {
    if (!signal?.aborted) {
      return false;
    }
    // Persist an aborted assistant outcome so session post-processing does not
    // compact or continue from the preceding toolUse message.
    const abortedMessage = createLoopFailureMessage(
      config,
      signal.reason instanceof Error ? signal.reason : new Error("Agent run aborted"),
      true,
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
    await emit({ type: "agent_end", messages: newMessages });
    return true;
  };

  // Outer loop: continues when queued follow-up messages arrive after agent would stop
  while (true) {
    let hasMoreToolCalls = true;

    // Inner loop: process tool calls and steering messages
    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (await stopIfAborted()) {
        return;
      }

      if (!firstTurn) {
        await emit({ type: "turn_start" });
        turnOpen = true;
      } else {
        firstTurn = false;
      }

      // Process pending messages (inject before next assistant response)
      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          await emit({ type: "message_start", message });
          await emit({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
      }

      if (await stopIfAborted()) {
        return;
      }

      // Stream assistant response
      const message = await streamAssistantResponse(
        currentContext,
        config,
        signal,
        emit,
        streamFn,
        runtime,
      );
      newMessages.push(message);

      if (message.stopReason === "error" || message.stopReason === "aborted") {
        await emit({ type: "turn_end", message, toolResults: [] });
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      // Only completed toolUse turns dispatch; length/stop can carry partial stream blocks.
      const toolCalls = message.content.filter((c) => c.type === "toolCall");

      const toolResults: ToolResultMessage[] = [];
      hasMoreToolCalls = false;
      if (message.stopReason === "toolUse" && toolCalls.length > 0) {
        const executedToolBatch = await executeToolCalls(
          currentContext,
          message,
          config,
          signal,
          emit,
        );
        toolResults.push(...executedToolBatch.messages);
        hasMoreToolCalls = !executedToolBatch.terminate;

        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      await emit({ type: "turn_end", message, toolResults });
      turnOpen = false;
      if (await stopIfAborted()) {
        return;
      }

      const nextTurnContext = {
        message,
        toolResults,
        context: currentContext,
        newMessages,
      };
      const nextTurnSnapshot = await config.prepareNextTurn?.(nextTurnContext);
      if (nextTurnSnapshot) {
        currentContext = nextTurnSnapshot.context ?? currentContext;
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
        return;
      }

      if (
        await config.shouldStopAfterTurn?.({
          message,
          toolResults,
          context: currentContext,
          newMessages,
        })
      ) {
        await emit({ type: "agent_end", messages: newMessages });
        return;
      }

      pendingMessages = (await config.getSteeringMessages?.()) || [];
      if (await stopIfAborted()) {
        return;
      }
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) || [];
    if (followUpMessages.length > 0) {
      // Follow-up messages arrive after a turn would otherwise end; route them through the
      // same pending-message path so event ordering matches steering messages.
      pendingMessages = followUpMessages;
      continue;
    }

    // No more messages, exit
    break;
  }

  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Stream an assistant response from the LLM.
 * This is where AgentMessage[] gets transformed to Message[] for the LLM.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFn?: StreamFn,
  runtime?: AgentCoreStreamRuntimeDeps,
): Promise<AssistantMessage> {
  // Apply context transform if configured (AgentMessage[] → AgentMessage[])
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  // Convert to LLM-compatible messages (AgentMessage[] → Message[])
  const llmMessages = await config.convertToLlm(messages);

  // Build LLM context
  const llmContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = resolveAgentCoreStreamFn(runtime, streamFn);

  // Resolve API key (important for expiring tokens)
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const response = await streamFunction(config.model, llmContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start": {
        const message = event.partial;
        partialMessage = message;
        context.messages.push(message);
        addedPartial = true;
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
          const message = resolveAssistantMessageUpdate(event, partialMessage);
          partialMessage = message;
          context.messages[context.messages.length - 1] = message;
          await emit({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...message },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = removeNonExecutableToolCalls(await response.result());
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          await emit({ type: "message_start", message: { ...finalMessage } });
        }
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  const finalMessage = removeNonExecutableToolCalls(await response.result());
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  const resolvedToolCalls = new Map<AgentToolCall, ResolvedToolCallOutcome>();
  let hasSequentialToolCall = false;
  if (config.toolExecution !== "sequential") {
    for (const toolCall of toolCalls) {
      const resolution = await resolveToolCallTool(
        currentContext,
        assistantMessage,
        toolCall,
        config,
        signal,
        resolvedToolCalls,
      );
      if (resolution.kind === "resolved" && resolution.tool?.executionMode === "sequential") {
        hasSequentialToolCall = true;
        break;
      }
      if (signal?.aborted) {
        break;
      }
    }
  }
  if (config.toolExecution === "sequential" || hasSequentialToolCall) {
    return executeToolCallsSequential(
      currentContext,
      assistantMessage,
      toolCalls,
      resolvedToolCalls,
      config,
      signal,
      emit,
    );
  }
  return executeToolCallsParallel(
    currentContext,
    assistantMessage,
    toolCalls,
    resolvedToolCalls,
    config,
    signal,
    emit,
  );
}

type ExecutedToolCallBatch = {
  messages: ToolResultMessage[];
  terminate: boolean;
};

type ResolvedToolCallOutcome =
  | { kind: "resolved"; tool?: AgentTool }
  | { kind: "error"; error: unknown };

function canonicalizeToolCall(toolCall: AgentToolCall, tool: AgentTool): AgentToolCall {
  if (toolCall.name === tool.name) {
    return toolCall;
  }
  return {
    ...toolCall,
    name: tool.name,
  };
}

function resolveToolCallForEvent(
  toolCall: AgentToolCall,
  resolution: ResolvedToolCallOutcome,
): AgentToolCall {
  return resolution.kind === "resolved" && resolution.tool
    ? canonicalizeToolCall(toolCall, resolution.tool)
    : toolCall;
}

async function executeToolCallsSequential(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallOutcome[] = [];
  const messages: ToolResultMessage[] = [];

  for (const toolCall of toolCalls) {
    const startResolution = await resolveToolCallTool(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      resolvedToolCalls,
    );
    const startToolCall = resolveToolCallForEvent(toolCall, startResolution);
    await emit({
      type: "tool_execution_start",
      toolCallId: startToolCall.id,
      toolName: startToolCall.name,
      args: startToolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      resolvedToolCalls,
    );
    let finalized: FinalizedToolCallOutcome;
    if (preparation.kind === "immediate") {
      finalized = {
        toolCall: preparation.toolCall,
        result: preparation.result,
        isError: preparation.isError,
        executionStarted: false,
      };
    } else {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
    }

    await emitToolExecutionEnd(finalized, emit);
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    finalizedCalls.push(finalized);
    messages.push(toolResultMessage);

    if (signal?.aborted) {
      break;
    }
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(finalizedCalls),
  };
}

async function executeToolCallsParallel(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCalls: AgentToolCall[],
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
  const finalizedCalls: FinalizedToolCallEntry[] = [];

  for (const toolCall of toolCalls) {
    const startResolution = await resolveToolCallTool(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      resolvedToolCalls,
    );
    const startToolCall = resolveToolCallForEvent(toolCall, startResolution);
    await emit({
      type: "tool_execution_start",
      toolCallId: startToolCall.id,
      toolName: startToolCall.name,
      args: startToolCall.arguments,
    });

    const preparation = await prepareToolCall(
      currentContext,
      assistantMessage,
      toolCall,
      config,
      signal,
      resolvedToolCalls,
    );
    if (preparation.kind === "immediate") {
      const finalized = {
        toolCall: preparation.toolCall,
        result: preparation.result,
        isError: preparation.isError,
        executionStarted: false,
      } satisfies FinalizedToolCallOutcome;
      await emitToolExecutionEnd(finalized, emit);
      finalizedCalls.push(finalized);
      if (signal?.aborted) {
        break;
      }
      continue;
    }

    finalizedCalls.push(async () => {
      const executed = await executePreparedToolCall(preparation, signal, emit);
      const finalized = await finalizeExecutedToolCall(
        currentContext,
        assistantMessage,
        preparation,
        executed,
        config,
        signal,
      );
      await emitToolExecutionEnd(finalized, emit);
      return finalized;
    });
    if (signal?.aborted) {
      break;
    }
  }

  const orderedFinalizedCalls = await Promise.all(
    finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
  );
  const messages: ToolResultMessage[] = [];
  for (const finalized of orderedFinalizedCalls) {
    const toolResultMessage = createToolResultMessage(finalized);
    await emitToolResultMessage(toolResultMessage, emit);
    messages.push(toolResultMessage);
  }

  return {
    messages,
    terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
  };
}

type PreparedToolCall = {
  kind: "prepared";
  toolCall: AgentToolCall;
  tool: AgentTool;
  args: unknown;
};

type ImmediateToolCallOutcome = {
  kind: "immediate";
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
};

type ExecutedToolCallOutcome = {
  result: AgentToolResult<unknown>;
  isError: boolean;
};

type FinalizedToolCallOutcome = {
  toolCall: AgentToolCall;
  result: AgentToolResult<unknown>;
  isError: boolean;
  executionStarted: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
  return (
    finalizedCalls.length > 0 &&
    finalizedCalls.every((finalized) => finalized.result.terminate === true)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeToolNameForAliasCheck(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function readStringArg(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value;
    }
  }
  return undefined;
}

function prepareToolAliasArguments(
  tool: AgentTool,
  sourceToolName: string,
  args: unknown,
): unknown {
  if (
    tool.name !== "sessions_spawn" ||
    !["agent", "task"].includes(normalizeToolNameForAliasCheck(sourceToolName)) ||
    !isRecord(args)
  ) {
    return args;
  }

  const prepared: Record<string, unknown> = { ...args };
  const task = readStringArg(prepared, "task", "prompt", "message", "input", "query");
  if (task && !readStringArg(prepared, "task")) {
    prepared.task = task;
  }

  const agentId = readStringArg(
    prepared,
    "agentId",
    "agent_id",
    "agent",
    "subagentType",
    "subagent_type",
  );
  if (agentId && !readStringArg(prepared, "agentId")) {
    prepared.agentId = agentId;
  }

  const label = readStringArg(prepared, "label", "description");
  if (label && !readStringArg(prepared, "label")) {
    prepared.label = label;
  }

  delete prepared.prompt;
  delete prepared.message;
  delete prepared.input;
  delete prepared.query;
  delete prepared.agent;
  delete prepared.agent_id;
  delete prepared.subagentType;
  delete prepared.subagent_type;
  delete prepared.description;

  return prepared;
}

function prepareToolCallArguments(
  tool: AgentTool,
  toolCall: AgentToolCall,
  sourceToolName = toolCall.name,
): AgentToolCall {
  const toolPreparedArguments = tool.prepareArguments
    ? tool.prepareArguments(toolCall.arguments)
    : toolCall.arguments;
  const preparedArguments = prepareToolAliasArguments(tool, sourceToolName, toolPreparedArguments);
  if (preparedArguments === toolCall.arguments) {
    return toolCall;
  }
  return {
    ...toolCall,
    arguments: preparedArguments as Record<string, unknown>,
  };
}

async function resolveToolCallTool(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  resolvedToolCalls?: Map<AgentToolCall, ResolvedToolCallOutcome>,
): Promise<ResolvedToolCallOutcome> {
  const cached = resolvedToolCalls?.get(toolCall);
  if (cached) {
    return cached;
  }
  let resolution: ResolvedToolCallOutcome;
  try {
    let tool = currentContext.tools
      ? resolveToolByName(currentContext.tools, toolCall.name)
      : undefined;
    if (!tool) {
      let resolvedTool: AgentTool | undefined;
      let resolvedCandidate = toolCall.name;
      for (const candidateName of resolveToolNameCandidates(toolCall.name, {
        aliasesFirst: true,
        includeNormalized: false,
      })) {
        const candidateToolCall =
          candidateName === toolCall.name ? toolCall : { ...toolCall, name: candidateName };
        resolvedTool = await config.resolveDeferredTool?.(
          {
            assistantMessage,
            toolCall: candidateToolCall,
            context: currentContext,
          },
          signal,
        );
        if (resolvedTool) {
          resolvedCandidate = candidateName;
          break;
        }
      }
      // Keep execution and lifecycle/audit identity aligned with the original model call.
      if (resolvedTool && resolveToolByName([resolvedTool], resolvedCandidate) !== resolvedTool) {
        throw new Error(
          `Deferred tool resolver returned "${resolvedTool.name}" for requested "${toolCall.name}"`,
        );
      }
      tool = resolvedTool;
      if (tool) {
        // Make the recovered tool visible to later provider continuations in this run.
        currentContext.tools = [...(currentContext.tools ?? []), tool];
      }
    }
    resolution = { kind: "resolved", ...(tool ? { tool } : {}) };
  } catch (error) {
    resolution = { kind: "error", error };
  }
  resolvedToolCalls?.set(toolCall, resolution);
  return resolution;
}

async function prepareToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  toolCall: AgentToolCall,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  resolvedToolCalls: Map<AgentToolCall, ResolvedToolCallOutcome>,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
  const resolution = await resolveToolCallTool(
    currentContext,
    assistantMessage,
    toolCall,
    config,
    signal,
    resolvedToolCalls,
  );
  if (resolution.kind === "error") {
    return {
      kind: "immediate",
      toolCall,
      result: createErrorToolResult(
        signal?.aborted
          ? "Operation aborted"
          : resolution.error instanceof Error
            ? resolution.error.message
            : String(resolution.error),
      ),
      isError: true,
    };
  }
  const tool = resolution.tool;
  if (!tool) {
    return {
      kind: "immediate",
      toolCall,
      result: createErrorToolResult(formatToolNotFoundMessage(toolCall.name, currentContext.tools)),
      isError: true,
    };
  }

  const resolvedToolCall = canonicalizeToolCall(toolCall, tool);
  try {
    const preparedToolCall = prepareToolCallArguments(tool, resolvedToolCall, toolCall.name);
    const validatedArgs = validateToolArguments(tool, preparedToolCall);
    if (config.beforeToolCall) {
      const beforeResult = await config.beforeToolCall(
        {
          assistantMessage,
          toolCall: preparedToolCall,
          args: validatedArgs,
          context: currentContext,
        },
        signal,
      );
      if (signal?.aborted) {
        return {
          kind: "immediate",
          toolCall: preparedToolCall,
          result: createErrorToolResult("Operation aborted"),
          isError: true,
        };
      }
      if (beforeResult?.block) {
        return {
          kind: "immediate",
          toolCall: preparedToolCall,
          result: createErrorToolResult(beforeResult.reason || "Tool execution was blocked"),
          isError: true,
        };
      }
    }
    if (signal?.aborted) {
      return {
        kind: "immediate",
        toolCall: resolvedToolCall,
        result: createErrorToolResult("Operation aborted"),
        isError: true,
      };
    }
    return {
      kind: "prepared",
      toolCall: preparedToolCall,
      tool,
      args: validatedArgs,
    };
  } catch (error) {
    return {
      kind: "immediate",
      toolCall: resolvedToolCall,
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

async function executePreparedToolCall(
  prepared: PreparedToolCall,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
  const updateEvents: Promise<void>[] = [];

  try {
    const result = await prepared.tool.execute(
      prepared.toolCall.id,
      prepared.args as never,
      signal,
      (partialResult) => {
        updateEvents.push(
          Promise.resolve(
            emit({
              type: "tool_execution_update",
              toolCallId: prepared.toolCall.id,
              toolName: prepared.toolCall.name,
              args: prepared.toolCall.arguments,
              partialResult,
            }),
          ),
        );
      },
    );
    await Promise.all(updateEvents);
    return { result, isError: false };
  } catch (error) {
    await Promise.all(updateEvents);
    return {
      result: createErrorToolResult(error instanceof Error ? error.message : String(error)),
      isError: true,
    };
  }
}

async function finalizeExecutedToolCall(
  currentContext: AgentContext,
  assistantMessage: AssistantMessage,
  prepared: PreparedToolCall,
  executed: ExecutedToolCallOutcome,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
  let result = executed.result;
  let isError = executed.isError;

  if (config.afterToolCall) {
    try {
      const afterResult = await config.afterToolCall(
        {
          assistantMessage,
          toolCall: prepared.toolCall,
          args: prepared.args,
          result,
          isError,
          context: currentContext,
        },
        signal,
      );
      if (afterResult) {
        result = {
          content: afterResult.content ?? result.content,
          details: afterResult.details ?? result.details,
          terminate: afterResult.terminate ?? result.terminate,
        };
        isError = afterResult.isError ?? isError;
      }
    } catch (error) {
      result = createErrorToolResult(error instanceof Error ? error.message : String(error));
      isError = true;
    }
  }

  return {
    toolCall: prepared.toolCall,
    result,
    isError,
    executionStarted: true,
  };
}

function createErrorToolResult(message: string): AgentToolResult<unknown> {
  return {
    content: [{ type: "text", text: message }],
    details: {},
  };
}

async function emitToolExecutionEnd(
  finalized: FinalizedToolCallOutcome,
  emit: AgentEventSink,
): Promise<void> {
  await emit({
    type: "tool_execution_end",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    result: finalized.result,
    isError: finalized.isError,
    executionStarted: finalized.executionStarted,
  });
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: finalized.toolCall.id,
    toolName: finalized.toolCall.name,
    content: finalized.result.content,
    details: finalized.result.details,
    isError: finalized.isError,
    timestamp: Date.now(),
  };
}

async function emitToolResultMessage(
  toolResultMessage: ToolResultMessage,
  emit: AgentEventSink,
): Promise<void> {
  await emit({ type: "message_start", message: toolResultMessage });
  await emit({ type: "message_end", message: toolResultMessage });
}
