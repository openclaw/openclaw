/**
 * Iris Engine — Parallel Agent Loop
 *
 * Drop-in replacement for @mariozechner/pi-agent-core's agent-loop.
 *
 * KEY DIFFERENCE: executeToolCallsParallel runs all tool calls concurrently
 * via Promise.allSettled instead of sequentially. With N tools each taking
 * T ms, latency drops from N×T to max(T).
 *
 * Steering-message semantics are preserved: user interrupt is checked before
 * the parallel batch starts so the user can still cancel before any work begins.
 */

import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  AgentToolResult,
  StreamFn,
} from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@mariozechner/pi-ai";
import { EventStream, streamSimple, validateToolArguments } from "@mariozechner/pi-ai";

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start an agent loop with a new prompt message.
 * Identical signature to pi-agent-core's agentLoop — drop-in replacement.
 */
export function agentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  const stream = createAgentStream();
  void (async () => {
    const newMessages = [...prompts];
    const currentContext: AgentContext = {
      ...context,
      messages: [...context.messages, ...prompts],
    };
    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    for (const prompt of prompts) {
      stream.push({ type: "message_start", message: prompt });
      stream.push({ type: "message_end", message: prompt });
    }
    await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
  })();
  return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Identical signature to pi-agent-core's agentLoopContinue.
 */
export function agentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
  if (context.messages.length === 0) {
    throw new Error("Cannot continue: no messages in context");
  }
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }
  const stream = createAgentStream();
  void (async () => {
    const newMessages: AgentMessage[] = [];
    const currentContext = { ...context };
    stream.push({ type: "agent_start" });
    stream.push({ type: "turn_start" });
    await runLoop(currentContext, newMessages, config, signal, stream, streamFn);
  })();
  return stream;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
  return new EventStream(
    (event: AgentEvent) => event.type === "agent_end",
    (event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
  );
}

async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<void> {
  let firstTurn = true;
  let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) ?? [];

  while (true) {
    let hasMoreToolCalls = true;
    let steeringAfterTools: AgentMessage[] | null = null;

    while (hasMoreToolCalls || pendingMessages.length > 0) {
      if (!firstTurn) {
        stream.push({ type: "turn_start" });
      } else {
        firstTurn = false;
      }

      if (pendingMessages.length > 0) {
        for (const message of pendingMessages) {
          stream.push({ type: "message_start", message });
          stream.push({ type: "message_end", message });
          currentContext.messages.push(message);
          newMessages.push(message);
        }
        pendingMessages = [];
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

      const toolCalls = message.content.filter((c): c is ToolCall => c.type === "toolCall");
      hasMoreToolCalls = toolCalls.length > 0;
      const toolResults: AgentMessage[] = [];

      if (hasMoreToolCalls) {
        // ← PARALLEL execution happens here
        const toolExecution = await executeToolCallsParallel(
          currentContext.tools,
          message,
          signal,
          stream,
          config.getSteeringMessages,
        );
        toolResults.push(...toolExecution.toolResults);
        steeringAfterTools = toolExecution.steeringMessages ?? null;
        for (const result of toolResults) {
          currentContext.messages.push(result);
          newMessages.push(result);
        }
      }

      // toolResults cast: AgentEvent turn_end expects ToolResultMessage[],
      // which is a subset of AgentMessage[] that we know we have here.
      stream.push({
        type: "turn_end",
        message,
        toolResults: toolResults as Parameters<(typeof stream)["push"]>[0] extends {
          type: "turn_end";
          toolResults: infer R;
        }
          ? R
          : never,
      });

      if (steeringAfterTools && steeringAfterTools.length > 0) {
        pendingMessages = steeringAfterTools;
        steeringAfterTools = null;
      } else {
        pendingMessages = (await config.getSteeringMessages?.()) ?? [];
      }
    }

    const followUpMessages = (await config.getFollowUpMessages?.()) ?? [];
    if (followUpMessages.length > 0) {
      pendingMessages = followUpMessages;
      continue;
    }
    break;
  }

  stream.push({ type: "agent_end", messages: newMessages });
  stream.end(newMessages);
}

async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  streamFn?: StreamFn,
): Promise<AssistantMessage> {
  let messages = context.messages;
  if (config.transformContext) {
    messages = await config.transformContext(messages, signal);
  }

  const llmMessages = await config.convertToLlm(messages);
  const llmContext = {
    systemPrompt: context.systemPrompt,
    messages: llmMessages,
    tools: context.tools,
  };

  const streamFunction = streamFn ?? streamSimple;
  const resolvedApiKey =
    (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) ?? config.apiKey;
  const response = await streamFunction(config.model, llmContext, {
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
  return response.result();
}

// ─── PARALLEL tool execution ──────────────────────────────────────────────────

/**
 * Execute all tool calls in parallel using Promise.allSettled.
 *
 * Sequential (before):  tool1 → wait → tool2 → wait → tool3 → wait  (N × T)
 * Parallel  (after):    tool1 ┐
 *                       tool2 ├→ wait for slowest → done              (max T)
 *                       tool3 ┘
 *
 * Steering messages are checked BEFORE launching the batch so the user can
 * still interrupt before any work begins. If the agent is mid-batch and the
 * user sends a message, it will be picked up on the next turn.
 */
async function executeToolCallsParallel(
  tools: AgentTool[] | undefined,
  assistantMessage: AssistantMessage,
  signal: AbortSignal | undefined,
  stream: EventStream<AgentEvent, AgentMessage[]>,
  getSteeringMessages?: () => Promise<AgentMessage[]>,
): Promise<{ toolResults: AgentMessage[]; steeringMessages?: AgentMessage[] }> {
  const toolCalls = assistantMessage.content.filter((c): c is ToolCall => c.type === "toolCall");

  if (toolCalls.length === 0) {
    return { toolResults: [] };
  }

  // Check for user interrupt BEFORE starting — preserves steering semantics.
  if (getSteeringMessages) {
    const steering = await getSteeringMessages();
    if (steering.length > 0) {
      const skipped = toolCalls.map((tc) => skipToolCall(tc, stream));
      return { toolResults: skipped, steeringMessages: steering };
    }
  }

  // Emit execution_start for ALL tools immediately so the UI shows
  // all of them as "in progress" at once.
  for (const toolCall of toolCalls) {
    stream.push({
      type: "tool_execution_start",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      args: toolCall.arguments,
    });
  }

  // Launch every tool concurrently.
  const executions = toolCalls.map(async (toolCall) => {
    const tool = tools?.find((t) => t.name === toolCall.name);
    if (!tool) {
      throw new Error(`Tool ${toolCall.name} not found`);
    }
    // validateToolArguments narrows to the tool's specific parameter schema.
    const validatedArgs = validateToolArguments(
      tool as Parameters<typeof validateToolArguments>[0],
      toolCall,
    );
    return tool.execute(
      toolCall.id,
      validatedArgs,
      signal,
      (partialResult: AgentToolResult<unknown>) => {
        // Partial updates stream in naturally — interleaved across tools is fine.
        stream.push({
          type: "tool_execution_update",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          args: toolCall.arguments,
          partialResult,
        });
      },
    );
  });

  // Wait for every tool (allSettled never throws).
  const settled = await Promise.allSettled(executions);

  // Emit execution_end events and collect toolResult messages in original order.
  const results: AgentMessage[] = [];
  for (let i = 0; i < toolCalls.length; i++) {
    const toolCall = toolCalls[i];
    const outcome = settled[i];
    const isError = outcome.status === "rejected";
    const result: AgentToolResult<unknown> = isError
      ? {
          content: [
            {
              type: "text",
              text:
                outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
            },
          ],
          details: {},
        }
      : outcome.value;

    stream.push({
      type: "tool_execution_end",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      result,
      isError,
    });

    const toolResultMessage: AgentMessage = {
      role: "toolResult",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      content: result.content,
      details: result.details,
      isError,
      timestamp: Date.now(),
    } as AgentMessage;

    results.push(toolResultMessage);
    stream.push({ type: "message_start", message: toolResultMessage });
    stream.push({ type: "message_end", message: toolResultMessage });
  }

  return { toolResults: results };
}

function skipToolCall(
  toolCall: ToolCall,
  stream: EventStream<AgentEvent, AgentMessage[]>,
): AgentMessage {
  const result: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "Skipped due to queued user message." }],
    details: {},
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
  const msg: AgentMessage = {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: result.content,
    details: {},
    isError: true,
    timestamp: Date.now(),
  } as AgentMessage;
  stream.push({ type: "message_start", message: msg });
  stream.push({ type: "message_end", message: msg });
  return msg;
}
