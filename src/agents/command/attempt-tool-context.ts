import { resolveConfiguredCommandOwners } from "../../auto-reply/command-auth.js";
import { resolveOwnerPromptNumbers } from "../owner-display.js";
import type { AgentAttemptParams } from "./attempt-execution.types.js";

/** Project admitted command facts into embedded and CLI tool and prompt construction. */
export function buildCommandAttemptToolContext(
  params: Pick<AgentAttemptParams, "cfg" | "messageChannel" | "opts" | "runContext" | "spawnedBy">,
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
    // Owners are a config fact, so completion turns render the user turn's prompt section.
    ownerNumbers: resolveOwnerPromptNumbers({
      ownerNumbers: resolveConfiguredCommandOwners(params.cfg, {
        channel: params.messageChannel,
        accountId: params.runContext.accountId,
      }),
    }),
    gitContributorProfileId: params.opts.gitContributorProfileId,
    scheduledToolPolicy: params.opts.scheduledToolPolicy,
    pinnedWidgetAuthoring: params.opts.pinnedWidgetAuthoring,
  };
}
