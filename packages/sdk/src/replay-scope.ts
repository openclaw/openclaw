import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseAgentSessionKey,
} from "@openclaw/session-url-contract/session-key-normalization";

export type ReplaySessionScope = { sessionKey?: string; agentId?: string; sessionId?: string };
type UnsubscribedSession = {
  key: string;
  requestKey: string;
  agentId?: string;
  requestedAgentId?: string;
};

export function readUnsubscribedSession(
  params: unknown,
  response: unknown,
): UnsubscribedSession | undefined {
  const result = asRecord(response);
  if (result.subscribed !== false || typeof result.key !== "string") {
    return undefined;
  }
  const request = asRecord(params);
  const key = normalizeSessionKeyPreservingOpaquePeerIds(result.key);
  const owner = parseAgentSessionKey(key)?.agentId;
  const requestedAgentId =
    typeof request.agentId === "string" ? normalizeAgentId(request.agentId) : undefined;
  const requestKey = normalizeSessionKeyPreservingOpaquePeerIds(
    typeof request.key === "string" ? request.key : undefined,
  );
  return {
    key,
    requestKey,
    agentId:
      owner ??
      requestedAgentId ??
      (key === "global" ? parseAgentSessionKey(requestKey)?.agentId : undefined),
    requestedAgentId,
  };
}

export function matchesUnsubscribedSession(
  scope: ReplaySessionScope,
  subscription: UnsubscribedSession,
): boolean {
  const key = normalizeSessionKeyPreservingOpaquePeerIds(scope.sessionKey);
  const owner = scope.agentId ?? parseAgentSessionKey(key)?.agentId;
  if (subscription.agentId && (!owner || normalizeAgentId(owner) !== subscription.agentId)) {
    // An ACK can bind the same default-agent address, but cannot infer an owner
    // for a differently addressed request or a qualified sentinel literal.
    return (
      !owner &&
      subscription.requestedAgentId === undefined &&
      key === subscription.requestKey &&
      key !== "global" &&
      key !== "unknown" &&
      !key.startsWith("agent:")
    );
  }
  if (key === subscription.key || key === subscription.requestKey) {
    return true;
  }
  // Main aliases depend on Gateway config; the acknowledgment binds its exact
  // request alias. Raw global/unknown remain distinct from qualified literals.
  return (
    key !== "global" &&
    key !== "unknown" &&
    !key.startsWith("agent:") &&
    (key === parseAgentSessionKey(subscription.key)?.rest ||
      key === parseAgentSessionKey(subscription.requestKey)?.rest)
  );
}
