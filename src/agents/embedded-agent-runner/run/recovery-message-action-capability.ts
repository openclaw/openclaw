import {
  readChannelSourceTurnId,
  readChannelSourceTurnSameThreadRequired,
} from "../../../auto-reply/reply/source-turn-id.js";
import type { ChannelId } from "../../../channels/plugins/types.public.js";
import {
  isTrustedMessageActionTurnIngress,
  mintMessageActionTurnCapability,
  resolveMessageActionTurnCapabilityLifetime,
} from "../../../gateway/message-action-turn-capability.js";
import { normalizeMessageChannel } from "../../../utils/message-channel-normalize.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type RecoveryMessageActionCapabilityParams = Pick<
  RunEmbeddedAgentParams,
  | "agentId"
  | "agentAccountId"
  | "chatType"
  | "currentChannelId"
  | "currentThreadTs"
  | "hasRepliedRef"
  | "isAuthorizedSender"
  | "messageActionTurnCapability"
  | "messageChannel"
  | "messageProvider"
  | "messageTo"
  | "memberRoleIds"
  | "replyToMode"
  | "runId"
  | "sessionId"
  | "sessionKey"
  | "senderId"
  | "senderIsOwner"
  | "timeoutMs"
>;

/** Reconstructs a one-run action capability from host-only restart correlation. */
export function createRecoveryMessageActionTurnCapability(
  params: RecoveryMessageActionCapabilityParams,
): string | undefined {
  const sourceTurnId = readChannelSourceTurnId(params);
  const sourceChannel = normalizeMessageChannel(params.messageProvider ?? params.messageChannel);
  if (
    params.messageActionTurnCapability ||
    !sourceTurnId ||
    !sourceChannel ||
    !isTrustedMessageActionTurnIngress(sourceChannel) ||
    !params.agentId ||
    !params.sessionKey ||
    !params.currentChannelId
  ) {
    return undefined;
  }
  return mintMessageActionTurnCapability({
    agentId: params.agentId,
    runId: params.runId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    requesterAccountId: params.agentAccountId,
    requesterSenderId: params.senderId ?? undefined,
    requesterSenderIsOwner: params.senderIsOwner,
    requesterIsAuthorizedSender: params.isAuthorizedSender,
    requesterRoleIds: params.memberRoleIds,
    toolContext: {
      currentChannelId: params.currentChannelId,
      currentChatType: params.chatType,
      currentMessagingTarget: params.messageTo,
      currentChannelProvider: sourceChannel as ChannelId,
      currentThreadTs: params.currentThreadTs,
      currentSourceTurnId: sourceTurnId,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
      sameChannelThreadRequired: readChannelSourceTurnSameThreadRequired(params),
    },
    ...resolveMessageActionTurnCapabilityLifetime(params.timeoutMs),
  });
}
