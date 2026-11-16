import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { isCompactionReplayCheckpoint } from "../../../packages/ai/src/transports/provider-compaction-checkpoint.js";
import type { Model } from "../../llm/types.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import { sanitizeSessionMessagesImages } from "../embedded-agent-helpers/images.js";
import { annotateInterSessionUserMessages } from "../replay-provenance.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import { projectSessionModelContextData } from "../sessions/session-manager-codec.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import { buildBeforeCompactionHookMetrics } from "./compaction-hook-metrics.js";
import { limitHistoryTurns } from "./history.js";
import {
  sanitizeGenericReplayHistory,
  sanitizeReplayHistoryAfterProviderHooks,
  type GenericReplayHistoryParams,
} from "./replay-history-sanitization.js";
import { isSameModelSnapshot, readModelSnapshotStateFromEntries } from "./replay-model-snapshot.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  shouldPreserveLatestAssistantThinking,
  stripInvalidThinkingSignatures,
} from "./thinking-replay.js";

/** Host-resolved route facts, not provider callbacks or mutable registry handles. */
export type PreparedCompactionReplayOptions = Omit<
  GenericReplayHistoryParams,
  "messages" | "latestModelSwitchTimestamp" | "preserveLatestAssistantThinking" | "allowedToolNames"
> & {
  allowedToolNames: string[];
  model: Model;
  sessionId: string;
  replayEnabled: boolean;
  historyLimit?: number;
  observedTokenCount?: number;
};

/**
 * Only the no-provider-hook route calls this operation. A snapshot append or a
 * provider validator requires the ordinary host owner, before any compaction effect.
 */
export async function prepareCompactionReplay(
  entries: SessionEntry[],
  options: PreparedCompactionReplayOptions,
) {
  const { model, policy } = options;
  if (
    entries.some(
      (entry) =>
        entry.type === "message" &&
        entry.message.role === "assistant" &&
        isCompactionReplayCheckpoint(entry.message.providerReplay),
    )
  ) {
    return {
      status: "unsupported" as const,
      reason: "provider checkpoint replay retains its host owner",
    };
  }

  if (
    policy.applyGoogleTurnOrdering ||
    policy.validateGeminiTurns ||
    policy.validateAnthropicTurns
  ) {
    return { status: "unsupported" as const, reason: "host replay validation required" };
  }
  const snapshot = readModelSnapshotStateFromEntries(entries);
  if (
    !snapshot.lastSnapshot ||
    !isSameModelSnapshot(snapshot.lastSnapshot, {
      timestamp: 0,
      provider: model.provider,
      modelApi: model.api,
      modelId: model.id,
    })
  ) {
    return { status: "unsupported" as const, reason: "host model snapshot update required" };
  }
  const generic = await sanitizeGenericReplayHistory(
    {
      ...options,
      messages: annotateInterSessionUserMessages(
        buildSessionContext(projectSessionModelContextData(entries)).messages,
      ),
      latestModelSwitchTimestamp: snapshot.latestSwitchTimestamp,
      preserveLatestAssistantThinking: false,
    },
    {
      sanitizeSessionMessagesImages,
      shouldPreserveLatestAssistantThinking,
      stripInvalidThinkingSignatures,
      dropReasoningFromHistory,
      dropThinkingBlocks,
    },
  );
  const originalMessages = dedupeDuplicateUserMessagesForCompaction(
    sanitizeReplayHistoryAfterProviderHooks(generic, options),
  );
  const truncated = preserveCompactionReplayWindow(
    originalMessages,
    limitHistoryTurns(originalMessages, options.historyLimit),
    model,
    {
      sessionId: options.sessionId,
      enabled: options.replayEnabled,
    },
  );
  const limited = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(truncated, options.isOpenAIResponsesApi)
    : truncated;
  // The ordinary owner retains the original messages when limiting returns empty.
  const currentMessages = limited.length > 0 ? limited : originalMessages;
  return {
    status: "prepared" as const,
    beforeHookMetrics: buildBeforeCompactionHookMetrics({
      originalMessages,
      currentMessages,
      observedTokenCount: options.observedTokenCount,
      estimateTokensFn: estimateTokens,
    }),
    hasRealConversation: currentMessages.some((message, index, messages) =>
      isRealConversationMessage(message, messages, index),
    ),
  };
}
