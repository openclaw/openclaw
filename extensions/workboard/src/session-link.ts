import type { WorkboardCard } from "@openclaw/workboard-contract";
import { cardBoardId, cardRunId, cardSessionKey } from "./store-card-helpers.js";
import { DEFAULT_WORKBOARD_DISPATCH_OWNER } from "./store-constants.js";

function sanitizeSessionSegment(value: string | undefined, fallback: string): string {
  const sanitized = (value ?? fallback)
    .trim()
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (sanitized || fallback).slice(0, 96);
}

export function workboardSessionKeyForCard(card: WorkboardCard): string {
  const boardId = sanitizeSessionSegment(cardBoardId(card), "default");
  const cardId = sanitizeSessionSegment(card.id, "card");
  const suffix = `subagent:workboard-${boardId}-${cardId}`;
  return card.agentId ? `agent:${sanitizeSessionSegment(card.agentId, "agent")}:${suffix}` : suffix;
}

function sessionKeyMatchesCard(candidate: string, cardKey: string): boolean {
  return (
    candidate === cardKey ||
    (cardKey.startsWith("subagent:workboard-") && candidate.endsWith(`:${cardKey}`))
  );
}

export function workboardCardMatchesLifecycleLink(
  card: WorkboardCard,
  source: { sessionKey?: string; runId?: string },
): boolean {
  const linkedSessionKey = cardSessionKey(card);
  const sessionMatches = Boolean(
    source.sessionKey &&
    (linkedSessionKey
      ? sessionKeyMatchesCard(source.sessionKey, linkedSessionKey)
      : sessionKeyMatchesCard(source.sessionKey, workboardSessionKeyForCard(card))),
  );
  const linkedRunId = cardRunId(card);
  if (linkedRunId && source.runId) {
    if (source.runId !== linkedRunId) {
      const launch = card.metadata?.automation?.launch;
      const sourceBelongsToPriorAttempt = card.metadata?.attempts?.some(
        (attempt) => attempt.runId === source.runId && attempt.runId !== linkedRunId,
      );
      const mayBackfillProvisionalRun =
        !sourceBelongsToPriorAttempt &&
        ((launch?.provisionalRunId === linkedRunId &&
          (launch.phase === "prepared" ||
            (launch.phase === "accepted" && launch.acceptedRunId === undefined))) ||
          (!launch && linkedRunId.startsWith(`workboard:${card.id}:`)));
      if (!mayBackfillProvisionalRun) {
        return false;
      }
    }
    return linkedSessionKey && source.sessionKey ? sessionMatches : true;
  }
  return sessionMatches;
}

export function workboardCardSessionLookupKey(card: WorkboardCard): string {
  const linked = cardSessionKey(card);
  if (linked) {
    return linked;
  }
  const key = workboardSessionKeyForCard(card);
  // The dispatcher claim is not a session owner before acceptance records a link.
  return card.agentId === DEFAULT_WORKBOARD_DISPATCH_OWNER &&
    card.metadata?.claim?.ownerId === DEFAULT_WORKBOARD_DISPATCH_OWNER
    ? key.slice(key.indexOf("subagent:workboard-"))
    : key;
}
