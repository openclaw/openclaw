import { isDeepStrictEqual } from "node:util";
import {
  hasOnlyAssistantReasoningContent,
  isReasoningOnlyLengthAssistantTurn,
  isStreamErrorFallbackContent,
} from "@openclaw/ai/internal/shared";
import { replaceCompactionReplayOwnerContent } from "@openclaw/ai/transports";
import { asFiniteNumber as toFiniteCostNumber } from "@openclaw/normalization-core/number-coercion";
import {
  asOptionalObjectRecord,
  asOptionalRecord,
} from "@openclaw/normalization-core/record-coerce";
import { stripInternalMetadataForDisplay } from "../../auto-reply/reply/display-text-sanitize.js";
import { isSilentReplyPayloadText, SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import {
  sanitizeProviderReplayHistoryWithPluginAsync,
  validateProviderReplayTurnsWithPlugin,
} from "../../plugins/provider-runtime.js";
import {
  annotateInterSessionPromptText,
  normalizeInputProvenance,
} from "../../sessions/input-provenance.js";
import { hasPersistedMedia } from "../../sessions/user-turn-media.js";
import { isTranscriptOnlyOpenClawAssistantMessage } from "../../shared/transcript-only-openclaw-assistant.js";
import { rethrowIncognitoSessionError } from "../../state/incognito-session-error.js";
import { stripStaleAssistantUsageBeforeLatestCompaction } from "../compaction-usage.js";
import {
  downgradeOpenAIFunctionCallReasoningPairs,
  dropStaleOpenAIReasoning,
  normalizeOpenAIResponsesToolCallIds,
  sanitizeGoogleTurnOrdering,
  sanitizeSessionMessagesImages,
  validateAnthropicTurns,
  validateGeminiTurns,
} from "../embedded-agent-helpers.js";
import {
  providerRequiresSignedThinking,
  shouldAllowProviderOwnedThinkingReplay,
  shouldMergeConsecutiveUserTurns,
} from "../embedded-agent-helpers/turns.js";
import { resolveImageSanitizationLimits } from "../image-sanitization.js";
import type { AgentMessage } from "../runtime/index.js";
import {
  sanitizeToolCallInputs,
  sanitizeToolUseResultPairingForModel,
  stripToolResultDetails,
} from "../session-transcript-repair.js";
import type { SessionManager } from "../sessions/index.js";
import { stripStaleThinkingSignaturesForCompactionReplay } from "../thinking-signatures.js";
import {
  extractToolCallsFromAssistant,
  extractToolResultId,
  sanitizeToolCallIdsForCloudCodeAssist,
} from "../tool-call-id.js";
import { resolveTranscriptPolicy } from "../transcript-policy.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import {
  hasNonzeroUsage,
  makeZeroUsageSnapshot,
  normalizeUsage,
  type AssistantUsageSnapshot,
  type UsageLike,
} from "../usage.js";
import { isZeroUsageEmptyStopAssistantTurn } from "./empty-assistant-turn.js";
import {
  createProviderReplaySessionState,
  isSameModelSnapshot,
  MODEL_SNAPSHOT_CUSTOM_TYPE,
  readModelSnapshotState,
  type ModelSnapshotEntry,
} from "./replay-session-state.js";
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

type ProviderReplayHookParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  provider?: string;
  modelId?: string;
  modelApi?: string | null;
  model?: ProviderRuntimeModel;
  sessionId?: string;
};

function resolveReplayPolicy(params: ProviderReplayHookParams & { policy?: TranscriptPolicy }) {
  return (
    params.policy ??
    resolveTranscriptPolicy({
      modelApi: params.modelApi,
      provider: params.provider,
      modelId: params.modelId,
      config: params.config,
      workspaceDir: params.workspaceDir,
      env: params.env,
      model: params.model,
    })
  );
}

function createProviderReplayPluginParams(params: ProviderReplayHookParams & { provider: string }) {
  const context = {
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
    provider: params.provider,
    modelId: params.modelId,
    modelApi: params.modelApi,
    model: params.model,
    sessionId: params.sessionId,
  };
  const { provider, config, workspaceDir, env } = context;
  return { provider, config, workspaceDir, env, context };
}

function annotateInterSessionUserMessages(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out = messages.map((message) => {
    if (message?.role !== "user") {
      return message;
    }
    const provenance = normalizeInputProvenance((message as { provenance?: unknown }).provenance);
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
    const textIndex = content.findIndex((block) => {
      const record = asOptionalObjectRecord(block);
      return record?.type === "text" && typeof record.text === "string";
    });
    if (textIndex < 0) {
      content.unshift({
        type: "text",
        text: annotateInterSessionPromptText("Inter-session content follows.", provenance),
      });
    } else {
      const existing = content[textIndex] as { type: "text"; text: string };
      const text = annotateInterSessionPromptText(existing.text, provenance);
      if (text === existing.text) {
        return message;
      }
      content[textIndex] = { ...existing, text };
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

function normalizeAssistantReplayTextContent(
  message: AssistantReplayMessage,
  replayContent: string,
): AssistantReplayMessage | null {
  const strippedText = stripInternalMetadataForDisplay(replayContent);
  const trimmed = strippedText.trim();
  if (!trimmed || isSilentReplyPayloadText(trimmed, SILENT_REPLY_TOKEN)) {
    return null;
  }
  return replaceCompactionReplayOwnerContent(message, [{ type: "text", text: strippedText }]);
}

function normalizeAssistantReplayBlockContent(
  message: AssistantReplayMessage,
  replayContent: unknown[],
): AssistantReplayMessage | null {
  let touched = false;
  let removedSilentText = false;
  const sanitizedContent: unknown[] = [];
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
    const isSilentText =
      trimmed.length > 0 && isSilentReplyPayloadText(trimmed, SILENT_REPLY_TOKEN);
    if (strippedText === text && !isSilentText) {
      sanitizedContent.push(block);
      continue;
    }
    touched = true;
    if (trimmed && !isSilentText) {
      sanitizedContent.push({ ...record, text: strippedText });
    }
    removedSilentText ||= isSilentText;
  }
  if (!touched) {
    return message;
  }
  if (sanitizedContent.length === 0) {
    return null;
  }
  const normalized = replaceCompactionReplayOwnerContent(
    message,
    sanitizedContent as AssistantReplayMessage["content"],
  );
  // A silent reply has no visible assistant output. Do not let its signed
  // reasoning merge into the next assistant turn during strict replay.
  return removedSilentText && hasOnlyAssistantReasoningContent(normalized) ? null : normalized;
}

function isBareDeliveryMirrorDuplicate(out: AgentMessage[], next: AssistantReplayMessage): boolean {
  const previous = out.at(-1);
  if (!previous || previous.role !== "assistant") {
    return false;
  }
  const usage = (next as { usage?: unknown }).usage;
  if (
    !usage ||
    typeof usage !== "object" ||
    hasNonzeroUsage(normalizeUsage(usage as UsageLike)) ||
    (next as { stopReason?: unknown }).stopReason !== "stop" ||
    extractToolCallsFromAssistant(previous).length > 0 ||
    extractToolCallsFromAssistant(next).length > 0
  ) {
    return false;
  }
  const previousContent = (previous as { content?: unknown }).content;
  const nextContent = (next as { content?: unknown }).content;
  return (
    Array.isArray(previousContent) &&
    previousContent.length > 0 &&
    Array.isArray(nextContent) &&
    isDeepStrictEqual(previousContent, nextContent)
  );
}

function normalizeAssistantReplayMessage(
  message: AssistantReplayMessage,
  out: AgentMessage[],
): AssistantReplayMessage | null {
  if (isTranscriptOnlyOpenClawAssistantMessage(message)) {
    // Drop from the in-memory replay copy; the persisted JSONL keeps the
    // entry so user-facing transcript surfaces are unchanged.
    return null;
  }
  // Failed attempts have no model content; discard the legacy placeholder too.
  // Keep billed silent replies and incomplete tool/length states unchanged.
  if (
    isStreamErrorFallbackContent(message.content) &&
    (message.stopReason === "error" ||
      isZeroUsageEmptyStopAssistantTurn({ ...message, content: [] }))
  ) {
    return null;
  }
  const replayContent = (message as { content?: unknown }).content;
  if (typeof replayContent === "string") {
    return normalizeAssistantReplayTextContent(message, replayContent);
  }
  const blockContent = Array.isArray(replayContent)
    ? replayContent
    : replayContent != null && typeof replayContent === "object"
      ? [replayContent]
      : [];
  const assistantMessage =
    blockContent === replayContent
      ? message
      : replaceCompactionReplayOwnerContent(message, blockContent as typeof message.content);
  const normalized = normalizeAssistantReplayBlockContent(assistantMessage, blockContent);
  if (!normalized) {
    return null;
  }
  if (isReasoningOnlyLengthAssistantTurn(normalized)) {
    // Token-limited thinking is incomplete provider state. Replaying it can
    // resend a partial signature, while visible text or tool calls remain useful.
    return null;
  }
  // Historical side-branch rebuilds could strip every mirror marker while
  // retaining the zero-usage receipt immediately after its source reply.
  // Keep this recovery shape narrow; ordinary repeated model turns survive.
  return isBareDeliveryMirrorDuplicate(out, normalized) ? null : normalized;
}

export function normalizeAssistantReplayContent(messages: AgentMessage[]): AgentMessage[] {
  let touched = false;
  const out: AgentMessage[] = [];
  for (const message of messages) {
    if (message?.role !== "user" && message?.role !== "assistant") {
      out.push(message);
      continue;
    }
    const normalized =
      message.role === "user"
        ? sanitizeUserReplayContent(message)
        : normalizeAssistantReplayMessage(message, out);
    if (normalized) {
      out.push(normalized);
    }
    touched ||= normalized !== message;
  }
  return touched ? out : messages;
}

function normalizeAssistantUsageSnapshot(usage: unknown) {
  const normalized = normalizeUsage((usage ?? undefined) as UsageLike | undefined);
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
    const message = out[i] as (AgentMessage & { role?: unknown; usage?: unknown }) | undefined;
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
    } as AgentMessage;
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
    const role = (message as { role?: unknown } | undefined)?.role;

    if (role !== "toolResult") {
      assertNoPendingCalls();
    }

    if (!message || typeof message !== "object") {
      continue;
    }

    if (role === "toolResult") {
      const toolCallId = extractToolResultId(
        message as Extract<AgentMessage, { role: "toolResult" }>,
      );
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

    for (const toolCall of extractToolCallsFromAssistant(
      message as Extract<AgentMessage, { role: "assistant" }>,
    )) {
      pending.set(toolCall.id, i);
    }
  }

  assertNoPendingCalls();
  return messages;
}

/**
 * Applies the generic replay-history cleanup pipeline before provider-owned
 * replay hooks run.
 */
export async function sanitizeSessionHistory(
  params: ProviderReplayHookParams & {
    messages: AgentMessage[];
    allowedToolNames?: Iterable<string>;
    sessionManager: SessionManager;
    sessionId: string;
    policy?: TranscriptPolicy;
    preserveLatestAssistantThinking?: boolean;
  },
): Promise<AgentMessage[]> {
  // Keep docs/reference/transcript-hygiene.md in sync with any logic changes here.
  const policy = resolveReplayPolicy(params);
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
  const snapshotState = hasSnapshot
    ? readModelSnapshotState(params.sessionManager)
    : { lastSnapshot: null, latestSwitchTimestamp: null };
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
      ...resolveImageSanitizationLimits(params.config),
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
  const validatedThinkingSignatures =
    signedThinkingProvider || policy.preserveSignatures
      ? stripInvalidThinkingSignatures(
          stripStaleThinkingSignaturesForCompactionReplay(sanitizedImages),
          { preserveLatestAssistant: preserveLatestAssistantThinking },
        )
      : sanitizedImages;
  const droppedReasoning = policy.dropReasoningFromHistory
    ? dropReasoningFromHistory(validatedThinkingSignatures)
    : validatedThinkingSignatures;
  const droppedThinking = policy.dropThinkingBlocks
    ? dropThinkingBlocks(droppedReasoning)
    : droppedReasoning;
  const sanitizedToolCalls = sanitizeToolCallInputs(droppedThinking, {
    allowedToolNames: params.allowedToolNames,
    allowProviderOwnedThinkingReplay,
  });
  // OpenAI Responses rejects orphan/missing function_call_output items. Upstream
  // Codex repairs those gaps with "aborted"; keep that before the fc_* downgrade
  // so both call and result ids are rewritten together. Covered by unit replay
  // tests plus live OpenAI/Codex and generic replay-repair model tests.
  const pairedToolCalls = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(sanitizedToolCalls, isOpenAIResponsesApi)
    : sanitizedToolCalls;
  const openAISafeToolCalls = isOpenAIResponsesApi
    ? downgradeOpenAIFunctionCallReasoningPairs(
        normalizeOpenAIResponsesToolCallIds(
          // Keep the pre-switch prompt prefix byte-stable: once rs_*/msg_* ids are
          // invalidated by a switch, every later replay must keep dropping them.
          dropStaleOpenAIReasoning(pairedToolCalls, latestModelSwitchTimestamp ?? undefined),
        ),
      )
    : pairedToolCalls;
  const sanitizedToolIds =
    !isOpenAIResponsesApi && policy.sanitizeToolCallIds && policy.toolCallIdMode
      ? sanitizeToolCallIdsForCloudCodeAssist(openAISafeToolCalls, policy.toolCallIdMode, {
          preserveNativeAnthropicToolUseIds: policy.preserveNativeAnthropicToolUseIds,
          duplicateToolCallIdStyle: policy.duplicateToolCallIdStyle,
          preserveReplaySafeThinkingToolCallIds: allowProviderOwnedThinkingReplay,
          allowedToolNames: params.allowedToolNames,
        })
      : openAISafeToolCalls;
  const sanitizedToolResults = stripToolResultDetails(sanitizedToolIds);
  const sanitizedCompactionUsage = ensureAssistantUsageSnapshots(
    stripStaleAssistantUsageBeforeLatestCompaction(sanitizedToolResults),
  );
  const provider = params.provider?.trim();
  let providerSanitized: AgentMessage[] | undefined;
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const replaySession = createProviderReplaySessionState(params.sessionManager);
    try {
      const providerResult = await sanitizeProviderReplayHistoryWithPluginAsync({
        ...pluginParams,
        context: {
          ...pluginParams.context,
          sessionId: params.sessionId ?? "",
          messages: sanitizedCompactionUsage,
          allowedToolNames: params.allowedToolNames,
          sessionState: replaySession.state,
        },
      });
      providerSanitized = providerResult ?? undefined;
    } finally {
      replaySession.close();
    }
  }
  const sanitizedWithProvider = providerSanitized ?? sanitizedCompactionUsage;
  // Provider replay hooks may rewrite history, so reassert the same pairing policy afterward.
  const responsesProviderRepaired =
    isOpenAIResponsesApi && policy.repairToolUseResultPairing
      ? sanitizeToolUseResultPairingForModel(sanitizedWithProvider, true)
      : sanitizedWithProvider;
  const responsesInvariantChecked = isOpenAIResponsesApi
    ? assertOpenAIResponsesToolUseResultInvariant(responsesProviderRepaired)
    : responsesProviderRepaired;

  if (currentSnapshot && (!priorSnapshot || modelChanged)) {
    try {
      await params.sessionManager.appendCustomEntryAsync(
        MODEL_SNAPSHOT_CUSTOM_TYPE,
        currentSnapshot,
      );
    } catch (error) {
      rethrowIncognitoSessionError(error);
      // ignore persistence failures
    }
  }

  if (!policy.applyGoogleTurnOrdering) {
    return responsesInvariantChecked;
  }

  // Strict OpenAI-compatible providers (vLLM, Gemma, etc.) also reject
  // conversations that start with an assistant turn (e.g. delivery-mirror
  // messages after /new). Provider hooks may already have applied a
  // provider-owned ordering rewrite above; keep this generic fallback for the
  // strict OpenAI-compatible path and for any provider that leaves assistant-
  // first repair to core. See #38962.
  const googleOrdered = sanitizeGoogleTurnOrdering(responsesInvariantChecked);
  return isOpenAIResponsesApi
    ? assertOpenAIResponsesToolUseResultInvariant(googleOrdered)
    : googleOrdered;
}

/**
 * Runs provider-owned replay validation before falling back to the remaining
 * generic validator pipeline.
 */
export async function validateReplayTurns(
  params: ProviderReplayHookParams & {
    messages: AgentMessage[];
    policy?: TranscriptPolicy;
  },
): Promise<AgentMessage[]> {
  const policy = resolveReplayPolicy(params);
  const provider = params.provider?.trim();
  if (provider) {
    const pluginParams = createProviderReplayPluginParams({ ...params, provider });
    const providerValidated = await validateProviderReplayTurnsWithPlugin({
      ...pluginParams,
      context: {
        ...pluginParams.context,
        messages: params.messages,
      },
    });
    if (providerValidated) {
      return providerValidated;
    }
  }

  const validatedGemini = policy.validateGeminiTurns
    ? validateGeminiTurns(params.messages)
    : params.messages;
  return policy.validateAnthropicTurns
    ? validateAnthropicTurns(validatedGemini, {
        mergeConsecutiveUserTurns: shouldMergeConsecutiveUserTurns(policy, params.modelApi),
      })
    : validatedGemini;
}
