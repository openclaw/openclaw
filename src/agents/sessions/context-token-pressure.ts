/** Shared fresh-request estimates for admission and compaction replacement. */
import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringTokenPressure,
} from "@openclaw/normalization-core/cjk-chars";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { IMAGE_BLOCK_TOKENS } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import {
  BRANCH_SUMMARY_PREFIX,
  BRANCH_SUMMARY_SUFFIX,
  bashExecutionToText,
  COMPACTION_SUMMARY_PREFIX,
  COMPACTION_SUMMARY_SUFFIX,
} from "../../../packages/agent-core/src/harness/messages.js";
import type { AgentMessage, BashExecutionMessage } from "../../../packages/agent-core/src/types.js";
import {
  isDeeplyFrozenPlainData,
  memoizeFrozenPlainDataProjection,
} from "../../shared/immutable-data.js";

/** Buffer for token-estimation inaccuracy, shared by admission and compaction. */
export const SAFETY_MARGIN = 1.2;

const JSON_PAYLOAD_CHARS_PER_TOKEN = 3;
const MESSAGE_BOUNDARY_OVERHEAD_TOKENS = 12;
const CONTENT_BLOCK_OVERHEAD_TOKENS = 6;
type ToolSchema = { name: string; description: string; parameters: unknown };
export type FixedRequestTokenPressure = Readonly<{ systemTokens: number; toolTokens: number }>;
type FixedRequest = { systemPrompt?: string; tools?: readonly ToolSchema[] };

/** One sequential attempt owns its fixed request facts, including replacement tool surfaces. */
export function createFixedRequestTokenEstimator() {
  let systemPrompt: string | undefined;
  let systemTokens = 0;
  let definitions: ToolSchema[] | undefined;
  let toolTokens = 0;
  return (request: FixedRequest): FixedRequestTokenPressure => {
    if (systemPrompt !== request.systemPrompt) {
      systemPrompt = request.systemPrompt;
      systemTokens = systemPrompt?.trim()
        ? MESSAGE_BOUNDARY_OVERHEAD_TOKENS + estimateStringTokenPressure(systemPrompt)
        : 0;
    }
    const tools = request.tools ?? [];
    if (
      !definitions ||
      definitions.length !== tools.length ||
      !tools.every((tool, index) => {
        const saved = definitions![index]!;
        return (
          tool.name === saved.name &&
          tool.description === saved.description &&
          tool.parameters === saved.parameters
        );
      })
    ) {
      toolTokens = estimateToolSchemaTokens(tools);
      // Parameter publications are immutable; descriptions can change on a retained descriptor.
      definitions = tools.every(({ parameters }) => isDeeplyFrozenPlainData(parameters))
        ? tools.map(({ name, description, parameters }) => ({ name, description, parameters }))
        : undefined;
    }
    return { systemTokens, toolTokens };
  };
}

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
export function estimateToolSchemaTokens(tools: readonly ToolSchema[] | undefined): number {
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

const estimateContentArrayTokenPressure = memoizeFrozenPlainDataProjection((content: unknown[]) =>
  content.reduce<number>((sum, block) => sum + estimateContentBlockTokenPressure(block), 0),
);
const estimateAssistantContentTokenPressure = memoizeFrozenPlainDataProjection(
  (content: unknown[]) =>
    content.reduce<number>(
      (sum, block) =>
        sum +
        (isRecord(block) && (block.type === "toolCall" || block.type === "tool_use")
          ? estimateAssistantToolCallTokenPressure(block)
          : estimateContentBlockTokenPressure(block)),
      0,
    ),
);

function estimateContentTokenPressure(content: unknown): number {
  if (typeof content === "string") {
    return estimateStringTokenPressure(content);
  }
  if (Array.isArray(content)) {
    return estimateContentArrayTokenPressure(content);
  }
  if (content !== undefined) {
    return estimateJsonPayloadTokenPressure(content);
  }
  return 0;
}

export const estimateMessageTokenPressure = memoizeFrozenPlainDataProjection(
  (message: AgentMessage): number => {
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
        tokens += estimateAssistantContentTokenPressure(message.content);
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
  },
);

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
  fixedTokenPressure?: FixedRequestTokenPressure;
}) {
  const safetyMargin = params.safetyMargin ?? SAFETY_MARGIN;
  const toolTokens =
    params.fixedTokenPressure?.toolTokens ?? estimateToolSchemaTokens(params.tools);
  const fixedPromptTokens = params.fixedTokenPressure
    ? params.fixedTokenPressure.systemTokens + MESSAGE_BOUNDARY_OVERHEAD_TOKENS
    : estimateRenderedPromptTokens({ systemPrompt: params.systemPrompt, prompt: "" });
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

export function estimateVariableRequestTokens(messages: AgentMessage[], prompt: string): number {
  const estimateTokens = createFreshLlmBoundaryTokenEstimator({});
  return estimateTokens({ messages, prompt }) - estimateTokens({ messages: [], prompt: "" });
}

export function estimateCompactionHistoryTokens(
  messages: AgentMessage[],
  budget?: {
    pendingTokens: number;
    pendingUserTokens?: number;
    pendingUserIdempotencyKey?: string;
  },
): number {
  // A key identifies overlapping input, not proof that its content is replaced.
  // A retained carrier can reuse a larger canonical user, so charge the larger representation.
  const pending =
    budget?.pendingTokens && budget.pendingUserIdempotencyKey
      ? messages.findLast(
          (message) =>
            message.role === "user" &&
            "idempotencyKey" in message &&
            message.idempotencyKey === budget.pendingUserIdempotencyKey,
        )
      : undefined;
  const overlap = pending
    ? Math.min(
        estimateCompactionHistoryTokens([pending]),
        budget?.pendingUserTokens ?? budget?.pendingTokens ?? 0,
      )
    : 0;
  return estimateVariableRequestTokens(messages, "") - overlap;
}
