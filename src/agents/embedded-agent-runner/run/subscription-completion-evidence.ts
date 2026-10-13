import type { subscribeEmbeddedAgentSession } from "../../embedded-agent-subscribe.js";
import { replayMetadataFromState } from "../replay-state.js";

type EmbeddedAttemptSubscription = ReturnType<typeof subscribeEmbeddedAgentSession>;

export function readSubscriptionCompletionEvidence(subscription: EmbeddedAttemptSubscription) {
  const media = subscription.getPendingToolMediaReply();
  return {
    assistantTexts: subscription.assistantTexts,
    keptAnswer: subscription.getKeptAnswer(),
    toolMetas: subscription.toolMetas
      .filter((entry) => entry.toolName.trim().length > 0)
      .map(({ parentToolCallId: _parentToolCallId, activity: _activity, ...entry }) =>
        Object.assign(entry, { replaySafe: entry.replaySafe === true }),
      ),
    itemLifecycle: subscription.getItemLifecycle(),
    acceptedSessionSpawns: subscription.getAcceptedSessionSpawns(),
    lastToolError: subscription.getLastToolError(),
    didSendViaMessagingTool: subscription.didSendViaMessagingTool(),
    didSendDeterministicApprovalPrompt: subscription.didSendDeterministicApprovalPrompt(),
    messagingToolSentTexts: subscription.getMessagingToolSentTexts(),
    messagingToolSentMediaUrls: subscription.getMessagingToolSentMediaUrls(),
    messagingToolSentTargets: subscription.getMessagingToolSentTargets(),
    messagingToolSourceReplyPayloads: subscription.getMessagingToolSourceReplyPayloads(),
    heartbeatToolResponse: subscription.getHeartbeatToolResponse(),
    sourceReplyDelivered: subscription.getSourceReplyDelivered(),
    sourceReplyDeliveryState: subscription.getSourceReplyDeliveryState(),
    toolMediaUrls: media?.mediaUrls,
    toolAudioAsVoice: media?.audioAsVoice,
    toolTrustedLocalMedia: media?.trustedLocalMedia,
    hasToolMediaBlockReply: subscription.hasToolMediaBlockReply(),
    successfulCronAdds: subscription.getSuccessfulCronAdds(),
    replayMetadata: replayMetadataFromState(subscription.getReplayState()),
  };
}
