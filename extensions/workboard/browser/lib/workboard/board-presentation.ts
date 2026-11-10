import { t } from "../../i18n/index.ts";
import type {
  WorkboardBoardSummary,
  WorkboardEmptyColumnMode,
  WorkboardStatus,
  WorkboardUiState,
} from "./types.ts";

export function workboardBoardName(board: Pick<WorkboardBoardSummary, "id" | "name">): string {
  const name = board.name?.trim();
  return name || (board.id === "default" ? t("workboard.defaultBoard") : board.id);
}

export function workboardBoardLabel(board: Pick<WorkboardBoardSummary, "id" | "name">): string {
  const explicitName = board.name?.trim();
  return explicitName && explicitName !== board.id
    ? `${explicitName} (${board.id})`
    : workboardBoardName(board);
}

/** The translated native status name, used wherever a board defines no label. */
export const formatStatusLabel = (status: WorkboardStatus) => t(`workboard.status.${status}`);

export type WorkboardColumnPresentation = {
  /** Status columns in display order; also the statuses offered by status pickers. */
  statuses: readonly WorkboardStatus[];
  /** Statuses a board leaves out; their cards share one "Other statuses" lane. */
  otherStatuses: readonly WorkboardStatus[];
  label: (status: WorkboardStatus) => string;
  emptyColumnMode: WorkboardEmptyColumnMode;
};

/**
 * Column presentation for one board view. Only a single Cards board with saved
 * columns differs from the default; "All boards" always shows every status.
 */
export function workboardColumnPresentation(
  state: Pick<WorkboardUiState, "boards" | "boardFilter" | "statuses" | "emptyColumnMode">,
  boardId: string = state.boardFilter,
): WorkboardColumnPresentation {
  const columns = state.boards.find((board) => board.id === boardId)?.columns;
  const statuses = columns?.visible ?? state.statuses;
  const labels = columns?.labels;
  return {
    statuses,
    otherStatuses: columns ? state.statuses.filter((status) => !statuses.includes(status)) : [],
    label: labels ? (status) => labels[status] ?? formatStatusLabel(status) : formatStatusLabel,
    emptyColumnMode: state.emptyColumnMode ?? columns?.emptyColumnMode ?? "show",
  };
}

/** Status for a new card: Todo when the board shows it, else the board's first column. */
export function workboardDefaultDraftStatus(
  presentation: Pick<WorkboardColumnPresentation, "statuses">,
): WorkboardStatus {
  return presentation.statuses.includes("todo") ? "todo" : (presentation.statuses[0] ?? "todo");
}
