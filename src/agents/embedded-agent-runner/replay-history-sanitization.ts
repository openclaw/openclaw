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

export function isBareDeliveryMirrorCandidate(next: AssistantReplayMessage): boolean {
  return (
    !(
      next.provider === OPENCLAW_TRANSCRIPT_ARTIFACT_PROVIDER && next.model === "automation-result"
    ) &&
    next.usage != null &&
    typeof next.usage === "object" &&
    !hasNonzeroUsage(normalizeUsage(next.usage)) &&
    next.stopReason === "stop" &&
    extractToolCallsFromAssistant(next).length === 0
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

/** Row-local normalization; cross-row decisions belong to normalizeReplaySequence. */
export function normalizeReplayMessage(message: AgentMessage): AgentMessage | null {
  if (message?.role !== "user" && message?.role !== "assistant") {
    return message;
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
  return normalized;
}

export type ReplayNormalizationAdapter<T, B> = {
  normalize(message: T): T | null;
  role(message: T): string | undefined;
  sourceContentWasString(message: T): boolean;
  mirrorCandidate(message: T): boolean;
  hasCalls(message: T): boolean;
  hasNonemptyArrayContent(message: T): boolean;
  failed(message: T): boolean;
  blocks(message: T): readonly B[];
  blockType(block: B): string | undefined;
  completed(block: B): boolean;
  complete(message: T, blocks: B[]): T;
  recoveryAnchor(message: T): T | null;
};

/**
 * The caller supplies exact equality. A yielded candidate is not an equality result:
 * payload-free readers may reject it by fingerprint or perform selected row reads.
 */
export function* normalizeReplaySequence<T, B>(
  messages: readonly T[],
  adapter: ReplayNormalizationAdapter<T, B>,
): Generator<readonly [T, T], T[], boolean> {
  let touched = false;
  const out: T[] = [];
  for (const message of messages) {
    const role = adapter.role(message);
    if (role !== "user" && role !== "assistant") {
      out.push(message);
      continue;
    }
    let normalized = adapter.normalize(message);
    const previous = out.at(-1);
    if (
      normalized &&
      adapter.role(normalized) === "assistant" &&
      !adapter.sourceContentWasString(message) &&
      adapter.mirrorCandidate(normalized) &&
      previous &&
      adapter.role(previous) === "assistant" &&
      !adapter.hasCalls(previous) &&
      adapter.hasNonemptyArrayContent(previous) &&
      adapter.hasNonemptyArrayContent(normalized) &&
      (yield [previous, normalized] as const)
    ) {
      normalized = null;
    }
    if (
      normalized &&
      adapter.role(normalized) === "assistant" &&
      adapter.failed(normalized) &&
      adapter.blocks(normalized).some((block) => adapter.blockType(block) === "toolCall")
    ) {
      normalized = adapter
        .blocks(normalized)
        .some((block) => adapter.blockType(block) === "toolCall" && adapter.completed(block))
        ? adapter.complete(
            normalized,
            adapter
              .blocks(normalized)
              .filter(
                (block) =>
                  adapter.blockType(block) !== "text" &&
                  (adapter.blockType(block) !== "toolCall" || adapter.completed(block)),
              ),
          )
        : null;
    }
    normalized ??= adapter.recoveryAnchor(message);
    if (normalized) {
      out.push(normalized);
    }
    touched ||= normalized !== message;
  }
  return !touched && Array.isArray(messages) ? messages : out;
}

export function normalizeAssistantReplayContent(messages: AgentMessage[]): AgentMessage[] {
  let completed: ReturnType<typeof createCompletedToolCallPredicate> | undefined;
  const sequence = normalizeReplaySequence<AgentMessage, AssistantReplayMessage["content"][number]>(
    messages,
    {
      normalize: normalizeReplayMessage,
      role: (message) => message?.role,
      sourceContentWasString: (message) =>
        "content" in message && typeof message.content === "string",
      mirrorCandidate: (message) =>
        message.role === "assistant" && isBareDeliveryMirrorCandidate(message),
      hasCalls: (message) =>
        message.role === "assistant" && extractToolCallsFromAssistant(message).length > 0,
      hasNonemptyArrayContent: (message) =>
        "content" in message && Array.isArray(message.content) && message.content.length > 0,
      failed: (message) =>
        message.role === "assistant" &&
        (message.stopReason === "error" || message.stopReason === "aborted"),
      blocks: (message) => (message.role === "assistant" ? message.content : []),
      blockType: (block) => block.type,
      completed: (block) =>
        block.type === "toolCall" &&
        (completed ??= createCompletedToolCallPredicate(messages))(block),
      complete: (message, content) =>
        message.role === "assistant"
          ? { ...replaceCompactionReplayOwnerContent(message, content), stopReason: "toolUse" }
          : message,
      recoveryAnchor: (message) =>
        message.role === "assistant" &&
        readOpenAIResponsesItemRecoveryAnchor(message.providerReplay) !== undefined
          ? replaceCompactionReplayOwnerContent(message, [])
          : null,
    },
  );
  let step = sequence.next();
  while (!step.done) {
    const [previous, next] = step.value;
    step = sequence.next(
      isDeepStrictEqual(
        "content" in previous ? previous.content : undefined,
        "content" in next ? next.content : undefined,
      ),
    );
  }
  return step.value;
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

export function assertReplayToolUseResultInvariant<T>(
  messages: T[],
  adapter: {
    role(message: T): string | undefined;
    valid(message: T): boolean;
    resultId(message: T): string | null;
    callIds(message: T): readonly string[];
  },
): T[] {
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
    const message = messages[i]!;
    const role = adapter.role(message);

    if (role !== "toolResult") {
      assertNoPendingCalls();
    }

    if (!adapter.valid(message)) {
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = adapter.resultId(message);
      if (!toolCallId || !pending.delete(toolCallId)) {
        throw formatOpenAIResponsesReplayInvariantError({
          reason: "orphan_tool_result",
          ...(toolCallId ? { toolCallId } : {}),
          messageIndex: i,
        });
      }
      continue;
    }

    if (role !== "assistant") {
      continue;
    }

    for (const id of adapter.callIds(message)) {
      pending.set(id, i);
    }
  }

  assertNoPendingCalls();
  return messages;
}

function assertOpenAIResponsesToolUseResultInvariant(messages: AgentMessage[]): AgentMessage[] {
  return assertReplayToolUseResultInvariant(messages, {
    role: (message) => message?.role,
    valid: (message) => typeof message === "object" && message !== null,
    resultId: (message) => (message.role === "toolResult" ? extractToolResultId(message) : null),
    callIds: (message) =>
      message.role === "assistant"
        ? extractToolCallsFromAssistant(message).map((call) => call.id)
        : [],
  });
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

export type ReplaySanitizationAdapter<T> = {
  normalize(messages: T[]): T[] | Promise<T[]>;
  images(messages: T[]): Promise<T[]>;
  preserveLatestThinking(messages: T[]): boolean;
  staleSignatures(messages: T[]): T[];
  invalidSignatures(messages: T[], preserveLatest: boolean): T[];
  reasoning(messages: T[]): T[];
  thinking(messages: T[]): T[];
  inputs(messages: T[]): T[];
  pairing(messages: T[]): T[];
  openAI(messages: T[]): T[];
  ids(messages: T[]): T[];
  usage(messages: T[]): T[];
};

/** One policy/ordering owner for payload replay and detached metadata replay. */
export async function sanitizeGenericReplayWithAdapter<T>(
  params: {
    messages: T[];
    policy: GenericReplayHistoryParams["policy"];
    preserveLatestAssistantThinking?: boolean;
    signedThinkingProvider: boolean;
    isOpenAIResponsesApi: boolean;
  },
  adapter: ReplaySanitizationAdapter<T>,
): Promise<T[]> {
  let messages = await adapter.images(await adapter.normalize(params.messages));
  const preserveLatest =
    params.preserveLatestAssistantThinking ?? adapter.preserveLatestThinking(messages);
  if (params.signedThinkingProvider || params.policy.preserveSignatures) {
    messages = adapter.invalidSignatures(adapter.staleSignatures(messages), preserveLatest);
  }
  if (params.policy.dropReasoningFromHistory) {
    messages = adapter.reasoning(messages);
  }
  if (params.policy.dropThinkingBlocks) {
    messages = adapter.thinking(messages);
  }
  messages = adapter.inputs(messages);
  if (params.policy.repairToolUseResultPairing) {
    messages = adapter.pairing(messages);
  }
  if (params.isOpenAIResponsesApi) {
    messages = adapter.openAI(messages);
  } else if (params.policy.sanitizeToolCallIds && params.policy.toolCallIdMode) {
    messages = adapter.ids(messages);
  }
  return adapter.usage(messages);
}

/** Data-only cleanup before provider hooks. Policy and route facts are host-resolved. */
export async function sanitizeGenericReplayHistory(
  params: GenericReplayHistoryParams,
  sanitizers: ReplayHistorySanitizers,
): Promise<AgentMessage[]> {
  const { policy } = params;
  return sanitizeGenericReplayWithAdapter(params, {
    normalize: normalizeAssistantReplayContent,
    images: (messages) =>
      sanitizers.sanitizeSessionMessagesImages(messages, "session:history", {
        sanitizeMode: policy.sanitizeMode,
        sanitizeToolCallIds: false,
        toolCallIdMode: policy.toolCallIdMode,
        duplicateToolCallIdStyle: policy.duplicateToolCallIdStyle,
        preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
        preserveSignatures: policy.preserveSignatures,
        sanitizeThoughtSignatures: policy.sanitizeThoughtSignatures,
        ...params.imageLimits,
      }),
    preserveLatestThinking: sanitizers.shouldPreserveLatestAssistantThinking,
    staleSignatures: stripStaleThinkingSignaturesForCompactionReplay,
    invalidSignatures: (messages, preserveLatestAssistant) =>
      sanitizers.stripInvalidThinkingSignatures(messages, { preserveLatestAssistant }),
    reasoning: sanitizers.dropReasoningFromHistory,
    thinking: sanitizers.dropThinkingBlocks,
    inputs: (messages) =>
      sanitizeToolCallInputs(messages, {
        allowedToolNames: params.allowedToolNames,
        allowProviderOwnedThinkingReplay: params.allowProviderOwnedThinkingReplay,
      }),
    pairing: (messages) =>
      sanitizeToolUseResultPairingForModel(messages, params.isOpenAIResponsesApi),
    openAI: (messages) =>
      normalizeOpenAIResponsesToolCallIds(
        dropStaleOpenAIReasoning(messages, params.latestModelSwitchTimestamp ?? undefined),
      ),
    ids: (messages) =>
      sanitizeToolCallIdsForCloudCodeAssist(messages, policy.toolCallIdMode, {
        preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
        duplicateToolCallIdStyle: policy.duplicateToolCallIdStyle,
        preserveReplaySafeThinkingToolCallIds: params.allowProviderOwnedThinkingReplay,
        allowedToolNames: params.allowedToolNames,
      }),
    usage: (messages) =>
      ensureAssistantUsageSnapshots(
        stripStaleAssistantUsageBeforeLatestCompaction(stripToolResultDetails(messages)),
      ),
  });
}

export function sanitizeReplayHistoryAfterProviderHooksWithAdapter<T>(
  messages: T[],
  params: Pick<GenericReplayHistoryParams, "isOpenAIResponsesApi" | "policy">,
  adapter: { pairing(messages: T[]): T[]; assert(messages: T[]): T[] },
): T[] {
  if (!params.isOpenAIResponsesApi) {
    return messages;
  }
  return adapter.assert(
    params.policy.repairToolUseResultPairing ? adapter.pairing(messages) : messages,
  );
}

/** Provider hooks may rewrite history; the host invokes this before any snapshot append. */
export function sanitizeReplayHistoryAfterProviderHooks(
  messages: AgentMessage[],
  params: Pick<GenericReplayHistoryParams, "isOpenAIResponsesApi" | "policy">,
): AgentMessage[] {
  return sanitizeReplayHistoryAfterProviderHooksWithAdapter(messages, params, {
    pairing: (rows) => sanitizeToolUseResultPairingForModel(rows, true),
    assert: assertOpenAIResponsesToolUseResultInvariant,
  });
}
