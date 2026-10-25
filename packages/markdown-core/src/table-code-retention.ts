import type { PositionedNode } from "./reasoning-tag-parser.js";

/** An unfinished table delimiter can still rejoin its preceding paragraph. */
export function retainTableParagraph(
  retainStart: number,
  textLength: number,
  block: PositionedNode,
  previous: PositionedNode | undefined,
): number {
  const startLine = block.position?.start?.line;
  return block.type === "table" &&
    block.children?.length === 1 &&
    block.position?.end?.offset === textLength &&
    previous?.type === "paragraph" &&
    startLine !== undefined &&
    previous.position?.end?.line === startLine - 1
    ? Math.min(retainStart, previous.position?.start?.offset ?? retainStart)
    : retainStart;
}
