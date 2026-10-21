import { createAssistantMessageEventStream } from "@openclaw/ai/event-stream";
import { createEmptyTransportUsage } from "@openclaw/ai/transports";
import type { AssistantMessage, AssistantMessageEvent, Context, Message } from "@openclaw/llm-core";
import { Type } from "typebox";
import { makeProviderModel } from "../../ai/src/providers/provider-model.test-support.js";
import { createAssistantOutput } from "../../ai/src/transports/assistant-output.js";
import { runAgentLoop } from "./agent-loop.js";
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
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      stream.push({ type: "error", reason: message.stopReason, error: message });
    } else {
      stream.push({ type: "done", reason: message.stopReason, message });
    }
    stream.end();
  });
  return stream;
}

export function user(content = "run", timestamp = 1): AgentTypes.AgentMessage {
  return { role: "user", content, timestamp };
}

export function makeCall(name: string, id = name): AgentTypes.AgentToolCall {
  return { type: "toolCall", id, name, arguments: {} };
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
