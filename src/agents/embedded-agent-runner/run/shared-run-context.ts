import type { EmbeddedForegroundPromptContext } from "./params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Preserve the caller-owned reply and stream callbacks at attempt dispatch. */
export function projectEmbeddedReplyCallbacks(
  run: Pick<
    EmbeddedRunAttemptParams,
    | "replyOperation"
    | "shouldEmitToolResult"
    | "shouldEmitToolOutput"
    | "onPartialReply"
    | "onAssistantMessageStart"
    | "onBlockReply"
    | "onBlockReplyFlush"
    | "blockReplyBreak"
    | "blockReplyChunking"
    | "onReasoningStream"
    | "streamReasoningInNonStreamModes"
    | "onReasoningEnd"
    | "onToolResult"
    | "onAgentToolResult"
    | "onAgentEvent"
  >,
) {
  return {
    replyOperation: run.replyOperation,
    shouldEmitToolResult: run.shouldEmitToolResult,
    shouldEmitToolOutput: run.shouldEmitToolOutput,
    onPartialReply: run.onPartialReply,
    onAssistantMessageStart: run.onAssistantMessageStart,
    onBlockReply: run.onBlockReply,
    onBlockReplyFlush: run.onBlockReplyFlush,
    blockReplyBreak: run.blockReplyBreak,
    blockReplyChunking: run.blockReplyChunking,
    onReasoningStream: run.onReasoningStream,
    streamReasoningInNonStreamModes: run.streamReasoningInNonStreamModes,
    onReasoningEnd: run.onReasoningEnd,
    onToolResult: run.onToolResult,
    onAgentToolResult: run.onAgentToolResult,
    onAgentEvent: async (event: Parameters<NonNullable<typeof run.onAgentEvent>>[0]) =>
      run.onAgentEvent?.(event),
  };
}

export function projectEmbeddedMessageContext(run: Partial<EmbeddedForegroundPromptContext>) {
  return {
    requesterOrigin: run.requesterOrigin,
    operatorProfileId: run.operatorProfileId,
    conversationId: run.conversationId,
    senderId: run.senderId,
    senderName: run.senderName,
    senderUsername: run.senderUsername,
    senderE164: run.senderE164,
    senderIsOwner: run.senderIsOwner,
    gitContributorProfileId: run.gitContributorProfileId,
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
