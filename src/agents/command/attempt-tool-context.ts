import type { AgentAttemptParams } from "./attempt-execution.types.js";

/** Project admitted command facts into embedded and CLI tool construction. */
export function buildCommandAttemptToolContext(
  params: Pick<AgentAttemptParams, "messageChannel" | "opts" | "runContext" | "spawnedBy">,
) {
  return {
    requesterOrigin: params.opts.requesterOrigin,
    operatorProfileId: params.opts.operatorAuthority?.profileId,
    conversationId: params.opts.requesterOrigin?.conversationId ?? params.runContext.chatId,
    chatType: params.opts.requesterOrigin?.chatType,
    messageChannel: params.messageChannel,
    messageProvider: params.opts.messageProvider ?? params.messageChannel,
    agentAccountId: params.runContext.accountId,
    groupId: params.runContext.groupId,
    groupChannel: params.runContext.groupChannel,
    groupSpace: params.runContext.groupSpace,
    spawnedBy: params.spawnedBy,
    currentChannelId: params.runContext.currentChannelId,
    chatId: params.runContext.chatId,
    channelContext: params.runContext.channelContext,
    currentThreadTs: params.runContext.currentThreadTs,
    currentInboundAudio: params.runContext.currentInboundAudio,
    replyToMode: params.runContext.replyToMode,
    senderId: params.runContext.senderId,
    senderIsOwner: params.opts.senderIsOwner,
    gitContributorProfileId: params.opts.gitContributorProfileId,
    scheduledToolPolicy: params.opts.scheduledToolPolicy,
    pinnedWidgetAuthoring: params.opts.pinnedWidgetAuthoring,
  };
}
