import { createHash } from "node:crypto";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";

type SmokeProofRoute = Pick<ResolvedAgentRoute, "agentId" | "matchedBy" | "sessionKey">;

export type MSTeamsSmokeProofTrace = {
  source: "msteams.inbound.dispatch";
  ingressCorrelationHash: string;
  handlerDecisionTrace: "redacted";
  matchedBy: SmokeProofRoute["matchedBy"];
  routeAgentId: string;
  sessionKeyHash: string;
  messageIdHash?: string;
  conversationHash?: string;
  employeeIntakeSessionVisible: boolean;
  rawPeerExposed: false;
};

function stableHash(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

export function createMSTeamsSmokeProofTrace(input: {
  accountId?: string;
  conversationId?: string;
  messageId?: string;
  route: SmokeProofRoute;
  employeeIntakeSessionVisible?: boolean;
}): MSTeamsSmokeProofTrace {
  const ingressCorrelationHash =
    stableHash(
      [input.accountId, input.conversationId, input.messageId].filter(Boolean).join(":"),
    ) ?? "missing";
  const messageIdHash = stableHash(input.messageId);
  const conversationHash = stableHash(input.conversationId);
  return {
    source: "msteams.inbound.dispatch",
    ingressCorrelationHash,
    handlerDecisionTrace: "redacted",
    matchedBy: input.route.matchedBy,
    routeAgentId: input.route.agentId,
    sessionKeyHash: stableHash(input.route.sessionKey) ?? "missing",
    ...(messageIdHash ? { messageIdHash } : {}),
    ...(conversationHash ? { conversationHash } : {}),
    employeeIntakeSessionVisible: input.employeeIntakeSessionVisible === true,
    rawPeerExposed: false,
  };
}
