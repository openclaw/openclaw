import { preserveCompactionReplayWindow } from "@openclaw/ai/transports";
import { floorPositiveFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { isRealConversationMessage } from "../compaction-real-conversation.js";
import { sanitizeToolUseResultPairingForModel } from "../session-transcript-repair.js";
import type { AgentSession } from "../sessions/agent-session.js";
import { estimateTokens } from "../sessions/compaction/compaction.js";
import type { SessionManager } from "../sessions/session-manager.js";
import type { TranscriptPolicy } from "../transcript-policy.types.js";
import { dedupeDuplicateUserMessagesForCompaction } from "./compaction-duplicate-user-messages.js";
import { buildBeforeCompactionHookMetrics } from "./compaction-hook-metrics.js";
import { getHistoryLimitFromSessionKey, limitHistoryTurns } from "./history.js";
import type { PreparedCompactionRuntime } from "./prepared-compaction-runtime.js";
import { sanitizeSessionHistory, validateReplayTurns } from "./replay-history.js";

/** Reconstruct the ordinary compactor's full replay through its provider owners. */
export async function prepareCompactionSessionReplay({
  runtime,
  session,
  sessionManager,
  policy: transcriptPolicy,
  replayEnabled: compactionReplayEnabled,
}: {
  runtime: PreparedCompactionRuntime;
  session: AgentSession;
  sessionManager: SessionManager;
  policy: TranscriptPolicy;
  replayEnabled: boolean;
}) {
  const { params, effectiveModel, modelId, provider, effectiveWorkspace, allowedToolNames } =
    runtime;
  const responsesApi =
    effectiveModel.api === "openai-responses" ||
    effectiveModel.api === "openai-chatgpt-responses" ||
    effectiveModel.api === "azure-openai-responses";
  const replayContext = () => ({
    modelApi: effectiveModel.api,
    modelId,
    provider,
    config: params.config,
    workspaceDir: effectiveWorkspace,
    env: process.env,
    model: effectiveModel,
    sessionId: params.sessionId,
    policy: transcriptPolicy,
  });
  const prior = await sanitizeSessionHistory({
    ...replayContext(),
    messages: session.messages,
    allowedToolNames,
    sessionManager,
    preserveLatestAssistantThinking: false,
  });
  const validated = await validateReplayTurns({
    ...replayContext(),
    messages: prior,
  });
  // Apply validated transcript to the live session even when no history limit is configured,
  // so compaction and hook metrics are based on the same message set.
  session.agent.state.messages = dedupeDuplicateUserMessagesForCompaction(validated);
  // "Original" compaction metrics should describe the validated transcript that enters
  // limiting/compaction, not the raw on-disk session snapshot.
  const originalMessages = session.messages;
  const truncated = preserveCompactionReplayWindow(
    originalMessages,
    limitHistoryTurns(
      session.messages,
      getHistoryLimitFromSessionKey(params.sessionKey, params.config, {
        accountId: params.agentAccountId,
        peerId: params.conversationRoutePeerId,
        chatType: params.chatType,
      }),
    ),
    effectiveModel,
    {
      sessionId: params.sessionId,
      enabled: compactionReplayEnabled,
    },
  );
  // Re-run tool_use/tool_result pairing repair after truncation, since
  // limitHistoryTurns can orphan tool_result blocks by removing the
  // assistant message that contained the matching tool_use.
  const limited = transcriptPolicy.repairToolUseResultPairing
    ? sanitizeToolUseResultPairingForModel(truncated, responsesApi)
    : truncated;
  if (limited.length > 0) {
    session.agent.state.messages = limited;
  }
  const hasRealConversation = session.messages.some((message, index, allMessages) =>
    isRealConversationMessage(message, allMessages, index),
  );
  const beforeHookMetrics = buildBeforeCompactionHookMetrics({
    originalMessages,
    currentMessages: session.messages,
    observedTokenCount: floorPositiveFiniteNumber(params.currentTokenCount),
    estimateTokensFn: estimateTokens,
  });

  return { hasRealConversation, beforeHookMetrics };
}
