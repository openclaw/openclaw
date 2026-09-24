import { nothing } from "lit";
import type { WorkboardBoardSummary } from "../lib/workboard/index.ts";
import { renderAppearanceGlyph } from "./host-components.ts";

export function renderWorkboardBoardGlyph(
  board: Pick<WorkboardBoardSummary, "id" | "name" | "icon" | "color">,
  className = "",
) {
  if (!board.icon?.trim() && !board.color?.trim()) {
    return nothing;
  }
  return renderAppearanceGlyph(
    {
      icon: board.icon ?? null,
      color: board.color ?? null,
      fallback: "",
    },
    `workboard-board-glyph ${className}`,
  );
}
