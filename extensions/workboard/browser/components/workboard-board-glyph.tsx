/** @jsxImportSource @solidjs/web */
import type { WorkboardBoardSummary } from "../lib/workboard/index.ts";
import { AppearanceGlyph } from "./host-components.tsx";

export function WorkboardBoardGlyph(props: {
  board: Pick<WorkboardBoardSummary, "id" | "name" | "icon" | "color">;
  class?: string;
}) {
  return (
    <>
      {props.board.icon?.trim() || props.board.color?.trim() ? (
        <AppearanceGlyph
          icon={props.board.icon ?? null}
          color={props.board.color ?? null}
          fallback=""
          class={`workboard-board-glyph ${props.class ?? ""}`}
        />
      ) : null}
    </>
  );
}
