import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, Message, TextContent, ToolCall } from "@mariozechner/pi-ai";
import { log } from "../logger.js";

const DEFAULT_TRIGGER_ROUNDS = 4;
const DEFAULT_KEEP_RECENT_ROUNDS = 2;
const DEFAULT_SUMMARY_BATCH_ROUNDS = 4;
const DEFAULT_SUMMARY_MAX_CALLS = 6;
const DEFAULT_SUMMARY_INPUT_MAX_CHARS = 18_000;
const DEFAULT_SUMMARY_MAX_TOKENS = 1_000;
const TOOL_HISTORY_SUMMARY_HEADER = "Compressed tool execution history (system-generated):";
const TOOL_HISTORY_SUMMARY_SYSTEM_PROMPT =
  "You summarize tool execution history for an agent runtime checkpoint. " +
  "Be concise and factual. Keep only outcomes, key findings, file paths, commands, " +
  "errors, and unresolved items needed for the next tool steps.";

type ToolRound = {
  start: number;
  end: number;
  messages: Message[];
};

type WrappedOptions = NonNullable<Parameters<StreamFn>[2]>;

type EphemeralToolContextWrapperConfig = {
  triggerRounds?: number;
  keepRecentRounds?: number;
  summaryBatchRounds?: number;
  summaryMaxCalls?: number;
  summaryInputMaxChars?: number;
  summaryMaxTokens?: number;
  runId?: string;
  sessionId?: string;
  provider?: string;
  modelId?: string;
};

function isAssistantWithToolCalls(message: Message): message is AssistantMessage {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "assistant"
  ) {
    return false;
  }
  const content = (message as AssistantMessage).content;
  return Array.isArray(content) && content.some((block) => block?.type === "toolCall");
}

function collectToolRounds(messages: Message[]): ToolRound[] {
  const rounds: ToolRound[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    if (!isAssistantWithToolCalls(message)) {
      continue;
    }
    let end = i + 1;
    while (
      end < messages.length &&
      (messages[end] as { role?: unknown } | undefined)?.role === "toolResult"
    ) {
      end += 1;
    }
    rounds.push({
      start: i,
      end,
      messages: messages.slice(i, end),
    });
    i = end - 1;
  }
  return rounds;
}

function truncateText(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 12))}...[truncated]`;
}

function serializeToolResult(message: Message): string {
  if (
    !message ||
    typeof message !== "object" ||
    (message as { role?: unknown }).role !== "toolResult"
  ) {
    return "";
  }
  const toolResult = message as Extract<Message, { role: "toolResult" }>;
  const chunks = Array.isArray(toolResult.content) ? toolResult.content : [];
  const text = chunks
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      if (block.type === "text") {
        return block.text ?? "";
      }
      if (block.type === "image") {
        return "[image]";
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
  const status = toolResult.isError ? "error" : "ok";
  return `toolResult ${toolResult.toolName} (${status}): ${truncateText(text || "(no text)", 420)}`;
}

function serializeToolRounds(rounds: ToolRound[], maxChars: number): string {
  const lines: string[] = [];
  for (const [idx, round] of rounds.entries()) {
    lines.push(`Round ${idx + 1}:`);
    const assistant = round.messages[0] as AssistantMessage | undefined;
    const toolCalls = Array.isArray(assistant?.content)
      ? assistant.content.filter((block): block is ToolCall => block.type === "toolCall")
      : [];
    const assistantText = Array.isArray(assistant?.content)
      ? assistant.content
          .filter((block): block is TextContent => block.type === "text")
          .map((block) => block.text)
          .filter((text) => typeof text === "string" && text.trim().length > 0)
          .join("\n")
      : "";
    if (assistantText.trim()) {
      lines.push(`assistant: ${truncateText(assistantText.trim(), 360)}`);
    }
    for (const call of toolCalls) {
      const args = truncateText(JSON.stringify(call.arguments ?? {}), 260);
      lines.push(`toolCall ${call.name}(${args}) id=${call.id}`);
    }
    for (let i = 1; i < round.messages.length; i += 1) {
      const line = serializeToolResult(round.messages[i]);
      if (line) {
        lines.push(line);
      }
    }
    lines.push("");
  }
  return truncateText(lines.join("\n").trim(), maxChars);
}

function extractAssistantText(message: AssistantMessage): string {
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter((block): block is TextContent => block?.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
}

function buildSummaryPrompt(params: {
  serializedRounds: string;
  previousSummary?: string;
}): string {
  const previous = params.previousSummary?.trim();
  if (!previous) {
    return (
      `Summarize these tool execution rounds for continuity in the next LLM call.\n` +
      `Output short bullets with:\n` +
      `- important outcomes and discoveries\n` +
      `- files/commands/errors encountered\n` +
      `- open items or next actions\n\n` +
      `<tool-rounds>\n${params.serializedRounds}\n</tool-rounds>`
    );
  }
  return (
    `Update the existing tool-history summary with these NEW rounds.\n` +
    `Keep prior key facts and add new outcomes, files, commands, errors, and unresolved items.\n\n` +
    `<previous-summary>\n${previous}\n</previous-summary>\n\n` +
    `<new-tool-rounds>\n${params.serializedRounds}\n</new-tool-rounds>`
  );
}

async function summarizeToolRounds(params: {
  streamFn: StreamFn;
  model: Parameters<StreamFn>[0];
  options?: Parameters<StreamFn>[2];
  rounds: ToolRound[];
  previousSummary?: string;
  summaryInputMaxChars: number;
  summaryMaxTokens: number;
}): Promise<string> {
  const serializedRounds = serializeToolRounds(params.rounds, params.summaryInputMaxChars);
  if (!serializedRounds.trim()) {
    return params.previousSummary?.trim() ?? "";
  }

  const userPrompt = buildSummaryPrompt({
    serializedRounds,
    previousSummary: params.previousSummary,
  });

  const summaryOptions = {
    ...params.options,
    temperature: 0,
    maxTokens:
      typeof params.options?.maxTokens === "number"
        ? Math.min(params.options.maxTokens, params.summaryMaxTokens)
        : params.summaryMaxTokens,
    onPayload: undefined,
    toolChoice: "none",
  } as WrappedOptions & { toolChoice?: "none" };

  const stream = await Promise.resolve(
    params.streamFn(
      params.model,
      {
        systemPrompt: TOOL_HISTORY_SUMMARY_SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
            timestamp: Date.now(),
          },
        ],
        tools: [],
      },
      summaryOptions,
    ),
  );
  const response = await stream.result();
  const summary = extractAssistantText(response);
  if (!summary) {
    throw new Error("tool history summary response was empty");
  }
  return summary;
}

function applySummaryToSystemPrompt(
  context: Parameters<StreamFn>[1],
  summary: string,
): Parameters<StreamFn>[1] {
  const record = context as unknown as Record<string, unknown>;
  const currentSystemPrompt =
    typeof record.systemPrompt === "string"
      ? record.systemPrompt
      : typeof record.system === "string"
        ? record.system
        : "";
  const nextSystemPrompt = currentSystemPrompt
    ? `${currentSystemPrompt}\n\n${TOOL_HISTORY_SUMMARY_HEADER}\n${summary}`
    : `${TOOL_HISTORY_SUMMARY_HEADER}\n${summary}`;

  return {
    ...context,
    systemPrompt: nextSystemPrompt,
  };
}

function pruneRoundsFromMessages(
  messages: Message[],
  rounds: ToolRound[],
  pruneRoundsCount: number,
): Message[] {
  if (pruneRoundsCount <= 0) {
    return messages;
  }
  const dropRanges = rounds.slice(0, pruneRoundsCount);
  if (dropRanges.length === 0) {
    return messages;
  }
  const dropIndices = new Set<number>();
  for (const range of dropRanges) {
    for (let idx = range.start; idx < range.end; idx += 1) {
      dropIndices.add(idx);
    }
  }
  return messages.filter((_message, idx) => !dropIndices.has(idx));
}

export function createEphemeralToolContextWrapper(
  streamFn: StreamFn,
  config: EphemeralToolContextWrapperConfig = {},
): StreamFn {
  const triggerRounds = Math.max(2, config.triggerRounds ?? DEFAULT_TRIGGER_ROUNDS);
  const keepRecentRounds = Math.max(1, config.keepRecentRounds ?? DEFAULT_KEEP_RECENT_ROUNDS);
  const summaryBatchRounds = Math.max(1, config.summaryBatchRounds ?? DEFAULT_SUMMARY_BATCH_ROUNDS);
  const summaryMaxCalls = Math.max(1, config.summaryMaxCalls ?? DEFAULT_SUMMARY_MAX_CALLS);
  const summaryInputMaxChars = Math.max(
    1_000,
    config.summaryInputMaxChars ?? DEFAULT_SUMMARY_INPUT_MAX_CHARS,
  );
  const summaryMaxTokens = Math.max(256, config.summaryMaxTokens ?? DEFAULT_SUMMARY_MAX_TOKENS);

  let summarizedRounds = 0;
  let compressedSummary: string | undefined;
  let summaryCalls = 0;

  const wrapped: StreamFn = async (model, context, options) => {
    const messagesRaw = (context as { messages?: Message[] }).messages;
    const messages = Array.isArray(messagesRaw) ? messagesRaw : [];
    const rounds = collectToolRounds(messages);

    if (rounds.length < triggerRounds) {
      return streamFn(model, context, options);
    }

    const compressibleRounds = Math.max(0, rounds.length - keepRecentRounds);
    if (compressibleRounds <= 0) {
      return streamFn(model, context, options);
    }

    const pendingRounds = Math.max(0, compressibleRounds - summarizedRounds);
    const shouldAttemptSummary =
      pendingRounds > 0 &&
      summaryCalls < summaryMaxCalls &&
      (!compressedSummary || pendingRounds >= summaryBatchRounds);

    if (shouldAttemptSummary) {
      const newRounds = rounds.slice(summarizedRounds, compressibleRounds);
      try {
        compressedSummary = await summarizeToolRounds({
          streamFn,
          model,
          options,
          rounds: newRounds,
          previousSummary: compressedSummary,
          summaryInputMaxChars,
          summaryMaxTokens,
        });
        summarizedRounds = compressibleRounds;
        summaryCalls += 1;
      } catch (error) {
        summaryCalls += 1;
        log.warn(
          "ephemeral tool context: summary update failed; keeping unsummarized rounds in context " +
            `runId=${config.runId ?? "unknown"} sessionId=${config.sessionId ?? "unknown"} ` +
            `provider=${config.provider ?? "unknown"} model=${config.modelId ?? "unknown"} ` +
            `error=${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    const pruneRoundsCount = Math.min(summarizedRounds, compressibleRounds);
    if (!compressedSummary || pruneRoundsCount <= 0) {
      return streamFn(model, context, options);
    }

    const prunedMessages = pruneRoundsFromMessages(messages, rounds, pruneRoundsCount);
    const nextContext = applySummaryToSystemPrompt(
      {
        ...context,
        messages: prunedMessages,
      },
      compressedSummary,
    );

    return streamFn(model, nextContext, options);
  };

  return wrapped;
}

export const __testing = {
  collectToolRounds,
  serializeToolRounds,
  pruneRoundsFromMessages,
} as const;
