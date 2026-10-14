import type { GatewaySessionRow } from "../../api/types.ts";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import type {
  WorkboardCard,
  WorkboardHealthKey,
  WorkboardStatus,
  WorkboardUiState,
} from "./types.ts";

const WORKBOARD_RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

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

export function filterWorkboardCards(params: {
  cards: readonly WorkboardCard[];
  filters: Pick<
    WorkboardUiState,
    "statusFilter" | "priorityFilter" | "attentionFilter" | "donePeriod"
  >;
  sessions: readonly GatewaySessionRow[];
  now: number;
  ignore?: "status" | "priority" | "attention";
}): WorkboardCard[] {
  const { statusFilter, priorityFilter, attentionFilter, donePeriod } = params.filters;
  return params.cards.filter((card) => {
    if (params.ignore !== "status" && statusFilter.size && !statusFilter.has(card.status)) {
      return false;
    }
    if (params.ignore !== "priority" && priorityFilter.size && !priorityFilter.has(card.priority)) {
      return false;
    }
    if (
      params.ignore !== "attention" &&
      attentionFilter.size &&
      ![...attentionFilter].some((key) => workboardCardMatchesHealthKey(card, key, params.sessions))
    ) {
      return false;
    }
    // The completion window trims history without hiding unfinished work.
    return (
      donePeriod === "all" ||
      card.status !== "done" ||
      (card.completedAt ?? card.updatedAt) >= params.now - WORKBOARD_RECENT_DONE_WINDOW_MS
    );
  });
}
