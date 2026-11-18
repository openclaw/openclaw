import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import { preserveCompactionReplayWindow } from "../../../packages/ai/src/transports/provider-compaction-replay-kernel.js";
import { sanitizeGoogleAssistantFirstOrdering } from "../../shared/google-turn-ordering.js";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import { sanitizeSessionMessagesImages } from "../embedded-agent-helpers/images.js";
import { validateReplayTurnsForPolicy } from "../embedded-agent-helpers/turns.js";
import { annotateInterSessionUserMessages } from "../replay-provenance.js";
import type { AgentMessage } from "../runtime/index.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import { projectSessionModelContextData } from "../sessions/session-manager-codec.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import { buildBeforeCompactionHookMetrics } from "./compaction-hook-metrics.js";
import { limitHistoryTurns } from "./history.js";
import {
  sanitizeGenericReplayHistory,
  sanitizeReplayHistoryAfterProviderHooks,
} from "./replay-history-sanitization.js";
import type { PreparedCompactionReplayOptions } from "./replay-history.types.js";
import { isSameModelSnapshot, readModelSnapshotStateFromEntries } from "./replay-model-snapshot.js";
import {
  dropReasoningFromHistory,
  dropThinkingBlocks,
  shouldPreserveLatestAssistantThinking,
  stripInvalidThinkingSignatures,
} from "./thinking-replay.js";

/** Existing array replay is confined to selected retained payloads, never summarized history. */
export async function prepareCompactionReplay(
  entries: SessionEntry[],
  options: PreparedCompactionReplayOptions,
  messages: AgentMessage[] = buildSessionContext(projectSessionModelContextData(entries)).messages,
) {
  const { model, policy } = options;
  const snapshot = readModelSnapshotStateFromEntries(entries);
  const latestModelSwitchTimestamp =
    snapshot.lastSnapshot &&
    !isSameModelSnapshot(snapshot.lastSnapshot, {
      timestamp: 0,
      provider: model.provider,
      modelApi: model.api,
      modelId: model.id,
    })
      ? Date.now()
      : snapshot.latestSwitchTimestamp;
  let generic = await sanitizeGenericReplayHistory(
    {
      ...options,
      messages: annotateInterSessionUserMessages(messages),
      latestModelSwitchTimestamp,
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
  if (options.builtinGoogleReplay) {
    generic = sanitizeGoogleAssistantFirstOrdering(generic);
  }
  generic = sanitizeReplayHistoryAfterProviderHooks(generic, options);
  if (policy.applyGoogleTurnOrdering) {
    generic = sanitizeGoogleAssistantFirstOrdering(generic);
  }
  const originalMessages = dedupeDuplicateUserMessagesForCompaction(
    validateReplayTurnsForPolicy(generic, policy, model.api),
  );
  const truncated = preserveCompactionReplayWindow(
    originalMessages,
    limitHistoryTurns(originalMessages, options.historyLimit),
    model,
    { sessionId: options.sessionId, enabled: options.replayEnabled },
  );
  const limited = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(truncated, options.isOpenAIResponsesApi)
    : truncated;
  const currentMessages = limited.length > 0 ? limited : originalMessages;
  return {
    status: "prepared" as const,
    beforeHookMetrics: buildBeforeCompactionHookMetrics({
      originalMessages,
      currentMessages,
      observedTokenCount: options.observedTokenCount,
      estimateTokensFn: estimateTokens,
    }),
    hasRealConversation: currentMessages.some((message, index, all) =>
      isRealConversationMessage(message, all, index),
    ),
    messages: currentMessages,
  };
}
