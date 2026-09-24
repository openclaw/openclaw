import type { GatewaySessionRow } from "../../api/types.ts";
import { getWorkboardLifecycle } from "./lifecycle.ts";
import type {
  WorkboardCard,
  WorkboardHealthKey,
  WorkboardTaskSummary,
  WorkboardUiState,
} from "./types.ts";

const WORKBOARD_RECENT_DONE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

function hasWorkboardProofEvidence(card: WorkboardCard): boolean {
  return Boolean(
    card.metadata?.proof?.length ||
    card.metadata?.artifacts?.length ||
    card.metadata?.attachments?.length,
  );
}

function taskFailedTerminal(task: WorkboardTaskSummary | undefined): boolean {
  return task?.status === "failed" || task?.status === "cancelled" || task?.status === "timed_out";
}

function countCardFailedAttempts(card: WorkboardCard): number {
  if (card.metadata?.failureCount !== undefined) {
    return card.metadata.failureCount;
  }
  return (
    card.metadata?.attempts?.filter(
      (attempt) =>
        attempt.status === "failed" || attempt.status === "blocked" || attempt.status === "stopped",
    ).length ?? 0
  );
}

export function workboardCardMatchesHealthKey(
  card: WorkboardCard,
  key: WorkboardHealthKey,
  sessions: readonly GatewaySessionRow[],
  task?: WorkboardTaskSummary,
): boolean {
  switch (key) {
    case "running":
      return card.status === key || getWorkboardLifecycle(card, sessions, task).state === key;
    case "blocked":
      return card.status === "blocked";
    case "stale":
      return Boolean(
        card.metadata?.stale || getWorkboardLifecycle(card, sessions, task).state === key,
      );
    case "readyUnassigned":
      return card.status === "ready" && !card.agentId?.trim() && !card.metadata?.claim;
    case "missingProof":
      return card.status === "done" && !hasWorkboardProofEvidence(card);
    case "failedAttempts":
      return countCardFailedAttempts(card) > 0 || taskFailedTerminal(task);
  }
  return false;
}

export function filterWorkboardCards(params: {
  cards: readonly WorkboardCard[];
  filters: Pick<
    WorkboardUiState,
    "statusFilter" | "priorityFilter" | "attentionFilter" | "donePeriod"
  >;
  tasksByCardId: ReadonlyMap<string, WorkboardTaskSummary>;
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
      ![...attentionFilter].some((key) =>
        workboardCardMatchesHealthKey(
          card,
          key,
          params.sessions,
          params.tasksByCardId.get(card.id),
        ),
      )
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
