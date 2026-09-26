import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { asRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeSessionKeyPreservingOpaquePeerIds,
  parseAgentSessionKey,
} from "@openclaw/session-url-contract/session-key-normalization";

export type ReplaySessionScope = { sessionKey?: string; agentId?: string; sessionId?: string };
type UnsubscribedSession = { key: string; agentId?: string };

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
  return {
    key,
    agentId:
      owner ??
      (typeof request.agentId === "string" ? normalizeAgentId(request.agentId) : undefined),
  };
}

export function matchesUnsubscribedSession(
  scope: ReplaySessionScope,
  subscription: UnsubscribedSession,
): boolean {
  const key = normalizeSessionKeyPreservingOpaquePeerIds(scope.sessionKey);
  const owner = scope.agentId ?? parseAgentSessionKey(key)?.agentId;
  if (subscription.agentId && (!owner || normalizeAgentId(owner) !== subscription.agentId)) {
    return false;
  }
  return key === subscription.key;
}
