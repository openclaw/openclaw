import { WORKBOARD_ALL_BOARDS_FILTER } from "../../lib/workboard/board-filter.ts";

export function workboardPageTarget(boardId?: string) {
  return {
    id: "workboard",
    path: boardId && boardId !== WORKBOARD_ALL_BOARDS_FILTER ? [boardId] : [],
  };
}
