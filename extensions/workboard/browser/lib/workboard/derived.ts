import type { GatewaySessionRow } from "../../api/types.ts";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import type { WorkboardCard, WorkboardHealthKey, WorkboardStatus } from "./types.ts";

export function groupWorkboardCardsByStatus(
  cards: readonly WorkboardCard[],
  statuses: readonly WorkboardStatus[],
) {
  const groups = new Map<WorkboardStatus, WorkboardCard[]>(statuses.map((status) => [status, []]));
  for (const card of cards) {
    groups.get(card.status)?.push(card);
  }
  return groups;
}

function hasWorkboardProofEvidence(card: WorkboardCard): boolean {
  return Boolean(
    card.metadata?.proof?.length ||
    card.metadata?.artifacts?.length ||
    card.metadata?.attachments?.length,
  );
}

export function workboardCardMatchesHealthKey(
  card: WorkboardCard,
  key: WorkboardHealthKey,
  sessions: readonly GatewaySessionRow[],
): boolean {
  switch (key) {
    case "stale":
      return Boolean(card.metadata?.stale || getWorkboardLifecycle(card, sessions).state === key);
    case "missingProof":
      return card.status === "done" && !hasWorkboardProofEvidence(card);
  }
  return false;
}
