/** Shared fresh-request estimates for admission and compaction replacement. */
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringTokenPressure,
} from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { SAFETY_MARGIN } from "../compaction-planning.js";
import type { AgentMessage, BashExecutionMessage } from "../runtime/index.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
  IMAGE_BLOCK_TOKENS,
} from "../runtime/index.js";

const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;

export function estimateJsonPayloadTokenPressure(
  value: unknown,
  charsPerToken = JSON_PAYLOAD_CHARS_PER_TOKEN,
): number {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string"
      ? estimateStringTokenPressure(serialized, charsPerToken)
      : 1;
  } catch {
    return 256;
  }
}

/** Count model-facing definitions; runtime output schemas and metadata never reach the provider. */
export function estimateToolSchemaTokens(
  tools: readonly { name: string; description: string; parameters: unknown }[] | undefined,
): number {
  return tools?.length
    ? estimateJsonPayloadTokenPressure(
        tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
      )
    : 0;
}

function estimateIdentifierTokenPressure(value: unknown): number {
  if (value == null) {
    return 0;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return estimateStringTokenPressure(String(value), JSON_PAYLOAD_CHARS_PER_TOKEN);
  }
  return estimateJsonPayloadTokenPressure(value);
}

function estimateContentBlockTokenPressure(block: unknown): number {
  if (typeof block === "string") {
    return estimateStringTokenPressure(block);
  }
  if (!isRecord(block)) {
    return estimateJsonPayloadTokenPressure(block, CHARS_PER_TOKEN_ESTIMATE);
  }

  const type = block.type;
  const text = type === "text" ? block.text : type === "thinking" ? block.thinking : undefined;
  if (typeof text === "string") {
    return CONTENT_BLOCK_OVERHEAD_TOKENS + estimateStringTokenPressure(text);
  }
  if (type === "image") {
    return IMAGE_BLOCK_TOKENS;
  }
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS +
    estimateJsonPayloadTokenPressure(block, CHARS_PER_TOKEN_ESTIMATE)
  );
}

function estimateAssistantToolCallTokenPressure(block: Record<string, unknown>): number {
  const args = block.arguments ?? block.input ?? block.args ?? {};
  return (
    CONTENT_BLOCK_OVERHEAD_TOKENS +
    estimateIdentifierTokenPressure(block.name) +
    estimateJsonPayloadTokenPressure(args, JSON_PAYLOAD_CHARS_PER_TOKEN)
  );
}

function estimateContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content);
  }
  if (Array.isArray(content)) {
    return content.reduce((sum, block) => sum + estimateContentBlockTokenPressure(block), 0);
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content);
  }
  return 0;
}

export function estimateMessageTokenPressure(message: AgentMessage): number {
  if ("excludeFromContext" in message && message.excludeFromContext === true) {
    return 0;
  }
  // Provider replay can carry legacy aliases outside the canonical AgentMessage union.
  const legacy: Record<string, unknown> = isRecord(message) ? message : {};
  let tokens = MESSAGE_BOUNDARY_OVERHEAD_TOKENS;

  if (message.role === "toolResult" || legacy.role === "tool" || legacy.type === "toolResult") {
    const content = message.role === "toolResult" ? message.content : legacy.content;
    const toolName = message.role === "toolResult" ? message.toolName : legacy.toolName;
    tokens += estimateContentTokenPressure(content);
    tokens += estimateIdentifierTokenPressure(toolName ?? legacy.tool_name);
    return tokens;
  }

  if (message.role === "bashExecution") {
    const bashMessage: BashExecutionMessage = message;
    tokens += estimateStringTokenPressure(bashExecutionToText(bashMessage));
    return tokens;
  }

  if (message.role === "branchSummary" || message.role === "compactionSummary") {
    const [prefix, suffix] =
      message.role === "branchSummary"
        ? [BRANCH_SUMMARY_PREFIX, BRANCH_SUMMARY_SUFFIX]
        : [COMPACTION_SUMMARY_PREFIX, COMPACTION_SUMMARY_SUFFIX];
    return tokens + estimateStringTokenPressure(prefix + message.summary + suffix);
  }

  if (message.role === "assistant") {
    if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (isRecord(block)) {
          const blockType: unknown = block.type;
          if (blockType === "toolCall" || blockType === "tool_use") {
            tokens += estimateAssistantToolCallTokenPressure(block);
            continue;
          }
        }
        tokens += estimateContentBlockTokenPressure(block);
      }
    } else {
      tokens += estimateContentTokenPressure(message.content);
    }

    const toolCalls = legacy.toolCalls ?? legacy.tool_calls;
    if (Array.isArray(toolCalls)) {
      for (const toolCall of toolCalls) {
        tokens += isRecord(toolCall)
          ? estimateAssistantToolCallTokenPressure(toolCall)
          : estimateJsonPayloadTokenPressure(toolCall);
      }
    }
    return tokens;
  }

  tokens += estimateContentTokenPressure(legacy.content);
  return tokens;
}

export function estimateRenderedPromptTokens(params: {
  systemPrompt?: string;
  prompt: string;
}): number {
  const systemTokens = params.systemPrompt?.trim()
    ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.systemPrompt)
    : 0;
  return (
    systemTokens + MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(params.prompt)
  );
}

/** Prepare fixed request costs before estimating its pending input or replacement history. */
export function createFreshLlmBoundaryTokenEstimator(params: {
  systemPrompt?: string;
  tools?: readonly { name: string; description: string; parameters: unknown }[];
  retainCompletionUsage?: boolean;
  safetyMargin?: number;
}) {
  const safetyMargin = params.safetyMargin ?? SAFETY_MARGIN;
  const toolTokens = estimateToolSchemaTokens(params.tools);
  const fixedPromptTokens = estimateRenderedPromptTokens({
    systemPrompt: params.systemPrompt,
    prompt: "",
  });
  // Apply the safety margin once to the complete request before provider tokenization.
  return (request: { messages: AgentMessage[]; prompt: string; imageCount?: number }): number => {
    let messageTokens = 0;
    const completions = new Map<string, { estimated: number; measured: number }>();
    for (const message of request.messages) {
      const estimated = estimateMessageTokenPressure(message);
      messageTokens += estimated;
      if (!params.retainCompletionUsage || message.role !== "assistant" || estimated === 0) {
        continue;
      }
      const usage = message.usage?.contextUsage;
      const completion = usage?.state === "available" ? usage.totalTokens - usage.promptTokens : 0;
      const measured = Number.isFinite(completion) ? Math.max(0, completion) / safetyMargin : 0;
      // Async prefixes share the local turn identity even when the provider ID arrives late.
      // Their visible content and terminal usage describe one completion, not extra occupancy.
      const identity = message.turnId?.trim() || message.responseId?.trim();
      if (identity) {
        const previous = completions.get(identity);
        completions.set(identity, {
          estimated: (previous?.estimated ?? 0) + estimated,
          measured: Math.max(previous?.measured ?? 0, measured),
        });
      } else {
        messageTokens += Math.max(0, measured - estimated);
      }
    }
    // Preserve opaque completion occupancy without charging visible output twice.
    for (const { estimated, measured } of completions.values()) {
      messageTokens += Math.max(0, measured - estimated);
    }
    return Math.ceil(
      (fixedPromptTokens +
        estimateStringTokenPressure(request.prompt) +
        toolTokens +
        (request.imageCount ?? 0) * IMAGE_BLOCK_TOKENS +
        messageTokens) *
        safetyMargin,
    );
  };
}
