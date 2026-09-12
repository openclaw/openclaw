import { MAX_MESSAGING_HISTORY_ENTRIES } from "../../embedded-agent-messaging-history.js";
import { hasAsyncActivity } from "./attempt-terminal-evidence.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Project settled facts, retaining prior generations without collapsing repeated sends. */
export function copyAttemptDeliveryState(
  attempt: EmbeddedRunAttemptResult & { asyncWorkStarted?: true },
  previous?: Partial<EmbeddedRunAttemptResult> & { asyncWorkStarted?: true },
) {
  const append = <T>(current: T[], before: T[] | undefined): T[] =>
    previous ? [...(before ?? []), ...current].slice(-MAX_MESSAGING_HISTORY_ENTRIES) : current;
  return {
    latestMcpAppChannelView: attempt.latestMcpAppChannelView ?? previous?.latestMcpAppChannelView,
    latestMcpConnectAction: attempt.latestMcpConnectAction ?? previous?.latestMcpConnectAction,
    didSendViaMessagingTool: previous?.didSendViaMessagingTool || attempt.didSendViaMessagingTool,
    sourceReplyDelivered: previous?.sourceReplyDelivered || attempt.sourceReplyDelivered,
    didDeliverSourceReplyViaMessageTool:
      previous?.didDeliverSourceReplyViaMessageTool === true ||
      attempt.didDeliverSourceReplyViaMessageTool === true,
    didSendDeterministicApprovalPrompt:
      previous?.didSendDeterministicApprovalPrompt || attempt.didSendDeterministicApprovalPrompt,
    messagingToolSentTexts: append(
      attempt.messagingToolSentTexts,
      previous?.messagingToolSentTexts,
    ),
    messagingToolSentMediaUrls: append(
      attempt.messagingToolSentMediaUrls,
      previous?.messagingToolSentMediaUrls,
    ),
    messagingToolSentTargets: append(
      attempt.messagingToolSentTargets,
      previous?.messagingToolSentTargets,
    ),
    messagingToolSourceReplyPayloads: previous
      ? append(
          attempt.messagingToolSourceReplyPayloads ?? [],
          previous.messagingToolSourceReplyPayloads,
        )
      : attempt.messagingToolSourceReplyPayloads,
    heartbeatToolResponse: attempt.heartbeatToolResponse ?? previous?.heartbeatToolResponse,
    successfulCronAdds: previous?.successfulCronAdds
      ? previous.successfulCronAdds + (attempt.successfulCronAdds ?? 0)
      : attempt.successfulCronAdds,
    acceptedSessionSpawns: previous
      ? [...(previous.acceptedSessionSpawns ?? []), ...(attempt.acceptedSessionSpawns ?? [])]
      : attempt.acceptedSessionSpawns,
    ...(previous?.asyncWorkStarted ||
    attempt.asyncWorkStarted ||
    hasAsyncActivity(attempt.toolMetas)
      ? { asyncWorkStarted: true as const }
      : {}),
    requesterContinuationSettled:
      previous?.requesterContinuationSettled || attempt.requesterContinuationSettled,
  };
}

export type AttemptDeliveryState = ReturnType<typeof copyAttemptDeliveryState>;
