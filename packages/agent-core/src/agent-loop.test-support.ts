import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { createEmptyTransportUsage } from "@openclaw/ai/transports";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Message,
  UserMessage,
} from "@openclaw/llm-core";
import { Type } from "typebox";
import { makeProviderModel } from "../../ai/src/providers/provider-model.test-support.js";
import { createAssistantOutput } from "../../ai/src/transports/assistant-output.js";
import { runAgentLoop } from "./agent-loop.js";
import { Agent, type AgentOptions } from "./agent.js";
import type { Model } from "./llm.js";
import type * as AgentTypes from "./types.js";

export const model: Model = makeProviderModel("test-api", "test-provider", "test-model", {
  name: "Test Model",
  baseUrl: "https://example.test",
  reasoning: false,
  contextWindow: 1000,
  maxTokens: 1000,
});

export const config: AgentTypes.AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

export const TEST_USAGE = createEmptyTransportUsage();

export function captureAgent(
  tools: AgentTypes.AgentTool[],
  options: AgentOptions = {},
  turns: AssistantMessage["content"][] = [
    tools.map(({ name }) => makeCall(name)),
    [{ type: "text", text: "done" }],
  ],
) {
  const requests: Message[][] = [];
  const streamFn = options.streamFn ?? createTurnSequenceStream(turns);
  const agent = new Agent({
    ...options,
    initialState: { model, tools, ...options.initialState },
    streamFn: (...args) => {
      requests.push(args[1].messages.slice());
      return streamFn(...args);
    },
  });
  const events: AgentTypes.AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  return { agent, requests, events };
}

export function expectedToolResult(toolCallId: string, isError: boolean, rest?: object) {
  return { role: "toolResult" as const, toolCallId, isError, ...rest };
}

export function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    ...createAssistantOutput(model),
    content,
    usage: TEST_USAGE,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

export function makeTool(name: string, executed: string[] = []): AgentTypes.AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      executed.push(name);
      return { content: [{ type: "text", text: `${name} result` }], details: { name } };
    },
  };
}

export function createTurnSequenceStream(
  turns: AssistantMessage["content"][],
  requestMessages: Message[][] = [],
  onRequest?: (context: Context, turn: number) => void,
): AgentTypes.StreamFn {
  let turnIndex = 0;
  return (_activeModel, context) => {
    requestMessages.push(context.messages.slice());
    onRequest?.(context, turnIndex + 1);
    const content = turns[turnIndex++];
    if (!content) {
      throw new Error(`unexpected provider request ${turnIndex}`);
    }
    return reply(makeAssistantMessage(content));
  };
}

export function reply(message: AssistantMessage, prelude: AssistantMessageEvent[] = []) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    for (const event of prelude) {
      stream.push(event);
    }
    finishMessageStream(stream, message);
  });
  return stream;
}

export function user(content = "run", timestamp = 1): UserMessage {
  return { role: "user", content, timestamp };
}

export function makeCall(name: string, id = name): AgentTypes.AgentToolCall {
  return { type: "toolCall", id, name, arguments: {} };
}

export function startToolCalls(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  calls: AgentTypes.AgentToolCall[],
  message = makeAssistantMessage,
) {
  stream.push({ type: "start", partial: message([]) });
  calls.forEach((toolCall, contentIndex) =>
    stream.push({
      type: "toolcall_end",
      contentIndex,
      toolCall,
      partial: message(calls.slice(0, contentIndex + 1)),
    }),
  );
}

export function finishMessageStream(
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  message: AssistantMessage,
  reason = message.stopReason,
) {
  stream.push(
    reason === "error" || reason === "aborted"
      ? { type: "error", reason, error: message }
      : { type: "done", reason, message },
  );
  stream.end();
}

export function captureAgentLoop(
  prompts: AgentTypes.AgentMessage[],
  context: AgentTypes.AgentContext,
  loopConfig: AgentTypes.AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: AgentTypes.StreamFn,
) {
  const events: AgentTypes.AgentEvent[] = [];
  const capture = (event: AgentTypes.AgentEvent) => void events.push(event);
  return {
    events,
    result: runAgentLoop(prompts, context, loopConfig, capture, signal, streamFn),
  };
}

export async function collectEvents(run: ReturnType<typeof captureAgentLoop>) {
  await run.result;
  return run.events;
}

export function captureToolLoop(options: {
  tools: AgentTypes.AgentTool[];
  config?: Partial<AgentTypes.AgentLoopConfig>;
  onEvent?: (event: AgentTypes.AgentEvent) => void | Promise<void>;
  onMessage?: (message: AgentTypes.AgentMessage) => void | Promise<void>;
  signal?: AbortSignal;
  streamFn?: AgentTypes.StreamFn;
  prompt?: AgentTypes.AgentMessage;
}) {
  const response = createAssistantMessageEventStream();
  const persisted: AgentTypes.AgentMessage[] = [];
  const events: AgentTypes.AgentEvent[] = [];
  const run = runAgentLoop(
    [options.prompt ?? user("start", 0)],
    { systemPrompt: "", messages: [], tools: options.tools },
    { ...config, ...options.config },
    (event) => {
      events.push(event);
      if (event.type === "message_end") {
        persisted.push(event.message);
        if (options.onMessage) {
          return options.onMessage(event.message);
        }
      }
      return options.onEvent?.(event);
    },
    options.signal,
    options.streamFn ?? (() => response),
  );
  return { response, persisted, events, run };
}
