import { isDeepStrictEqual } from "node:util";
import {
  isReasoningOnlyLengthAssistantTurn,
  isStreamErrorFallbackContent,
} from "@openclaw/ai/internal/shared";
import {
  isCompactionReplayCheckpoint,
  readOpenAIResponsesItemRecoveryAnchor,
  replaceCompactionReplayOwnerContent,
} from "@openclaw/ai/transports";
import { asFiniteNumber as toFiniteCostNumber } from "@openclaw/normalization-core/number-coercion";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import { isOwnedTranscriptPayload } from "../../config/sessions/transcript-json.js";
import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";
import { isSilentAssistantTranscriptMessage } from "../../shared/chat-message-content.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import {
  isTranscriptOnlyOpenClawAssistantMessage,
  OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER,
} from "../../shared/transcript-only-openclaw-assistant.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "../compaction-usage.js";
import { sanitizeSessionMessagesImages } from "../embedded-agent-helpers/images.js";
import {
  dropStaleOpenAIReasoning,
  normalizeOpenAIResponsesToolCallIds,
} from "../embedded-agent-helpers/openai.js";
import {
  providerRequiresSignedThinking,
  shouldAllowProviderOwnedThinkingReplay,
  shouldMergeConsecutiveTurns,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../embedded-agent-helpers/turns.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairingForModel,
  stripToolResultDetails,
} from "../session-transcript-repair.js";
import { stripStaleThinkingSignaturesForCompactionReplay } from "../thinking-signatures.js";
import {
  extractToolCallsFromAssistant,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "../tool-call-id.js";
import { createCompletedToolCallPredicate } from "../tool-call-shared.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type AssistantUsageSnapshot,
} from "../usage.js";
import { isZeroUsageEmptyStopAssistantTurn } from "./empty-assistant-turn.js";
import { isSameModelSnapshot } from "./replay-model-snapshot.js";
import type { ModelSnapshotEntry, ModelSnapshotState } from "./replay-session-state.types.js";
import {
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

function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((message) => {
    if (message?.role !== "user") {
      return message;
    }
    const provenance = normalizeInputProvenance(asOptionalObjectRecord(message)?.provenance);
    if (provenance?.kind !== "inter_session") {
      return message;
    }
    if (typeof message.content === "string") {
      const content = annotateInterSessionPromptText(message.content, provenance);
      if (content === message.content) {
        return message;
      }
      touched = true;
      return { ...message, content };
    }
    if (!Array.isArray(message.content)) {
      return message;
    }
    const content = [...message.content];
    const existing = content.find((block): block is Extract<typeof block, { type: "text" }> => {
      const record = asOptionalObjectRecord(block);
      return record?.type === "text" && typeof record.text === "string";
    });
    if (!existing) {
      content.unshift({
        type: "text",
        text: annotateInterSessionPromptText("Inter-session content follows.", provenance),
      });
    } else {
      const text = annotateInterSessionPromptText(existing.text, provenance);
      if (text === existing.text) {
        return message;
      }
      content[content.indexOf(existing)] = { ...existing, text };
    }
    touched = true;
    return { ...message, content };
  });
  return touched ? out : messages;
}

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
  const normalized = replaceCompactionReplayOwnerContent(message, sanitizedContent);
  return normalized;
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
  return normalized && !isReasoningOnlyLengthAssistantTurn(normalized) ? normalized : null;
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

function normalizeAssistantUsageSnapshot(usage: AssistantReplayMessage["usage"]) {
  const normalized = normalizeUsage(usage ?? undefined);
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
      usage: normalizedUsage,
    };
    touched = true;
  }

  return touched ? out : messages;
}

/**
 * Applies the generic replay-history cleanup pipeline before provider-owned
 * replay hooks run. Policy and image limits belong to the preparing host.
 */
export async function prepareGenericReplayHistory(params: {
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  messages: AgentMessage[];
  allowedToolNames?: Iterable<string>;
  snapshotState: ModelSnapshotState;
  imageLimits: ImageSanitizationLimits;
  sessionId: string;
  policy: TranscriptPolicy;
  preserveLatestAssistantThinking?: boolean;
}) {
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  const { policy } = params;
  const withInterSessionMarkers = annotateInterSessionUserMessages(params.messages);
  const signedThinkingProvider = providerRequiresSignedThinking(params.provider);
  const allowProviderOwnedThinkingReplay = shouldAllowProviderOwnedThinkingReplay({
    modelApi: params.modelApi,
    provider: params.provider,
    policy,
  });
  const isOpenAIResponsesApi =
    params.modelApi === "openai-responses" ||
    params.modelApi === "openai-chatgpt-responses" ||
    params.modelApi === "azure-openai-responses";
  const hasSnapshot = Boolean(params.provider || params.modelApi || params.modelId);
  const snapshotState = params.snapshotState;
  const priorSnapshot = snapshotState.lastSnapshot;
  const currentSnapshot: ModelSnapshotEntry | null = hasSnapshot
    ? {
        timestamp: Date.now(),
        provider: params.provider,
        modelApi: params.modelApi,
        modelId: params.modelId,
      }
    : null;
  const modelChanged =
    priorSnapshot && currentSnapshot ? !isSameModelSnapshot(priorSnapshot, currentSnapshot) : false;
  const latestModelSwitchTimestamp = modelChanged
    ? currentSnapshot?.timestamp
    : snapshotState.latestSwitchTimestamp;
  const normalizedAssistantReplay = normalizeAssistantReplayContent(withInterSessionMarkers);
  const sanitizedImages = await sanitizeSessionMessagesImages(
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
    shouldPreserveLatestAssistantThinking(sanitizedImages);
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
  if (signedThinkingProvider || policy.preserveSignatures) {
    messages = stripInvalidThinkingSignatures(
      stripStaleThinkingSignaturesForCompactionReplay(messages),
      { preserveLatestAssistant: preserveLatestAssistantThinking },
    );
  }
  if (policy.dropReasoningFromHistory) {
    messages = dropReasoningFromHistory(messages);
  }
  if (policy.dropThinkingBlocks) {
    messages = dropThinkingBlocks(messages);
  }
  messages = sanitizeToolCallInputs(messages, {
    allowedToolNames: params.allowedToolNames,
    allowProviderOwnedThinkingReplay,
  });
  // Repair missing tool results before normalizing paired call/result ids.
  if (policy.repairToolUseResultPairing) {
    messages = sanitizeToolUseResultPairingForModel(messages, isOpenAIResponsesApi);
  }
  if (isOpenAIResponsesApi) {
    messages = normalizeOpenAIResponsesToolCallIds(
      // Keep the pre-switch prompt prefix byte-stable: once rs_*/msg_* ids are
      // invalidated by a switch, every later replay must keep dropping them.
      dropStaleOpenAIReasoning(messages, latestModelSwitchTimestamp ?? undefined),
    );
  } else if (policy.sanitizeToolCallIds && policy.toolCallIdMode) {
    messages = sanitizeToolCallIdsForCloudCodeAssist(messages, policy.toolCallIdMode, {
      preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
      duplicateToolCallIdStyle: policy.duplicateToolCallIdStyle,
      preserveReplaySafeThinkingToolCallIds: allowProviderOwnedThinkingReplay,
      allowedToolNames: params.allowedToolNames,
    });
  }
  messages = ensureAssistantUsageSnapshots(
    stripStaleAssistantUsageBeforeLatestCompaction(stripToolResultDetails(messages)),
  );
  return {
    messages,
    policy,
    modelSnapshot:
      currentSnapshot && (!priorSnapshot || modelChanged) ? currentSnapshot : undefined,
  };
}

export function validateGenericReplayTurns(
  messages: AgentMessage[],
  policy: TranscriptPolicy,
  modelApi?: string | null,
  preserveUserTurns?: boolean,
): AgentMessage[] {
  const validatedGemini = policy.validateGeminiTurns ? validateGeminiTurns(messages) : messages;
  return policy.validateAnthropicTurns
    ? validateAnthropicTurns(validatedGemini, {
        mergeConsecutiveTurns: shouldMergeConsecutiveTurns(policy, modelApi),
        mergeConsecutiveUserTurns: !preserveUserTurns,
      })
    : validatedGemini;
}
