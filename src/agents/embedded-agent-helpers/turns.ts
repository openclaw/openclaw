import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentMessage } from "../runtime/index.js";
import { isThinkingLikeBlock } from "../thinking-block.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import { isAnthropicApi } from "./anthropic-api.js";

const SIGNED_THINKING_PROVIDERS = new Set(["anthropic", "amazon-bedrock", "anthropic-vertex"]);

export function providerRequiresSignedThinking(provider?: string | null): boolean {
  return SIGNED_THINKING_PROVIDERS.has(normalizeProviderId(provider ?? ""));
}

export function shouldAllowProviderOwnedThinkingReplay(params: {
  modelApi?: string | null;
  provider?: string | null;
  policy: Pick<
    TranscriptPolicy,
    "validateAnthropicTurns" | "preserveSignatures" | "dropThinkingBlocks"
  >;
}): boolean {
  const hasProviderOwnedSignedThinking =
    params.policy.preserveSignatures || providerRequiresSignedThinking(params.provider);
  return (
    isAnthropicApi(params.modelApi) &&
    params.policy.validateAnthropicTurns &&
    hasProviderOwnedSignedThinking &&
    !params.policy.dropThinkingBlocks
  );
}

/**
 * Bedrock Converse still requires strict role alternation, so only the direct
 * Messages API keeps consecutive user turns separate under append-only replay.
 */
export function shouldMergeConsecutiveUserTurns(
  policy: Pick<TranscriptPolicy, "appendOnlyRuntimeContext">,
  modelApi?: string | null,
): boolean {
  return !(policy.appendOnlyRuntimeContext && modelApi === "anthropic-messages");
}

type AnthropicContentBlock = {
  type: "text" | "toolUse" | "toolCall" | "functionCall" | "toolResult" | "tool";
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
  toolCallId?: string;
};
type UserContentBlock = Extract<
  Extract<AgentMessage, { role: "user" }>["content"],
  readonly unknown[]
>[number];

function isToolCallBlock(block: AnthropicContentBlock): boolean {
  return block.type === "toolUse" || block.type === "toolCall" || block.type === "functionCall";
}

function isAbortedAssistantTurn(message: AgentMessage): boolean {
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return stopReason === "aborted" || stopReason === "error";
}

function extractToolResultMatchIds(record: object): Set<string> {
  const ids = new Set<string>();
  for (const value of [
    Reflect.get(record, "toolUseId"),
    Reflect.get(record, "toolCallId"),
    Reflect.get(record, "tool_use_id"),
    Reflect.get(record, "tool_call_id"),
    Reflect.get(record, "callId"),
    Reflect.get(record, "call_id"),
  ]) {
    const id = normalizeOptionalString(value);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function collectFutureToolResults(
  messages: AgentMessage[],
  startIndex: number,
): { ids: Set<string>; matches: Map<string, Set<string>> } {
  const ids = new Set<string>();
  const matches = new Map<string, Set<string>>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    const role = (candidate as { role?: unknown }).role;
    if (role === "assistant") {
      break;
    }
    const content = (candidate as { content?: unknown }).content;
    for (const block of Array.isArray(content) ? content : []) {
      if (
        block &&
        typeof block === "object" &&
        (block.type === "toolResult" || block.type === "tool")
      ) {
        for (const id of extractToolResultMatchIds(block)) {
          ids.add(id);
        }
      }
    }
    // Signed thinking requires a real result turn; embedded user content is not proof.
    if (role !== "toolResult" && role !== "tool") {
      continue;
    }
    const matchIds = extractToolResultMatchIds(candidate);
    if (role === "toolResult") {
      const canonicalId = extractToolResultId(
        candidate as Extract<AgentMessage, { role: "toolResult" }>,
      );
      if (canonicalId) {
        ids.add(canonicalId);
      }
    }
    const toolName =
      normalizeOptionalString(Reflect.get(candidate, "toolName")) ??
      normalizeOptionalString(Reflect.get(candidate, "name"));
    for (const id of matchIds) {
      if (role === "tool") {
        ids.add(id);
      }
      const bucket = matches.get(id) ?? new Set<string>();
      if (toolName) {
        bucket.add(toolName);
      }
      matches.set(id, bucket);
    }
  }
  return { ids, matches };
}

/**
 * Strips dangling tool-call blocks from assistant messages when no later
 * tool-result span before the next assistant turn resolves them.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (const [i, msg] of messages.entries()) {
    if (!msg) {
      continue;
    }
    if (typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (msgRole !== "assistant") {
      result.push(msg);
      continue;
    }

    const assistantMsg = msg as {
      content?: AnthropicContentBlock[];
    };
    const originalContent = Array.isArray(assistantMsg.content) ? assistantMsg.content : [];
    if (originalContent.length === 0) {
      result.push(msg);
      continue;
    }
    if (
      extractToolCallsFromAssistant(msg as Extract<AgentMessage, { role: "assistant" }>).length ===
      0
    ) {
      result.push(msg);
      continue;
    }
    const hasThinking = originalContent.some((block) => isThinkingLikeBlock(block));
    const { matches: validToolResultMatches, ids: validToolUseIds } = collectFutureToolResults(
      messages,
      i,
    );
    const omittedContent: AnthropicContentBlock[] = isAbortedAssistantTurn(msg)
      ? []
      : [{ type: "text", text: "[tool calls omitted]" }];

    let nextContent = originalContent;
    if (hasThinking) {
      const allToolCallsResolvable = originalContent.every((block) => {
        if (!block || !isToolCallBlock(block)) {
          return true;
        }
        const blockId = normalizeOptionalString(block.id);
        const blockName = normalizeOptionalString(block.name);
        if (!blockId || !blockName) {
          return false;
        }
        const matchingToolNames = validToolResultMatches.get(blockId);
        if (!matchingToolNames) {
          return false;
        }
        return matchingToolNames.size === 0 || matchingToolNames.has(blockName);
      });
      if (!allToolCallsResolvable) {
        nextContent = omittedContent;
      }
    } else {
      const filteredContent = originalContent.filter((block) => {
        if (!block) {
          return false;
        }
        if (!isToolCallBlock(block)) {
          return true;
        }
        const blockId = normalizeOptionalString(block.id);
        return blockId ? validToolUseIds.has(blockId) : false;
      });

      if (filteredContent.length !== originalContent.length) {
        nextContent = filteredContent.length === 0 ? omittedContent : filteredContent;
      }
    }
    result.push(
      nextContent === originalContent
        ? msg
        : ({ ...assistantMsg, content: nextContent } as AgentMessage),
    );
  }

  return result;
}

function validateTurnsWithConsecutiveMerge<TRole extends "assistant" | "user">(params: {
  messages: AgentMessage[];
  role: TRole;
  merge: (
    previous: Extract<AgentMessage, { role: TRole }>,
    current: Extract<AgentMessage, { role: TRole }>,
  ) => Extract<AgentMessage, { role: TRole }>;
}): AgentMessage[] {
  const { messages, role, merge } = params;
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: AgentMessage[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") {
      result.push(msg);
      continue;
    }

    const msgRole = (msg as { role?: unknown }).role as string | undefined;
    if (!msgRole) {
      result.push(msg);
      continue;
    }

    if (msgRole === lastRole && lastRole === role) {
      const lastMsg = result[result.length - 1];
      const currentMsg = msg as Extract<AgentMessage, { role: TRole }>;

      if (lastMsg && typeof lastMsg === "object") {
        const lastTyped = lastMsg as Extract<AgentMessage, { role: TRole }>;
        result[result.length - 1] = merge(lastTyped, currentMsg);
        continue;
      }
    }

    result.push(msg);
    lastRole = msgRole;
  }

  return result.length === messages.length ? messages : result;
}

function mergeConsecutiveAssistantTurns(
  previous: Extract<AgentMessage, { role: "assistant" }>,
  current: Extract<AgentMessage, { role: "assistant" }>,
): Extract<AgentMessage, { role: "assistant" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];
  return {
    ...previous,
    content: mergedContent,
    ...(current.usage && { usage: current.usage }),
    ...(current.stopReason && { stopReason: current.stopReason }),
    ...(current.errorMessage && {
      errorMessage: current.errorMessage,
    }),
  };
}

/** Merge consecutive assistant turns for Gemini's provider turn-order contract. */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    merge: mergeConsecutiveAssistantTurns,
  });
}

function mergeConsecutiveUserTurns(
  previous: Extract<AgentMessage, { role: "user" }>,
  current: Extract<AgentMessage, { role: "user" }>,
): Extract<AgentMessage, { role: "user" }> {
  const mergedContent = [
    ...normalizeUserContentForMerge(previous.content),
    ...normalizeUserContentForMerge(current.content),
  ];

  return {
    ...current,
    content: mergedContent,
    timestamp: current.timestamp ?? previous.timestamp,
  };
}

function normalizeUserContentForMerge(content: unknown): UserContentBlock[] {
  if (Array.isArray(content)) {
    return content as UserContentBlock[];
  }
  if (typeof content === "string") {
    return [{ type: "text", text: content }];
  }
  return [];
}

export const mergeConsecutiveUserMessages = (messages: AgentMessage[]): AgentMessage[] =>
  validateTurnsWithConsecutiveMerge({ messages, role: "user", merge: mergeConsecutiveUserTurns });

/**
 * Repair Anthropic tool-use/result pairing; user-turn merging stays optional
 * because prefix-bound signed replay must preserve the original turn bytes.
 */
export function validateAnthropicTurns(
  messages: AgentMessage[],
  options: { mergeConsecutiveUserTurns?: boolean } = {},
): AgentMessage[] {
  // Merge first so an injected assistant turn cannot hide the tool result that
  // resolves the preceding signed tool call. Stripping first would destroy the
  // active Anthropic tool-use turn before the adjacent turns can be repaired.
  const mergedAssistant = validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    merge: mergeConsecutiveAssistantTurns,
  });
  const stripped = stripDanglingAnthropicToolUses(mergedAssistant);

  // Merging user turns re-renders them as one multi-block message whose later
  // blocks never carry their own timestamp stamp, so the bytes differ from the
  // active turn that produced the following thinking signature. Prefix-bound
  // replay keeps consecutive user turns separate; the Messages API accepts them.
  if (options.mergeConsecutiveUserTurns === false) {
    return stripped;
  }
  return mergeConsecutiveUserMessages(stripped);
}
