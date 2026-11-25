import { vi } from "vitest";
import { createZeroUsage } from "../../../../ai/src/usage.test-support.js";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Message, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import { compact, generateSummary } from "./compaction.js";
import type { SummarizationCompletionParams } from "./summarization-completion.js";

export const text = (value: string) => ({ type: "text" as const, text: value });

export function toolCall(name: string, args: Record<string, unknown> = {}, id = name) {
  return { type: "toolCall" as const, id, name, arguments: args };
}

type Custom = Extract<AgentMessage, { role: "custom" }>;
export function custom(content: Custom["content"], overrides: Partial<Custom> = {}): Custom {
  return { role: "custom", customType: "test", content, display: true, timestamp: 1, ...overrides };
}

export function assistant(
  content: string | AssistantMessage["content"],
  overrides: Partial<AssistantMessage> = {},
): AssistantMessage {
  return {
    role: "assistant",
    content: typeof content === "string" ? [text(content)] : content,
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: createZeroUsage(),
    stopReason: "stop",
    timestamp: 1,
    ...overrides,
  };
}

type User = Extract<Message, { role: "user" }>;
type Sender = { senderId?: string; senderName?: string; senderUsername?: string };
export function user(content: User["content"], timestamp = 1, sender?: Sender) {
  return { role: "user" as const, content, timestamp, ...(sender ? { __openclaw: sender } : {}) };
}

type ToolResult = Extract<Message, { role: "toolResult" }>;
export function toolResult(
  content: string | ToolResult["content"],
  overrides: Partial<ToolResult> = {},
): ToolResult {
  return {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "read",
    isError: false,
    timestamp: 1,
    content: typeof content === "string" ? [text(content)] : content,
    ...overrides,
  };
}

type Bash = Extract<AgentMessage, { role: "bashExecution" }>;
export function bash(output: string, overrides: Partial<Bash> = {}): Bash {
  return {
    role: "bashExecution",
    command: "private command",
    output,
    exitCode: 0,
    cancelled: false,
    truncated: false,
    timestamp: 1,
    excludeFromContext: true,
    ...overrides,
  };
}

export function responseStream(message: AssistantMessage) {
  const stream = createAssistantMessageEventStream();
  if (message.stopReason === "error" || message.stopReason === "aborted") {
    stream.push({ type: "error", reason: message.stopReason, error: message });
  } else {
    stream.push({ type: "done", reason: message.stopReason, message });
  }
  stream.end();
  return stream;
}

export function decoratedResponse(message: AssistantMessage) {
  let consumed = false;
  const streamFn = vi.fn<StreamFn>(() => ({
    [Symbol.asyncIterator]() {
      return {
        async next() {
          consumed = true;
          return { done: true as const, value: undefined };
        },
      };
    },
    async result() {
      if (!consumed) {
        throw new Error("stream result read before iteration");
      }
      return message;
    },
  }));
  return { streamFn, consumed: () => consumed };
}

type SummaryOptions = Partial<
  Pick<
    SummarizationCompletionParams,
    "previousSummary" | "thinkingLevel" | "signal" | "streamFn" | "runtime"
  >
> & { reserveTokens?: number };
export function summarize(messages: AgentMessage[], model: Model, options: SummaryOptions = {}) {
  return generateSummary(
    messages,
    model,
    options.reserveTokens ?? 1_000,
    undefined,
    undefined,
    options.signal,
    undefined,
    options.previousSummary,
    options.thinkingLevel,
    options.streamFn,
    options.runtime,
  );
}

export function compactWith(
  preparation: Parameters<typeof compact>[0],
  model: Model,
  options: Pick<SummarizationCompletionParams, "runtime" | "streamFn" | "customInstructions"> = {},
) {
  return compact(
    preparation,
    model,
    undefined,
    undefined,
    options.customInstructions,
    undefined,
    undefined,
    options.streamFn,
    options.runtime,
  );
}
