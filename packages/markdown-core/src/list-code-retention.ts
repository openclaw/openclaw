import type { PositionedNode } from "./reasoning-tag-parser.js";

/** Retain the current item, including any container framing an earlier reference needs. */
export function findListItemRetentionStart(
  text: string,
  blocks: readonly PositionedNode[],
  retainStart?: number,
): number {
  const offset = retainStart ?? blocks.at(-1)?.position?.start?.offset ?? text.length;
  const block = blocks.findLast((entry) => (entry.position?.start?.offset ?? Infinity) <= offset);
  if (block?.type !== "list") {
    return offset;
  }
  // A partial marker can still become continuation text; keep it with its predecessor.
  const completeLineEnd = Math.max(text.lastIndexOf("\n"), text.lastIndexOf("\r"));
  return (
    block.children?.findLast((item) => {
      const start = item.position?.start?.offset;
      return (
        start !== undefined && start <= (retainStart ?? text.length) && start < completeLineEnd
      );
    })?.position?.start?.offset ?? offset
  );
}
