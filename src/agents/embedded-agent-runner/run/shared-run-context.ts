import type { EmbeddedForegroundPromptContext } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

export function projectEmbeddedMessageContext(run: Partial<EmbeddedForegroundPromptContext>) {
  return {
    senderId: run.senderId,
    senderName: run.senderName,
    senderUsername: run.senderUsername,
    senderE164: run.senderE164,
    senderIsOwner: run.senderIsOwner,
    approvalReviewerDeviceId: run.approvalReviewerDeviceId,
    currentChannelId: run.currentChannelId,
    chatId: run.chatId,
    channelContext: run.channelContext,
    currentMessagingTarget: run.currentMessagingTarget,
    currentThreadTs: run.currentThreadTs,
    currentMessageId: run.currentMessageId,
    currentInboundAudio: run.currentInboundAudio,
    replyToMode: run.replyToMode,
  };
}

export function projectTrajectorySessionTarget(
  target: EmbeddedRunAttemptParams["sessionTarget"],
  omitMissing = false,
) {
  const sessionTarget =
    target?.agentId && target.sessionId && target.sessionKey && target.storePath
      ? {
          agentId: target.agentId,
          sessionId: target.sessionId,
          sessionKey: target.sessionKey,
          storePath: target.storePath,
        }
      : undefined;
  return omitMissing && !sessionTarget ? {} : { sessionTarget };
}
