import { vi } from "vitest";
import { createAssistantMessageEventStream } from "../../llm.js";
import type { AssistantMessage, Message, Model, StreamFn } from "../../llm.js";
import type { AgentMessage } from "../../types.js";
import type { SessionTreeEntry } from "../types.js";
import { compact, generateSummary } from "./compaction.js";
import { createMessageEntry } from "./compaction.test-support.js";
import type { SummarizationCompletionParams } from "./summarization-completion.js";
import { createFileOps } from "./utils.js";

export const userEntry = (content: string, index: number) =>
  createMessageEntry(user(content, index + 1), index);

export function compactionEntry(
  index: number,
  summary: string,
  firstKeptEntryId: string,
  overrides: Partial<Extract<SessionTreeEntry, { type: "compaction" }>> = {},
): SessionTreeEntry {
  return {
    type: "compaction",
    id: `entry-${index}`,
    parentId: index ? `entry-${index - 1}` : null,
    timestamp: new Date(index + 1).toISOString(),
    summary,
    firstKeptEntryId,
    tokensBefore: 200_000,
    ...overrides,
  };
}

export function makePreparation(overrides: Partial<Parameters<typeof compact>[0]> = {}) {
  return {
    firstKeptEntryId: "kept-entry",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: true,
    tokensBefore: 100,
    fileOps: createFileOps(),
    settings: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
    ...overrides,
  };
}

export function promptText(context: Parameters<StreamFn>[1]) {
  const message = context.messages[0];
  if (message?.role !== "user") {
    throw new Error("expected a user summary prompt");
  }
  return typeof message.content === "string"
    ? message.content
    : message.content.map((block) => (block.type === "text" ? block.text : "")).join("");
}

export function captureStream(reply: (model: Model, prompt: string) => AssistantMessage) {
  const prompts: string[] = [];
  let systemPrompt = "";
  let maxOutputTokens: number | undefined;
  const streamFn = vi.fn<StreamFn>((model, context, options) => {
    const prompt = promptText(context);
    prompts.push(prompt);
    systemPrompt = context.systemPrompt ?? "";
    maxOutputTokens = options?.maxTokens;
    return responseStream(reply(model, prompt));
  });
  return {
    streamFn,
    prompts,
    readCapture: () => ({ prompt: prompts.at(-1) ?? "", systemPrompt, maxOutputTokens }),
  };
}

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
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
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
> & { reserveTokens?: number; summaryPrompt?: Parameters<typeof generateSummary>[11] };
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
    options.summaryPrompt,
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
