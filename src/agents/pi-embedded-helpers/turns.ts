import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { extractToolCallsFromAssistant, extractToolResultId } from "../tool-call-id.js";

type AnthropicContentBlock = {
  type: "text" | "toolUse" | "toolCall" | "functionCall" | "toolResult" | "tool";
  text?: string;
  id?: string;
  name?: string;
  toolUseId?: string;
  toolCallId?: string;
};

function isToolCallBlock(block: AnthropicContentBlock): boolean {
  return block.type === "toolUse" || block.type === "toolCall" || block.type === "functionCall";
}

function isThinkingLikeBlock(block: unknown): boolean {
  if (!block || typeof block !== "object") {
    return false;
  }
  const type = (block as { type?: unknown }).type;
  return type === "thinking" || type === "redacted_thinking";
}

function isAbortedAssistantTurn(message: AgentMessage): boolean {
  const stopReason = (message as { stopReason?: unknown }).stopReason;
  return stopReason === "aborted" || stopReason === "error";
}

function isEffectivelyEmptyAssistantContent(message: AgentMessage): boolean {
  const content = (message as { content?: unknown }).content;
  if (content == null) {
    return true;
  }
  if (!Array.isArray(content)) {
    return typeof content === "string" && content.trim().length === 0;
  }
  if (content.length === 0) {
    return true;
  }
  return content.every((block) => {
    if (!block || typeof block !== "object") {
      return true;
    }
    const rec = block as { type?: unknown; text?: unknown };
    if (isThinkingLikeBlock(block)) {
      return true;
    }
    if (rec.type === "text") {
      return typeof rec.text !== "string" || rec.text.trim().length === 0;
    }
    return false;
  });
}

function isUnsendableTrailingAssistant(message: AgentMessage): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  if ((message as { role?: unknown }).role !== "assistant") {
    return false;
  }
  if (isEffectivelyEmptyAssistantContent(message)) {
    return true;
  }
  // Aborted/errored assistant turns without useful content cannot be the final
  // message in an Anthropic request — isEffectivelyEmptyAssistantContent above
  // already handles the thinking-only / empty-content cases.
  return false;
}

/**
 * Drops trailing assistant turns that would make an Anthropic request invalid.
 *
 * The Anthropic Messages API requires the conversation to end with a user
 * turn and rejects assistant turns with empty content. Several pipeline
 * steps can produce such trailing turns:
 *   - `stripDanglingAnthropicToolUses` empties aborted tool-only assistant
 *     messages when their tool_use blocks cannot be matched.
 *   - `filterHeartbeatPairs` removes `(user heartbeat, assistant HEARTBEAT_OK)`
 *     pairs, which can expose a prior assistant turn at the tail if no real
 *     user turn followed.
 *   - `limitHistoryTurns` can leave the tail unchanged (it slices from the
 *     oldest retained user turn) but subsequent tool pairing repair can
 *     reshape trailing blocks.
 *
 * This helper removes only unambiguously unsendable trailing assistant turns
 * (empty or aborted-with-no-content); it never drops an assistant turn that
 * still carries real model output.
 *
 * Maintainer note: this is a good upstream PR candidate for anyone else
 * using the pi-agent-core replay pipeline with Anthropic — the trailing
 * empty/aborted assistant case is not handled by `validateAnthropicTurns`
 * alone, and surfaces as opaque 400 errors from Opus 4.6/4.7.
 */
export function dropTrailingEmptyAssistantTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  let end = messages.length;
  while (end > 0 && isUnsendableTrailingAssistant(messages[end - 1])) {
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

/**
 * Returns true when the last message in the list is a user-like turn
 * (`user`, `toolResult`, or `tool` role), which Anthropic accepts as the
 * terminal message of a request.
 */
export function messagesEndWithUserTurn(messages: AgentMessage[]): boolean {
  if (!Array.isArray(messages) || messages.length === 0) {
    return false;
  }
  const last = messages[messages.length - 1];
  if (!last || typeof last !== "object") {
    return false;
  }
  const role = (last as { role?: unknown }).role;
  return role === "user" || role === "toolResult" || role === "tool";
}

function isUserLikeTurn(message: AgentMessage | undefined): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const role = (message as { role?: unknown }).role;
  return role === "user" || role === "toolResult" || role === "tool";
}

/**
 * Drops every trailing non-user turn until the transcript ends with a
 * user-like turn (`user`, `toolResult`, or `tool`). This is the safety net
 * for cases where a trailing assistant turn carries real but unsendable
 * content — for example, gateway-surfaced error text like
 * "API provider returned a billing error" or "LLM request rejected: this
 * model does not support assistant message prefill". These turns are not
 * empty or thinking-only, so `dropTrailingEmptyAssistantTurns` correctly
 * leaves them alone; the runner-level guard uses this helper as a final
 * pass immediately before sending the transcript to Anthropic so the
 * provider call cannot land on a `role: assistant` tail.
 *
 * Non-trailing assistant turns are never touched; real assistant replies
 * in the middle of the transcript remain intact.
 */
export function dropAllTrailingNonUserTurns(messages: AgentMessage[]): AgentMessage[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }
  let end = messages.length;
  while (end > 0 && !isUserLikeTurn(messages[end - 1])) {
    end -= 1;
  }
  return end === messages.length ? messages : messages.slice(0, end);
}

/**
 * Decides whether to short-circuit an Anthropic request because the request
 * would otherwise end on an `assistant` turn (which Anthropic rejects with
 * "This model does not support assistant message prefill"). The session
 * wrapper only appends a new user turn when the caller passes a non-empty
 * prompt or images, so when neither is available and the transcript still
 * ends with a non-empty assistant turn, we skip the provider call instead
 * of letting the API reject it.
 */
export function shouldShortCircuitForMissingUserTail(params: {
  validateAnthropicTurns: boolean;
  messages: AgentMessage[];
  promptText: string;
  hasImages: boolean;
}): boolean {
  if (!params.validateAnthropicTurns) {
    return false;
  }
  if (!Array.isArray(params.messages) || params.messages.length === 0) {
    return false;
  }
  const promptHasContent =
    typeof params.promptText === "string" && params.promptText.trim().length > 0;
  if (promptHasContent || params.hasImages) {
    return false;
  }
  if (messagesEndWithUserTurn(params.messages)) {
    return false;
  }
  // Only short-circuit when the trailing assistant turn carries real content.
  // Empty or aborted trailing assistants are removed by
  // `dropTrailingEmptyAssistantTurns` before the request is sent, so treating
  // them as a short-circuit trigger would be a false positive when a previous
  // attempt left a stale empty/aborted assistant in the session buffer.
  const last = params.messages[params.messages.length - 1];
  if (!last || typeof last !== "object") {
    return false;
  }
  if ((last as { role?: unknown }).role !== "assistant") {
    return false;
  }
  return !isEffectivelyEmptyAssistantContent(last);
}

function extractToolResultMatchIds(record: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const value of [
    record.toolUseId,
    record.toolCallId,
    record.tool_use_id,
    record.tool_call_id,
    record.callId,
    record.call_id,
  ]) {
    const id = normalizeOptionalString(value);
    if (id) {
      ids.add(id);
    }
  }
  return ids;
}

function extractToolResultMatchName(record: Record<string, unknown>): string | null {
  return normalizeOptionalString(record.toolName) ?? normalizeOptionalString(record.name) ?? null;
}

function collectAnyToolResultIds(message: AgentMessage): Set<string> {
  const ids = new Set<string>();
  const role = (message as { role?: unknown }).role;
  if (role === "toolResult") {
    const toolResultId = extractToolResultId(
      message as Extract<AgentMessage, { role: "toolResult" }>,
    );
    if (toolResultId) {
      ids.add(toolResultId);
    }
  } else if (role === "tool") {
    const record = message as unknown as Record<string, unknown>;
    for (const id of extractToolResultMatchIds(record)) {
      ids.add(id);
    }
  }

  const content = (message as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return ids;
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      continue;
    }
    const record = block as Record<string, unknown>;
    if (record.type !== "toolResult" && record.type !== "tool") {
      continue;
    }
    for (const id of extractToolResultMatchIds(record)) {
      ids.add(id);
    }
  }

  return ids;
}

function collectTrustedToolResultMatches(message: AgentMessage): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  const role = (message as { role?: unknown }).role;
  const addMatch = (ids: Iterable<string>, toolName: string | null) => {
    for (const id of ids) {
      const bucket = matches.get(id) ?? new Set<string>();
      if (toolName) {
        bucket.add(toolName);
      }
      matches.set(id, bucket);
    }
  };

  if (role === "toolResult") {
    const record = message as unknown as Record<string, unknown>;
    addMatch(
      [
        ...extractToolResultMatchIds(record),
        ...(() => {
          const canonicalId = extractToolResultId(
            message as Extract<AgentMessage, { role: "toolResult" }>,
          );
          return canonicalId ? [canonicalId] : [];
        })(),
      ],
      extractToolResultMatchName(record),
    );
  } else if (role === "tool") {
    const record = message as unknown as Record<string, unknown>;
    addMatch(extractToolResultMatchIds(record), extractToolResultMatchName(record));
  }

  return matches;
}

function collectFutureToolResultMatches(
  messages: AgentMessage[],
  startIndex: number,
): Map<string, Set<string>> {
  const matches = new Map<string, Set<string>>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role === "assistant") {
      break;
    }
    for (const [id, toolNames] of collectTrustedToolResultMatches(candidate)) {
      const bucket = matches.get(id) ?? new Set<string>();
      for (const toolName of toolNames) {
        bucket.add(toolName);
      }
      matches.set(id, bucket);
    }
  }
  return matches;
}

function collectFutureToolResultIds(messages: AgentMessage[], startIndex: number): Set<string> {
  const ids = new Set<string>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index];
    if (!candidate || typeof candidate !== "object") {
      continue;
    }
    if ((candidate as { role?: unknown }).role === "assistant") {
      break;
    }
    for (const id of collectAnyToolResultIds(candidate)) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Strips dangling tool-call blocks from assistant messages when no later
 * tool-result span before the next assistant turn resolves them.
 * This fixes the "tool_use ids found without tool_result blocks" error from Anthropic.
 */
function stripDanglingAnthropicToolUses(messages: AgentMessage[]): AgentMessage[] {
  const result: AgentMessage[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!msg || typeof msg !== "object") {
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
    const validToolResultMatches = collectFutureToolResultMatches(messages, i);
    const validToolUseIds = collectFutureToolResultIds(messages, i);

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
      if (allToolCallsResolvable) {
        result.push(msg);
      } else {
        result.push({
          ...assistantMsg,
          content: isAbortedAssistantTurn(msg)
            ? []
            : ([{ type: "text", text: "[tool calls omitted]" }] as AnthropicContentBlock[]),
        } as AgentMessage);
      }
      continue;
    }

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

    if (filteredContent.length === originalContent.length) {
      result.push(msg);
      continue;
    }

    if (originalContent.length > 0 && filteredContent.length === 0) {
      result.push({
        ...assistantMsg,
        content: isAbortedAssistantTurn(msg)
          ? []
          : ([{ type: "text", text: "[tool calls omitted]" }] as AnthropicContentBlock[]),
      } as AgentMessage);
    } else {
      result.push({
        ...assistantMsg,
        content: filteredContent,
      } as AgentMessage);
    }
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

  return result;
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

/**
 * Validates and fixes conversation turn sequences for Gemini API.
 * Gemini requires strict alternating user→assistant→tool→user pattern.
 * Merges consecutive assistant messages together.
 */
export function validateGeminiTurns(messages: AgentMessage[]): AgentMessage[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    merge: mergeConsecutiveAssistantTurns,
  });
}

export function mergeConsecutiveUserTurns(
  previous: Extract<AgentMessage, { role: "user" }>,
  current: Extract<AgentMessage, { role: "user" }>,
): Extract<AgentMessage, { role: "user" }> {
  const mergedContent = [
    ...(Array.isArray(previous.content) ? previous.content : []),
    ...(Array.isArray(current.content) ? current.content : []),
  ];

  return {
    ...current,
    content: mergedContent,
    timestamp: current.timestamp ?? previous.timestamp,
  };
}

/**
 * Validates and fixes conversation turn sequences for Anthropic API.
 * Anthropic requires strict alternating user→assistant pattern and the
 * conversation must end with a user-role turn. This helper:
 *   1. Strips dangling tool_use blocks that lack matching tool_result blocks
 *      (which can leave aborted assistant turns with empty content).
 *   2. Merges consecutive user messages together.
 *   3. Drops trailing empty/aborted assistant turns exposed by step 1 so the
 *      transcript still ends on a valid user-like turn.
 */
export function validateAnthropicTurns(messages: AgentMessage[]): AgentMessage[] {
  // First, strip dangling tool-call blocks from assistant messages.
  const stripped = stripDanglingAnthropicToolUses(messages);

  const merged = validateTurnsWithConsecutiveMerge({
    messages: stripped,
    role: "user",
    merge: mergeConsecutiveUserTurns,
  });

  // After stripping tool_use blocks, a trailing assistant turn can end up
  // with empty content (e.g. aborted/errored retries). Those are not a
  // valid terminal message for Anthropic, so drop them here too.
  return dropTrailingEmptyAssistantTurns(merged);
}
