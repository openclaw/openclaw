import { Type } from "typebox";
import { runAgentLoop } from "./agent-loop.js";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  type Context,
  type Message,
  type Model,
} from "./llm.js";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentTool,
  StreamFn,
} from "./types.js";

export const model: Model = {
  id: "test-model",
  name: "Test Model",
  api: "test-api",
  provider: "test-provider",
  baseUrl: "https://example.test",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 1000,
};

export const config: AgentLoopConfig = {
  model,
  convertToLlm: (messages) => messages as Message[],
};

export const TEST_USAGE = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export function makeAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: TEST_USAGE,
    stopReason: content.some((item) => item.type === "toolCall") ? "toolUse" : "stop",
    timestamp: 1,
  };
}

export function makeTool(name: string, executed: string[] = []): AgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters: Type.Object({}, { additionalProperties: false }),
    execute: async () => {
      executed.push(name);
      return {
        content: [{ type: "text", text: `${name} result` }],
        details: { name },
      };
    },
  };
}

export function createTurnSequenceStream(
  turns: AssistantMessage["content"][],
  requestMessages: Message[][] = [],
  onRequest?: (context: Context, turn: number) => void,
): StreamFn {
  let turnIndex = 0;
  return (_activeModel, context) => {
    requestMessages.push(context.messages.slice());
    onRequest?.(context, turnIndex + 1);
    const content = turns[turnIndex];
    turnIndex += 1;
    if (!content) {
      throw new Error(`unexpected provider request ${turnIndex}`);
    }
    return reply(makeAssistantMessage(content));
  };
}

export function reply(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}

export function user(content = "run", timestamp = 1): AgentMessage {
  return { role: "user", content, timestamp };
}

export function makeCall(
  name: string,
  id = name,
): Extract<AssistantMessage["content"][number], { type: "toolCall" }> {
  return { type: "toolCall", id, name, arguments: {} };
}

export function captureAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  loopConfig: AgentLoopConfig,
  signal?: AbortSignal,
  streamFn?: StreamFn,
) {
  const events: AgentEvent[] = [];
  const result = runAgentLoop(
    prompts,
    context,
    loopConfig,
    (event) => {
      events.push(event);
    },
    signal,
    streamFn,
  );
  return { events, result };
}

export async function collectEvents(
  run: ReturnType<typeof captureAgentLoop>,
): Promise<AgentEvent[]> {
  await run.result;
  return run.events;
}
