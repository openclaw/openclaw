import { isDeepStrictEqual } from "node:util";
import { asFiniteNumber as toFiniteCostNumber } from "@openclaw/normalization-core/number-coercion";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import {
  isReasoningOnlyLengthAssistantTurn,
  isStreamErrorFallbackContent,
} from "../../../packages/ai/src/replay-turn-classification.js";
import { readOpenAIResponsesItemRecoveryAnchor } from "../../../packages/ai/src/transports/openai-responses-compaction-replay.js";
import { isCompactionReplayCheckpoint } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import { replaceCompactionReplayOwnerContent } from "../../../packages/ai/src/transports/provider-compaction-replay.js";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";
import { isSilentAssistantTranscriptMessage } from "../../shared/chat-message-content.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  isTranscriptOnlyOpenClawAssistantMessage,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "../compaction-usage.js";
import type { sanitizeSessionMessagesImages } from "../embedded-agent-helpers/images.js";
import {
  dropStaleOpenAIReasoning,
  normalizeOpenAIResponsesToolCallIds,
} from "../embedded-agent-helpers/openai.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairingForModel,
  stripToolResultDetails,
} from "../session-transcript-repair.js";
import { stripStaleThinkingSignaturesForCompactionReplay } from "../thinking-signatures.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultId,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "../tool-call-id.js";
import { createCompletedToolCallPredicate } from "../tool-call-shared.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type AssistantUsageSnapshot,
  type UsageLike,
} from "../usage.js";
import { isZeroUsageEmptyStopAssistantTurn } from "./empty-assistant-turn.js";
import type { GenericReplayHistoryParams } from "./replay-history.types.js";
import type {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  shouldPreserveLatestAssistantThinking,
  stripInvalidThinkingSignatures,
} from "./thinking.js";

const MANAGED_DISPLAY_BLOCK_TYPES = new Set([
  "attachment",
  "attachment_error",
  "audio",
  "image",
  "video",
]);
type AssistantReplayMessage = Extract<AgentMessage, { role: "assistant" }>;
// Only immutable publications qualify; replacing a transcript message starts a new revision.
const normalizedReplayMessages = new WeakMap<AgentMessage, AgentMessage | null>();

function sanitizeUserReplayContent(
  message: Extract<AgentMessage, { role: "user" }>,
): AgentMessage | null {
  const replayContent = message.content;
  if (typeof replayContent === "string") {
    return replayContent.trim() || hasPersistedMedia(message) ? message : null;
  }
  if (!Array.isArray(replayContent)) {
    return message;
  }

  let touched = false;
  const sanitizedContent = replayContent.filter((block) => {
    const record = asOptionalObjectRecord(block);
    const keep =
      record?.type !== "text" || typeof record.text !== "string" || Boolean(record.text.trim());
    touched ||= !keep;
    return keep;
  });
  if (sanitizedContent.length === 0) {
    return hasPersistedMedia(message) ? { ...message, content: "" } : null;
  }
  return touched ? { ...message, content: sanitizedContent } : message;
}

function normalizeAssistantReplayBlockContent(
  message: AssistantReplayMessage,
  replayContent: AssistantReplayMessage["content"],
): AssistantReplayMessage | null {
  let touched = false;
  const sanitizedContent: AssistantReplayMessage["content"] = [];
  for (const block of replayContent) {
    const record = asOptionalRecord(block);
    const type = record?.type;
    if (typeof type === "string" && MANAGED_DISPLAY_BLOCK_TYPES.has(type)) {
      touched = true;
      continue;
    }
    const text = record?.text;
    if (typeof text !== "string") {
      sanitizedContent.push(block);
      continue;
    }
    const strippedText = stripInternalMetadataForDisplay(text);
    const trimmed = strippedText.trim();
    if (strippedText === text) {
      sanitizedContent.push(block);
      continue;
    }
    touched = true;
    if (trimmed) {
      const sanitizedBlock = { ...block, text: strippedText };
      sanitizedContent.push(sanitizedBlock);
    }
  }
  const spoken = message.openclawDelivery?.tts?.text;
  if (
    spoken?.trim() &&
    !sanitizedContent.some((block) => {
      const record = asOptionalRecord(block);
      return (
        record?.type === "toolCall" ||
        (record?.type === "text" && typeof record.text === "string" && record.text.trim())
      );
    })
  ) {
    // Restore speech only in model history; the stored and displayed turn stays unchanged.
    sanitizedContent.push({ type: "text", text: spoken });
    touched = true;
  }
  if (!touched) {
    return message;
  }
  if (sanitizedContent.length === 0) {
    return null;
  }
  return replaceCompactionReplayOwnerContent(message, sanitizedContent);
}

function isBareDeliveryMirrorDuplicate(out: AgentMessage[], next: AssistantReplayMessage): boolean {
  // Canonical automation results are visible conversation turns, not mirrors,
  // even when they repeat the preceding reply without using model tokens.
  if (
    next.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER &&
    next.model === "automation-result"
  ) {
    return false;
  }
  const previous = out.at(-1);
  if (!previous || previous.role !== "assistant") {
    return false;
  }
  const usage = next.usage;
  if (
    !usage ||
    typeof usage !== "object" ||
    hasNonzeroUsage(normalizeUsage(usage)) ||
    next.stopReason !== "stop" ||
    extractToolCallsFromAssistant(previous).length > 0 ||
    extractToolCallsFromAssistant(next).length > 0
  ) {
    return false;
  }
  const previousContent = previous.content;
  const nextContent = next.content;
  return (
    Array.isArray(previousContent) &&
    previousContent.length > 0 &&
    Array.isArray(nextContent) &&
    isDeepStrictEqual(previousContent, nextContent)
  );
}

function normalizeAssistantReplayMessage(
  message: AssistantReplayMessage,
): AssistantReplayMessage | null {
  if (isTranscriptOnlyOpenClawAssistantMessage(message)) {
    // Drop from the in-memory replay copy; the persisted JSONL keeps the
    // entry so user-facing transcript surfaces are unchanged.
    return null;
  }
  // Empty failed or aborted attempts have no model content; discard the legacy placeholder too.
  // Keep billed silent replies and incomplete tool/length states unchanged.
  if (
    isStreamErrorFallbackContent(message.content) &&
    (message.stopReason === "error" ||
      message.stopReason === "aborted" ||
      (isZeroUsageEmptyStopAssistantTurn({ ...message, content: [] }) &&
        !isCompactionReplayCheckpoint(message.providerReplay)))
  ) {
    return null;
  }
  const replayContent = message.content;
  // Hidden transcript rows still belong to model context, including tool-call/result pairs.
  if (asOptionalRecord(message)?.display !== false && isSilentAssistantTranscriptMessage(message)) {
    return null;
  }
  if (typeof replayContent === "string") {
    const strippedText = stripInternalMetadataForDisplay(replayContent);
    const trimmed = strippedText.trim();
    return !trimmed
      ? null
      : replaceCompactionReplayOwnerContent(message, [{ type: "text", text: strippedText }]);
  }
  const blockContent = Array.isArray(replayContent)
    ? replayContent
    : replayContent != null && typeof replayContent === "object"
      ? [replayContent]
      : [];
  const assistantMessage =
    blockContent === replayContent
      ? message
      : replaceCompactionReplayOwnerContent(message, blockContent);
  const normalized = normalizeAssistantReplayBlockContent(assistantMessage, blockContent);
  // Token-limited thinking is incomplete provider state. Replaying it can
  // resend a partial signature, while visible text or tool calls remain useful.
  if (!normalized || isReasoningOnlyLengthAssistantTurn(normalized)) {
    return null;
  }
  return normalized;
}

export function normalizeAssistantReplayContent(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  let isCompletedToolCall: ReturnType<typeof createCompletedToolCallPredicate> | undefined;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      out.push(message);
      continue;
    }
    let normalized = normalizedReplayMessages.get(message);
    if (normalized === undefined) {
      normalized =
        message.role === "user"
          ? sanitizeUserReplayContent(message)
          : normalizeAssistantReplayMessage(message);
      if (isOwnedTranscriptPayload(message)) {
        normalizedReplayMessages.set(
          message,
          normalized === message ? message : freezeJsonSnapshot(normalized),
        );
      }
    }
    // Mirrors depend on the preceding replay turn; newly appended tool results below
    // can also repair an older failed turn. Neither decision belongs in the memo.
    if (
      normalized?.role === "assistant" &&
      typeof message.content !== "string" &&
      isBareDeliveryMirrorDuplicate(out, normalized)
    ) {
      normalized = null;
    }
    if (
      normalized?.role === "assistant" &&
      (normalized.stopReason === "error" || normalized.stopReason === "aborted") &&
      normalized.content.some((block) => block.type === "toolCall")
    ) {
      const completedToolCall = (isCompletedToolCall ??=
        createCompletedToolCallPredicate(messages));
      if (
        normalized.content.some((block) => block.type === "toolCall" && completedToolCall(block))
      ) {
        // Signed thinking belongs to the completed calls; the failed source stays intact for display.
        const completed = normalized.content.filter(
          (block) =>
            block.type !== "text" && (block.type !== "toolCall" || completedToolCall(block)),
        );
        normalized = {
          ...replaceCompactionReplayOwnerContent(normalized, completed),
          stopReason: "toolUse",
        };
      } else {
        normalized = null;
      }
    }
    if (
      !normalized &&
      message.role === "assistant" &&
      readOpenAIResponsesItemRecoveryAnchor(message.providerReplay) !== undefined
    ) {
      // Discarded content must not discard the provider's durable recovery boundary.
      normalized = replaceCompactionReplayOwnerContent(message, []);
    }
    if (normalized) {
      out.push(normalized);
    }
    touched ||= normalized !== message;
  }
  return touched ? out : messages;
}

function normalizeAssistantUsageSnapshot(usage: UsageLike | null | undefined) {
  const normalized = normalizeUsage(usage);
  if (!normalized) {
    return makeZeroUsageSnapshot();
  }
  const input = normalized.input ?? 0;
  const output = normalized.output ?? 0;
  const cacheRead = normalized.cacheRead ?? 0;
  const cacheWrite = normalized.cacheWrite ?? 0;
  const totalTokens = normalized.total ?? input + output + cacheRead + cacheWrite;
  const cost = normalizeAssistantUsageCost(usage);
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    ...(normalized.contextUsage ? { contextUsage: { ...normalized.contextUsage } } : {}),
    totalTokens,
    ...(cost ? { cost } : {}),
  };
}

function normalizeAssistantUsageCost(usage: unknown): AssistantUsageSnapshot["cost"] | undefined {
  const cost = asOptionalObjectRecord(asOptionalObjectRecord(usage)?.cost);
  if (!cost) {
    return undefined;
  }
  const values = ["input", "output", "cacheRead", "cacheWrite", "total"].map((field) =>
    toFiniteCostNumber(cost[field]),
  );
  if (values.every((value) => value === undefined)) {
    return undefined;
  }
  const [
    input = 0,
    output = 0,
    cacheRead = 0,
    cacheWrite = 0,
    total = input + output + cacheRead + cacheWrite,
  ] = values;
  // Keep authoritative provider billing provenance through replay repair. Dropping it
  // turns a real zero-dollar total back into a local estimate during later accounting.
  const totalOrigin = cost.totalOrigin === "provider-billed" ? cost.totalOrigin : undefined;
  return { input, output, cacheRead, cacheWrite, total, ...(totalOrigin ? { totalOrigin } : {}) };
}

function ensureAssistantUsageSnapshots(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = [...messages];
  for (let i = 0; i < out.length; i += 1) {
    const message = out[i];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const normalizedUsage = normalizeAssistantUsageSnapshot(message.usage);
    const usage = asOptionalObjectRecord(message.usage);
    const usageCost = asOptionalObjectRecord(usage?.cost);
    const rawContextUsage = asOptionalObjectRecord(usage?.contextUsage);
    const normalizedContextUsage = normalizedUsage.contextUsage;
    const contextUsageMatches =
      normalizedContextUsage === undefined
        ? usage?.contextUsage === undefined
        : rawContextUsage?.state === normalizedContextUsage.state &&
          (normalizedContextUsage.state === "unavailable" ||
            (rawContextUsage.promptTokens === normalizedContextUsage.promptTokens &&
              rawContextUsage.totalTokens === normalizedContextUsage.totalTokens));
    const normalizedCost = normalizedUsage.cost;
    if (
      usage &&
      (["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const).every(
        (field) => usage[field] === normalizedUsage[field],
      ) &&
      contextUsageMatches &&
      (normalizedCost
        ? usageCost &&
          (["input", "output", "cacheRead", "cacheWrite", "total"] as const).every(
            (field) => usageCost[field] === normalizedCost[field],
          )
        : usage.cost === undefined)
    ) {
      continue;
    }
    out[i] = {
      ...message,
      // Do not synthesize billing evidence for sparse legacy usage.
      // SAFETY: Token fields are canonical; replay consumers accept missing cost via normalizeUsage.
      usage: normalizedUsage as AssistantUsageSnapshot,
    };
    touched = true;
  }

  return touched ? out : messages;
}

function formatOpenAIResponsesReplayInvariantError(params: {
  reason: "dangling_tool_call" | "orphan_tool_result";
  toolCallId?: string;
  messageIndex: number;
}): Error {
  const toolCallId = params.toolCallId ? ` toolCallId=${params.toolCallId}` : "";
  return new Error(
    `invalid_replay_transcript: OpenAI Responses replay contains ${params.reason}${toolCallId} at message index ${params.messageIndex}`,
  );
}

function assertOpenAIResponsesToolUseResultInvariant(messages: AgentMessage[]): AgentMessage[] {
  const pending = new Map<string, number>();
  const assertNoPendingCalls = () => {
    const dangling = pending.entries().next().value;
    if (dangling) {
      throw formatOpenAIResponsesReplayInvariantError({
        reason: "dangling_tool_call",
        toolCallId: dangling[0],
        messageIndex: dangling[1],
      });
    }
  };

  for (let i = 0; i < messages.length; i += 1) {
    const message = messages[i];
    const role = message?.role;

    if (role !== "toolResult") {
      assertNoPendingCalls();
    }

    if (!message || typeof message !== "object") {
      continue;
    }

    if (message.role === "toolResult") {
      const toolCallId = extractToolResultId(message);
      if (!toolCallId || !pending.delete(toolCallId)) {
        throw formatOpenAIResponsesReplayInvariantError({
          reason: "orphan_tool_result",
          ...(toolCallId ? { toolCallId } : {}),
          messageIndex: i,
        });
      }
      continue;
    }

    if (message.role !== "assistant") {
      continue;
    }

    for (const toolCall of extractToolCallsFromAssistant(message)) {
      pending.set(toolCall.id, i);
    }
  }

  assertNoPendingCalls();
  return messages;
}

/**
 * Canonical data transforms supplied locally by the execution owner, never serialized.
 * Keeping these dependencies explicit avoids loading image backends or the stream-recovery
 * runtime (and its provider registry) when importing the data-only replay owner.
 */
export type ReplayHistorySanitizers = {
  sanitizeSessionMessagesImages: typeof sanitizeSessionMessagesImages;
  shouldPreserveLatestAssistantThinking: typeof shouldPreserveLatestAssistantThinking;
  stripInvalidThinkingSignatures: typeof stripInvalidThinkingSignatures;
  dropReasoningFromHistory: typeof dropReasoningFromHistory;
  dropThinkingBlocks: typeof dropThinkingBlocks;
};

/** Data-only cleanup before provider hooks. Policy and route facts are host-resolved. */
export async function sanitizeGenericReplayHistory(
  params: GenericReplayHistoryParams,
  sanitizers: ReplayHistorySanitizers,
): Promise<AgentMessage[]> {
  const { policy } = params;
  const normalizedAssistantReplay = normalizeAssistantReplayContent(params.messages);
  const sanitizedImages = await sanitizers.sanitizeSessionMessagesImages(
    normalizedAssistantReplay,
    "session:history",
    {
      sanitizeMode: policy.sanitizeMode,
      // Pair raw provider-id occurrences before rewriting ids. On a damaged transcript,
      // FIFO id rewriting can otherwise bind a later-adjacent result to an older call.
      sanitizeToolCallIds: false,
      toolCallIdMode: policy.toolCallIdMode,
      duplicateToolCallIdStyle: policy.duplicateToolCallIdStyle,
      preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
      preserveSignatures: policy.preserveSignatures,
      sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
      ...params.imageLimits,
    },
  );
  const preserveLatestAssistantThinking =
    params.preserveLatestAssistantThinking ??
    sanitizers.shouldPreserveLatestAssistantThinking(sanitizedImages);
  // Strip thinking signatures that are stale due to compaction context changes before
  // stripInvalidThinkingSignatures runs. Pre-compaction kept messages carry signatures
  // bound to the original prefix; after compaction the prefix changes and Anthropic
  // rejects them. Timestamp comparison with the latest compaction summary identifies
  // the affected messages regardless of which compaction path produced them.
  // Some recovery paths supply a narrow policy with preserveSignatures disabled.
  // Native signed-thinking providers still cannot replay missing/blank
  // signatures once the assistant turn is no longer latest in the outbound
  // request.
  let messages = sanitizedImages;
  if (params.signedThinkingProvider || policy.preserveSignatures) {
    messages = sanitizers.stripInvalidThinkingSignatures(
      stripStaleThinkingSignaturesForCompactionReplay(messages),
      { preserveLatestAssistant: preserveLatestAssistantThinking },
    );
  }
  if (policy.dropReasoningFromHistory) {
    messages = sanitizers.dropReasoningFromHistory(messages);
  }
  if (policy.dropThinkingBlocks) {
    messages = sanitizers.dropThinkingBlocks(messages);
  }
  messages = sanitizeToolCallInputs(messages, {
    allowedToolNames: params.allowedToolNames,
    allowProviderOwnedThinkingReplay: params.allowProviderOwnedThinkingReplay,
  });
  // Repair missing tool results before normalizing paired call/result ids.
  if (policy.repairToolUseResultPairing) {
    messages = sanitizeToolUseResultPairingForModel(messages, params.isOpenAIResponsesApi);
  }
  if (params.isOpenAIResponsesApi) {
    messages = normalizeOpenAIResponsesToolCallIds(
      // Keep the pre-switch prompt prefix byte-stable: once rs_*/msg_* ids are
      // invalidated by a switch, every later replay must keep dropping them.
      dropStaleOpenAIReasoning(messages, params.latestModelSwitchTimestamp ?? undefined),
    );
  } else if (policy.sanitizeToolCallIds && policy.toolCallIdMode) {
    messages = sanitizeToolCallIdsForCloudCodeAssist(messages, policy.toolCallIdMode, {
      preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
      duplicateToolCallIdStyle: policy.duplicateToolCallIdStyle,
      preserveReplaySafeThinkingToolCallIds: params.allowProviderOwnedThinkingReplay,
      allowedToolNames: params.allowedToolNames,
    });
  }
  messages = ensureAssistantUsageSnapshots(
    stripStaleAssistantUsageBeforeLatestCompaction(stripToolResultDetails(messages)),
  );
  return messages;
}

/** Provider hooks may rewrite history; the host invokes this before any snapshot append. */
export function sanitizeReplayHistoryAfterProviderHooks(
  messages: AgentMessage[],
  params: Pick<GenericReplayHistoryParams, "isOpenAIResponsesApi" | "policy">,
): AgentMessage[] {
  if (!params.isOpenAIResponsesApi) {
    return messages;
  }
  const pairedMessages = params.policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(messages, true)
    : messages;
  return assertOpenAIResponsesToolUseResultInvariant(pairedMessages);
}
