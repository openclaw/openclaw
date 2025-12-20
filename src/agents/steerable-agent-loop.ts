import { streamSimple, validateToolArguments } from "@mariozechner/pi-ai";
import type {
  AssistantMessage,
  Context,
  Message,
  ToolResultMessage,
  UserMessage,
} from "@mariozechner/pi-ai";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentTool,
  AgentToolResult,
  QueuedMessage,
} from "@mariozechner/pi-ai";

class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;

  constructor(
    private isComplete: (event: T) => boolean,
    private extractResult: (event: T) => R,
  ) {
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T): void {
    if (this.done) return;

    if (this.isComplete(event)) {
      this.done = true;
      this.resolveFinalResult(this.extractResult(event));
    }

    const waiter = this.waiting.shift();
    if (waiter) {
      waiter({ value: event, done: false });
    } else {
      this.queue.push(event);
    }
  }

  end(result?: R): void {
    this.done = true;
    if (result !== undefined) {
      this.resolveFinalResult(result);
    }
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift()!;
      waiter({ value: undefined as never, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift()!;
      } else if (this.done) {
        return;
      } else {
        const result = await new Promise<IteratorResult<T>>((resolve) =>
          this.waiting.push(resolve),
        );
        if (result.done) return;
        yield result.value;
      }
    }
  }

  result(): Promise<R> {
    return this.finalResultPromise;
  }
}

function createAgentStream(): EventStream<AgentEvent, AgentContext["messages"]> {
  return new EventStream<AgentEvent, AgentContext["messages"]>(
    (event) => event.type === "agent_end",
    (event) => (event.type === "agent_end" ? event.messages : []),
  );
}

export function agentLoop(
  prompt: UserMessage,
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: typeof streamSimple,
): EventStream<AgentEvent, AgentContext["messages"]> {
  const stream = createAgentStream();

  void (async () => {
    const newMessages: AgentContext["messages"] = [prompt];
    const currentContext: AgentContext = {
      ...context,
      messages: [...context.messages, prompt],
    };

    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    stream.push({ type: "message_start", message: prompt });
    stream.push({ type: "message_end", message: prompt });

    await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
  })();

  return stream;
}

export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: typeof streamSimple,
): EventStream<AgentEvent, AgentContext["messages"]> {
  const lastMessage = context.messages[context.messages.length - 1];
  if (!lastMessage) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (lastMessage.role !== "user" && lastMessage.role !== "toolResult") {
    throw new Error(
      `Cannot continue from message role: ${lastMessage.role}. Expected 'user' or 'toolResult'.`,
    );
  }

  const stream = createAgentStream();

  void (async () => {
    const newMessages: AgentContext["messages"] = [];
    const currentContext: AgentContext = { ...context };

    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });

    await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
  })();

  return stream;
}

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentContext["messages"],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentContext["messages"]>,
  streamFn?: typeof streamSimple,
): Promise<void> {
  let hasMoreToolCalls = true;
  let firstTurn = true;
  let queuedMessages: QueuedMessage<any>[] =
    (await config.getQueuedMessages?.()) || [];
  let queuedAfterTools: QueuedMessage<any>[] | null = null;

  while (hasMoreToolCalls || queuedMessages.length > 0) {
    if (!firstTurn) {
      stream.push({ type: "turn_start" });
    } else {
      firstTurn = false;
    }

    if (queuedMessages.length > 0) {
      for (const { original, llm } of queuedMessages) {
        stream.push({ type: "message_start", message: original });
        stream.push({ type: "message_end", message: original });
        if (llm) {
          currentContext.messages.push(llm);
          newMessages.push(llm);
        }
      }
      queuedMessages = [];
    }

    const message = await streamAssistantResponse(
      currentContext,
      config,
      signal,
      stream,
      streamFn,
    );
    newMessages.push(message);

    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "turn_end", message, toolResults: [] });
      stream.push({ type: "agent_end", messages: newMessages });
      stream.end(newMessages);
      return;
    }

    const toolCalls = message.content.filter((c) => c.type === "toolCall");
    hasMoreToolCalls = toolCalls.length > 0;

    const toolResults: ToolResultMessage[] = [];
    if (hasMoreToolCalls) {
      const toolExecution = await executeToolCalls(
        currentContext.tools,
        message,
        signal,
        stream,
        config.getQueuedMessages,
      );
      toolResults.push(...toolExecution.toolResults);
      queuedAfterTools = toolExecution.queuedMessages ?? null;
      currentContext.messages.push(...toolResults);
      newMessages.push(...toolResults);
    }
    stream.push({ type: "turn_end", message, toolResults: toolResults });

    if (queuedAfterTools && queuedAfterTools.length > 0) {
      queuedMessages = queuedAfterTools;
      queuedAfterTools = null;
    } else {
      queuedMessages = (await config.getQueuedMessages?.()) || [];
    }
  }

  stream.push({ type: "agent_end", messages: newMessages });
  stream.end(newMessages);
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentContext["messages"]>,
  streamFn?: typeof streamSimple,
): Promise<AssistantMessage> {
  const processedMessages = config.preprocessor
    ? await config.preprocessor(context.messages, signal)
    : [...context.messages];
  const processedContext: Context = {
    systemPrompt: context.systemPrompt,
    messages: [...processedMessages].map((m) => {
      if (m.role === "toolResult") {
        const { details, ...rest } = m;
        return rest;
      }
      return m;
    }),
    tools: context.tools,
  };

  const streamFunction = streamFn || streamSimple;
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) ||
    config.apiKey;

  const response = await streamFunction(config.model, processedContext, {
    ...config,
    apiKey: resolvedApiKey,
    signal,
  });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        stream.push({ type: "message_start", message: { ...partialMessage } });
        break;

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
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          stream.push({
            type: "message_update",
            assistantMessageEvent: event,
            message: { ...partialMessage },
          });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await response.result();
        if (addedPartial) {
          context.messages[context.messages.length - 1] = finalMessage;
        } else {
          context.messages.push(finalMessage);
        }
        if (!addedPartial) {
          stream.push({ type: "message_start", message: { ...finalMessage } });
        }
        stream.push({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  return await response.result();
}

async function executeToolCalls<T>(
  tools: AgentTool<any, T>[] | undefined,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, Message[]>,
  getQueuedMessages?: AgentLoopConfig["getQueuedMessages"],
): Promise<{
  toolResults: ToolResultMessage<T>[];
  queuedMessages?: QueuedMessage<any>[];
}> {
  const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
  const results: ToolResultMessage<any>[] = [];
  let queuedMessages: QueuedMessage<any>[] | undefined;

  for (let index = 0; index < toolCalls.length; index++) {
    const toolCall = toolCalls[index];
    const tool = tools?.find((t) => t.name === toolCall.name);

    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });

    let result: AgentToolResult<T>;
    let isError = false;

    try {
      if (!tool) throw new Error(`Tool ${toolCall.name} not found`);
      const validatedArgs = validateToolArguments(tool, toolCall);
      result = await tool.execute(toolCall.id, validatedArgs, signal, (partialResult) => {
        stream.push({
          type: "tool_execution_update",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          partialResult,
        });
      });
    } catch (err) {
      result = {
        content: [
          { type: "text", text: err instanceof Error ? err.message : String(err) },
        ],
        details: {} as T,
      };
      isError = true;
    }

    stream.push({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });

    const toolResultMessage: ToolResultMessage<T> = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    };

    results.push(toolResultMessage);
    stream.push({ type: "message_start", message: toolResultMessage });
    stream.push({ type: "message_end", message: toolResultMessage });

    if (getQueuedMessages) {
      const queued = await getQueuedMessages();
      if (queued.length > 0) {
        queuedMessages = queued;
        const remainingCalls = toolCalls.slice(index + 1);
        for (const skipped of remainingCalls) {
          results.push(skipToolCall(skipped, stream));
        }
        break;
      }
    }
  }

  return { toolResults: results, queuedMessages };
}

function skipToolCall<T>(
  toolCall: Extract<AssistantMessage["content"][number], { type: "toolCall" }>,
  stream: EventStream<AgentEvent, Message[]>,
): ToolResultMessage<T> {
  const result: AgentToolResult<T> = {
    content: [{ type: "text", text: "Skipped due to queued user message." }],
    details: {} as T,
  };

  stream.push({
    type: "tool_execution_start",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    args: toolCall.arguments,
  });
  stream.push({
    type: "tool_execution_end",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    result,
    isError: true,
  });

  const toolResultMessage: ToolResultMessage<T> = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: result.details,
    isError: true,
    timestamp: Date.now(),
  };

  stream.push({ type: "message_start", message: toolResultMessage });
  stream.push({ type: "message_end", message: toolResultMessage });

  return toolResultMessage;
}
