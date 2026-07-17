import {
  createAuthorizationInvocationContext,
  createAuthorizationPrincipal,
  type AuthorizationInvocationContext,
} from "openclaw/plugin-sdk/agent-harness-runtime";

type CodexAuthorizationContextParams = {
  /** Model provider. Never a sender-authority source. */
  provider?: string | null;
  messageProvider?: string | null;
  messageChannel?: string | null;
  agentAccountId?: string | null;
  senderId?: string | null;
  senderIsOwner?: boolean;
  isAuthorizedSender?: boolean;
  memberRoleIds?: readonly string[] | null;
  agentId?: string | null;
  sessionKey?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  conversationId?: string | null;
  chatId?: string | null;
  currentChannelId?: string | null;
  currentMessagingTarget?: string | null;
  messageTo?: string | null;
  parentConversationId?: string | null;
  threadId?: string | number | null;
  currentThreadTs?: string | null;
  messageThreadId?: string | number | null;
  trigger?: string | null;
};

/** Pins host-authenticated sender and conversation facts to one Codex turn. */
export function buildCodexAuthorizationContext(
  params: CodexAuthorizationContextParams,
): AuthorizationInvocationContext {
  return createAuthorizationInvocationContext({
    principal: createAuthorizationPrincipal({
      provider: params.messageProvider ?? params.messageChannel,
      accountId: params.agentAccountId,
      senderId: params.senderId,
      senderIsOwner: params.senderIsOwner,
      isAuthorizedSender: params.isAuthorizedSender,
      roleIds: params.memberRoleIds,
    }),
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    runId: params.runId,
    conversationId:
      params.conversationId ??
      params.chatId ??
      params.currentChannelId ??
      params.currentMessagingTarget ??
      params.messageTo,
    parentConversationId: params.parentConversationId,
    threadId: params.threadId ?? params.currentThreadTs ?? params.messageThreadId,
    trigger: params.trigger,
  });
}
