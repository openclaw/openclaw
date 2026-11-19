import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { estimateTokens } from "../../../packages/agent-core/src/harness/compaction/compaction-cut-point.js";
import { buildSessionContext } from "../../../packages/agent-core/src/harness/session/session.js";
import type { ProviderRuntimeModel } from "../../plugins/provider-runtime-model.types.js";
import { createRealConversationClassifier } from "../compaction-real-conversation.js";
import { sanitizeCompactionReplayMessages } from "../compaction-replay.js";
import type { ImageSanitizationLimits } from "../image-sanitization.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import type { SessionEntry } from "../sessions/session-manager-types.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import { buildBeforeCompactionHookMetrics } from "./compaction-hook-metrics.js";
import { limitHistoryTurns } from "./history.js";
import {
  finishGenericReplayHistory,
  prepareGenericReplayHistory,
  validateGenericReplayTurns,
} from "./replay-history.js";
import {
  readModelSnapshotStateFromEntries,
  type ModelSnapshotState,
} from "./replay-session-state.js";

/** Serializable policy, not configuration or provider callbacks. */
export type PreparedCompactionReplayOptions = {
  model: ProviderRuntimeModel;
  policy: TranscriptPolicy;
  sessionId: string;
  allowedToolNames: string[];
  imageLimits: ImageSanitizationLimits;
  historyLimit?: number;
  replayEnabled: boolean;
  observedTokenCount?: number;
};

/** The same generic replay owners run worker-local; callbacks retain the session adapter. */
export async function prepareNativeCompactionReplay(
  entries: SessionEntry[],
  options: PreparedCompactionReplayOptions,
  snapshotState: ModelSnapshotState = readModelSnapshotStateFromEntries(entries),
) {
  const { model, policy, sessionId } = options;
  const prepared = await prepareGenericReplayHistory({
    messages: sanitizeCompactionReplayMessages(buildSessionContext(entries).messages),
    provider: model.provider,
    modelId: model.id,
    modelApi: model.api,
    model,
    sessionId,
    policy,
    imageLimits: options.imageLimits,
    allowedToolNames: options.allowedToolNames,
    snapshotState,
    preserveLatestAssistantThinking: false,
  });
  const sanitized = finishGenericReplayHistory(prepared.messages, policy, model.api);
  const originalMessages = dedupeDuplicateUserMessagesForCompaction(
    validateGenericReplayTurns(sanitized, policy, model.api),
  );
  const truncated = preserveCompactionReplayWindow(
    originalMessages,
    limitHistoryTurns(originalMessages, options.historyLimit),
    model,
    { sessionId, enabled: options.replayEnabled },
  );
  const responsesApi =
    model.api === "openai-responses" ||
    model.api === "azure-openai-responses" ||
    model.api === "openai-chatgpt-responses";
  const limited = policy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(truncated, responsesApi)
    : truncated;
  const currentMessages = limited.length > 0 ? limited : originalMessages;
  return {
    beforeHookMetrics: buildBeforeCompactionHookMetrics({
      originalMessages,
      currentMessages,
      observedTokenCount: options.observedTokenCount,
      estimateTokensFn: estimateTokens,
    }),
    hasRealConversation: currentMessages.some(createRealConversationClassifier()),
    modelSnapshot: prepared.modelSnapshot,
  };
}
