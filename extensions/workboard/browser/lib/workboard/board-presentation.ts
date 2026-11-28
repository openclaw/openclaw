import { t } from "../../i18n/index.ts";
import type { WorkboardBoardSummary } from "./types.ts";

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
