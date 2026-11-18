import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasRuntimeContextMarker } from "../../llm/types.js";
import { projectRecordedModelPrompt } from "../../sessions/user-turn-transcript.message.js";
import type { PersistedUserTurnMessage } from "../../sessions/user-turn-transcript.types.js";
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
 * Messages API keeps consecutive turns separate under append-only replay.
 */
export function shouldMergeConsecutiveTurns(
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

/**
 * Value access and transformations for the shared turn-validation owner. Accessors
 * preserve the array replay rules: call IDs/names and result aliases are trimmed,
 * but extractToolCalls recognizes nonempty raw IDs (including whitespace-only IDs).
 * Content is only an array; absent/non-array content returns undefined.
 */
export interface ReplayTurnAdapter<T, B> {
  /** Distinguish falsy rows, truthy nonobjects, and objects, including roleless rows. */
  messageKind(message: T): "empty" | "opaque" | "record";
  role(message: T): string | undefined;
  content(message: T): readonly B[] | undefined;
  isPresentBlock(block: B): boolean;
  isThinking(block: B): boolean;
  isCall(block: B): boolean;
  callId(block: B): string | undefined;
  callName(block: B): string | undefined;
  extractToolCalls(message: T): readonly { id: string; name?: string }[];
  isResultBlock(block: B): boolean;
  resultMatchIds(value: T | B): Iterable<string>;
  resultCanonicalId(message: T): string | null | undefined;
  toolName(message: T): string | undefined;
  stopReason(message: T): string | undefined;
  /** "omitted" means one text block containing "[tool calls omitted]". */
  replaceContent(message: T, content: readonly B[] | "omitted"): T;
  mergeAssistant(previous: T, current: T): T;
  mergeUser(previous: T, current: T): T;
  canMergeUser(message: T): boolean;
}

function collectFutureToolResults<T, B>(
  messages: T[],
  startIndex: number,
  adapter: ReplayTurnAdapter<T, B>,
): { ids: Set<string>; matches: Map<string, Set<string>> } {
  const ids = new Set<string>();
  const matches = new Map<string, Set<string>>();
  for (let index = startIndex + 1; index < messages.length; index += 1) {
    const candidate = messages[index]!;
    if (adapter.messageKind(candidate) !== "record") {
      continue;
    }
    const role = adapter.role(candidate);
    // Text-only assistant interruptions do not own the following tool results.
    if (role === "assistant" && adapter.extractToolCalls(candidate).length > 0) {
      break;
    }
    for (const block of adapter.content(candidate) ?? []) {
      if (adapter.isResultBlock(block)) {
        for (const id of adapter.resultMatchIds(block)) {
          ids.add(id);
        }
      }
    }
    // Signed thinking requires a real result turn; embedded user content is not proof.
    if (role !== "toolResult" && role !== "tool") {
      continue;
    }
    const matchIds = adapter.resultMatchIds(candidate);
    if (role === "toolResult") {
      const canonicalId = adapter.resultCanonicalId(candidate);
      if (canonicalId) {
        ids.add(canonicalId);
      }
    }
    const toolName = adapter.toolName(candidate);
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

/** Remove unresolved calls, keeping signed thinking and its calls atomic. */
function stripDanglingAnthropicToolUses<T, B>(
  messages: T[],
  adapter: ReplayTurnAdapter<T, B>,
): T[] {
  const result: T[] = [];

  for (const [i, msg] of messages.entries()) {
    const kind = adapter.messageKind(msg);
    if (kind === "empty") {
      continue;
    }
    if (kind !== "record" || adapter.role(msg) !== "assistant") {
      result.push(msg);
      continue;
    }

    const originalContent = adapter.content(msg) ?? [];
    if (originalContent.length === 0 || adapter.extractToolCalls(msg).length === 0) {
      result.push(msg);
      continue;
    }
    const hasThinking = originalContent.some((block) => adapter.isThinking(block));
    const { matches: validToolResultMatches, ids: validToolUseIds } = collectFutureToolResults(
      messages,
      i,
      adapter,
    );
    const stopReason = adapter.stopReason(msg);
    const omittedContent = stopReason === "aborted" || stopReason === "error" ? [] : "omitted";

    let nextContent: readonly B[] | "omitted" = originalContent;
    if (hasThinking) {
      const allToolCallsResolvable = originalContent.every((block) => {
        if (!adapter.isPresentBlock(block) || !adapter.isCall(block)) {
          return true;
        }
        const blockId = adapter.callId(block);
        const blockName = adapter.callName(block);
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
        if (!adapter.isPresentBlock(block)) {
          return false;
        }
        if (!adapter.isCall(block)) {
          return true;
        }
        const blockId = adapter.callId(block);
        return blockId ? validToolUseIds.has(blockId) : false;
      });

      if (filteredContent.length !== originalContent.length) {
        nextContent = filteredContent.length === 0 ? omittedContent : filteredContent;
      }
    }
    result.push(nextContent === originalContent ? msg : adapter.replaceContent(msg, nextContent));
  }

  return result;
}

function validateTurnsWithConsecutiveMerge<T, B>(params: {
  messages: T[];
  role: "assistant" | "user";
  adapter: ReplayTurnAdapter<T, B>;
  merge: (previous: T, current: T) => T;
  canMerge?: (message: T) => boolean;
}): T[] {
  const { messages, role, adapter, merge } = params;
  if (!Array.isArray(messages) || messages.length === 0) {
    return messages;
  }

  const result: T[] = [];
  let lastRole: string | undefined;

  for (const msg of messages) {
    const msgRole = adapter.messageKind(msg) === "record" ? adapter.role(msg) : undefined;
    if (msgRole) {
      if (msgRole === lastRole && lastRole === role) {
        const lastMsg = result[result.length - 1]!;
        if (adapter.messageKind(lastMsg) === "record") {
          if (!params.canMerge || (params.canMerge(lastMsg) && params.canMerge(msg))) {
            result[result.length - 1] = merge(lastMsg, msg);
            continue;
          }
        }
      }
      lastRole = msgRole;
    }
    result.push(msg);
  }

  return result.length === messages.length ? messages : result;
}

export function validateGeminiTurnsWithAdapter<T, B>(
  messages: T[],
  adapter: ReplayTurnAdapter<T, B>,
): T[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "assistant",
    adapter,
    merge: (previous, current) => adapter.mergeAssistant(previous, current),
  });
}

export function mergeConsecutiveUserMessagesWithAdapter<T, B>(
  messages: T[],
  adapter: ReplayTurnAdapter<T, B>,
  options: { preserveContextBoundaries?: boolean } = {},
): T[] {
  return validateTurnsWithConsecutiveMerge({
    messages,
    role: "user",
    adapter,
    merge: (previous, current) => adapter.mergeUser(previous, current),
    canMerge: options.preserveContextBoundaries
      ? (message) => adapter.canMergeUser(message)
      : undefined,
  });
}

export function validateAnthropicTurnsWithAdapter<T, B>(
  messages: T[],
  adapter: ReplayTurnAdapter<T, B>,
  options: { mergeConsecutiveTurns?: boolean; mergeConsecutiveUserTurns?: boolean } = {},
): T[] {
  // Direct Messages accepts consecutive roles; merging rewrites signed prefix bytes.
  if (options.mergeConsecutiveTurns === false) {
    return stripDanglingAnthropicToolUses(messages, adapter);
  }
  const mergedAssistant = validateGeminiTurnsWithAdapter(messages, adapter);
  const paired = stripDanglingAnthropicToolUses(mergedAssistant, adapter);
  return options.mergeConsecutiveUserTurns === false
    ? paired
    : mergeConsecutiveUserMessagesWithAdapter(paired, adapter);
}

/** Shared decision owner for payload arrays and payload-free replay facts. */
export function validateReplayTurnsWithAdapter<T, B>(
  messages: T[],
  policy: Pick<
    TranscriptPolicy,
    "validateGeminiTurns" | "validateAnthropicTurns" | "appendOnlyRuntimeContext"
  >,
  modelApi: string | null | undefined,
  adapter: ReplayTurnAdapter<T, B>,
  preserveUserTurns?: boolean,
): T[] {
  const gemini = policy.validateGeminiTurns
    ? validateGeminiTurnsWithAdapter(messages, adapter)
    : messages;
  return policy.validateAnthropicTurns
    ? validateAnthropicTurnsWithAdapter(gemini, adapter, {
        mergeConsecutiveTurns: shouldMergeConsecutiveTurns(policy, modelApi),
        mergeConsecutiveUserTurns: !preserveUserTurns,
      })
    : gemini;
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
  return validateGeminiTurnsWithAdapter(messages, agentMessageReplayTurnAdapter);
}

function mergeConsecutiveUserTurns(
  previous: PersistedUserTurnMessage,
  current: PersistedUserTurnMessage,
): Extract<AgentMessage, { role: "user" }> {
  // Materialize each row before merging so the newest projection cannot replace
  // the first text block of the combined turn on later replay.
  const previousMessage = projectRecordedModelPrompt(previous);
  const currentMessage = projectRecordedModelPrompt(current);
  const mergedContent = [
    ...normalizeUserContentForMerge(previousMessage.content),
    ...normalizeUserContentForMerge(currentMessage.content),
  ];

  return {
    ...currentMessage,
    content: mergedContent,
    timestamp: currentMessage.timestamp ?? previousMessage.timestamp,
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

const agentMessageReplayTurnAdapter: ReplayTurnAdapter<AgentMessage, AnthropicContentBlock> = {
  messageKind: (message) =>
    !message ? "empty" : typeof message === "object" ? "record" : "opaque",
  role: (message) => message.role,
  content: (message) =>
    "content" in message && Array.isArray(message.content)
      ? (message.content as AnthropicContentBlock[])
      : undefined,
  isPresentBlock: (block) => Boolean(block),
  isThinking: isThinkingLikeBlock,
  isCall: isToolCallBlock,
  callId: (block) => normalizeOptionalString(block.id),
  callName: (block) => normalizeOptionalString(block.name),
  extractToolCalls: (message) =>
    extractToolCallsFromAssistant(message as Extract<AgentMessage, { role: "assistant" }>),
  isResultBlock: (block) =>
    Boolean(block) &&
    typeof block === "object" &&
    (block.type === "toolResult" || block.type === "tool"),
  resultMatchIds: extractToolResultMatchIds,
  resultCanonicalId: (message) =>
    extractToolResultId(message as Extract<AgentMessage, { role: "toolResult" }>),
  toolName: (message) =>
    normalizeOptionalString(Reflect.get(message, "toolName")) ??
    normalizeOptionalString(Reflect.get(message, "name")),
  stopReason: (message) => (message as Extract<AgentMessage, { role: "assistant" }>).stopReason,
  replaceContent: (message, content) =>
    ({
      ...message,
      content: content === "omitted" ? [{ type: "text", text: "[tool calls omitted]" }] : content,
    }) as AgentMessage,
  mergeAssistant: (previous, current) =>
    mergeConsecutiveAssistantTurns(
      previous as Extract<AgentMessage, { role: "assistant" }>,
      current as Extract<AgentMessage, { role: "assistant" }>,
    ),
  mergeUser: (previous, current) =>
    mergeConsecutiveUserTurns(
      previous as PersistedUserTurnMessage,
      current as PersistedUserTurnMessage,
    ),
  // Carriers, operator updates and synthetic context own their authority, cache and media facts.
  canMergeUser: (message) => {
    const user = message as PersistedUserTurnMessage;
    return !hasRuntimeContextMarker(user) && !user.operatorMessage && !user.synthetic;
  },
};

export const mergeConsecutiveUserMessages = (
  messages: AgentMessage[],
  options: { preserveContextBoundaries?: boolean } = {},
): AgentMessage[] =>
  mergeConsecutiveUserMessagesWithAdapter(messages, agentMessageReplayTurnAdapter, options);

/**
 * Repair Anthropic tool-use/result pairing; turn merging stays optional
 * because prefix-bound signed replay must preserve the original turn bytes.
 */
export function validateAnthropicTurns(
  messages: AgentMessage[],
  options: { mergeConsecutiveTurns?: boolean; mergeConsecutiveUserTurns?: boolean } = {},
): AgentMessage[] {
  return validateAnthropicTurnsWithAdapter(messages, agentMessageReplayTurnAdapter, options);
}

/** Generic validation follows provider-owned rewrites in both ordinary and retained replay. */
export function validateReplayTurnsForPolicy(
  messages: AgentMessage[],
  policy: TranscriptPolicy,
  modelApi?: string | null,
  preserveUserTurns?: boolean,
): AgentMessage[] {
  return validateReplayTurnsWithAdapter(
    messages,
    policy,
    modelApi,
    agentMessageReplayTurnAdapter,
    preserveUserTurns,
  );
}
