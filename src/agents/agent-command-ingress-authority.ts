import { createAuthorizationPrincipal } from "../plugins/authorization-policy-context.js";
import { createTurnAuthoritySnapshot } from "../plugins/turn-authority.js";
import type { AgentCommandIngressAuthorityFacts } from "./command/types.js";

/** Convert trusted direct-ingress facts into the same host-issued authority used by channel turns. */
export function createAgentCommandIngressTurnAuthority(params: {
  facts: AgentCommandIngressAuthorityFacts;
  accountId?: string;
  agentId?: string;
  sessionKey?: string;
  senderIsOwner?: boolean;
}) {
  const principal = createAuthorizationPrincipal({
    provider: params.facts.provider,
    accountId: params.facts.accountId ?? params.accountId,
    senderId: params.facts.senderId,
    senderName: params.facts.senderName,
    senderUsername: params.facts.senderUsername,
    senderE164: params.facts.senderE164,
    senderIsOwner: params.senderIsOwner === true,
    isAuthorizedSender: params.facts.isAuthorizedSender,
    roleIds: params.facts.roleIds,
  });
  const controllerKey =
    principal.kind === "sender"
      ? ["sender", principal.provider, principal.accountId, principal.senderId]
          .filter(Boolean)
          .join(":")
      : undefined;
  return createTurnAuthoritySnapshot({
    principal,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    conversationId: params.facts.conversationId,
    parentConversationId: params.facts.parentConversationId,
    threadId: params.facts.threadId,
    trigger: "channel",
    controllerKey,
  });
}
