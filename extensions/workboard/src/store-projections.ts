import type { PersistedWorkboardBoard } from "./persistence-types.js";
import { cardBoardId } from "./store-card-helpers.js";
import type { WorkboardBoardSummary } from "./store-inputs.js";
import type { WorkboardAttachment, WorkboardCard, WorkboardRunAttempt } from "./types.js";

export function buildWorkboardBoardSummaries(
  entries: Array<{ key: string; value: PersistedWorkboardBoard }>,
  cards: WorkboardCard[],
): { boards: WorkboardBoardSummary[] } {
  const boards = new Map<string, WorkboardBoardSummary>();
  for (const entry of entries) {
    if (entry.value?.version !== 1 || !entry.value.board?.id) {
      continue;
    }
    const board = entry.value.board;
    boards.set(board.id, {
      id: board.id,
      ...(board.name ? { name: board.name } : {}),
      ...(board.description ? { description: board.description } : {}),
      ...(board.icon ? { icon: board.icon } : {}),
      ...(board.color ? { color: board.color } : {}),
      ...(board.defaultWorkspace ? { defaultWorkspace: board.defaultWorkspace } : {}),
      ...(board.orchestration ? { orchestration: board.orchestration } : {}),
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
      updatedAt: board.updatedAt,
      ...(board.archivedAt ? { archivedAt: board.archivedAt } : {}),
    });
  }
  if (!boards.has("default")) {
    boards.set("default", {
      id: "default",
      total: 0,
      active: 0,
      archived: 0,
      byStatus: {},
    });
  }
  for (const card of cards) {
    const boardId = cardBoardId(card);
    const summary =
      boards.get(boardId) ??
      ({
        id: boardId,
        total: 0,
        active: 0,
        archived: 0,
        byStatus: {},
      } satisfies WorkboardBoardSummary);
    summary.total += 1;
    if (card.metadata?.archivedAt) {
      summary.archived += 1;
    } else {
      summary.active += 1;
    }
    summary.byStatus[card.status] = (summary.byStatus[card.status] ?? 0) + 1;
    summary.updatedAt = Math.max(summary.updatedAt ?? 0, card.updatedAt);
    boards.set(boardId, summary);
  }
  return {
    boards: [...boards.values()].toSorted((a, b) =>
      a.id === "default" ? -1 : b.id === "default" ? 1 : a.id.localeCompare(b.id),
    ),
  };
}

export function buildWorkboardExport(cards: WorkboardCard[]): {
  cards: WorkboardCard[];
  attachments: WorkboardAttachment[];
  exportedAt: number;
} {
  return {
    cards,
    attachments: cards.flatMap((card) => card.metadata?.attachments ?? []),
    exportedAt: Date.now(),
  };
}

export function buildWorkboardRuns(
  card: WorkboardCard | undefined,
  id: string,
): { card: WorkboardCard; attempts: WorkboardRunAttempt[] } {
  if (!card) {
    throw new Error(`card not found: ${id}`);
  }
  return { card, attempts: card.metadata?.attempts ?? [] };
}
