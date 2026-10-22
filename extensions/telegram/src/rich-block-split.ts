// Chunk-limit enforcement for typed rich blocks: surrogate-safe, wrapper- and
// caption-preserving splitting against the live-verified Bot API limits.
import { avoidTrailingHighSurrogateBreak } from "openclaw/plugin-sdk/text-chunking";
import {
  countRichTextChars,
  measureInputRichBlocks,
  normalizeInputRichBlocks,
  normalizeRichText,
  type InputRichBlock,
  type RichText,
} from "./rich-block-model.js";
import { splitTelegramPlainTextChunks } from "./rich-plain-fallback.js";

const TELEGRAM_RICH_MEDIA_LIMIT = 50;

type RichBlockBudget = { chars: number; blocks: number; media: number };
type RichBlockLimits = { textLimit: number; blockLimit: number };

function addRichBlockBudget(left: RichBlockBudget, right: RichBlockBudget): RichBlockBudget {
  return {
    chars: left.chars + right.chars,
    blocks: left.blocks + right.blocks,
    media: left.media + right.media,
  };
}

function exceedsRichBlockLimits(size: RichBlockBudget, limits: RichBlockLimits): boolean {
  return (
    size.chars > limits.textLimit ||
    size.blocks > limits.blockLimit ||
    size.media > TELEGRAM_RICH_MEDIA_LIMIT
  );
}

type RichTextWrapper = Extract<RichText, { text: RichText }>;

function groupRichBlockItems<T>(
  items: readonly T[],
  limits: RichBlockLimits,
  measure: (item: T) => RichBlockBudget,
  containerBlocks = 0,
  firstChunkChars = 0,
): T[][] {
  const chunks: T[][] = [];
  let current: T[] = [];
  let size: RichBlockBudget = { chars: firstChunkChars, blocks: containerBlocks, media: 0 };
  for (const item of items) {
    const itemSize = measure(item);
    // Keep an indivisible oversized item whole for the existing plain fallback.
    if (current.length > 0 && exceedsRichBlockLimits(addRichBlockBudget(size, itemSize), limits)) {
      chunks.push(current);
      current = [];
      size = { chars: 0, blocks: containerBlocks, media: 0 };
    }
    current.push(item);
    size = addRichBlockBudget(size, itemSize);
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

function wrapRichTextFragment(fragment: RichText, wrappers: readonly RichTextWrapper[]): RichText {
  let node = fragment;
  for (let index = wrappers.length - 1; index >= 0; index -= 1) {
    node = { ...wrappers[index]!, text: node };
  }
  return node;
}

// Split a RichText tree into pieces of at most `limit` plain chars, duplicating
// style/link wrappers across boundaries so link targets survive the split.
function splitRichTextByChars(text: RichText, limit: number): RichText[] {
  const pieces: RichText[] = [];
  let current: RichText[] = [];
  let chars = 0;
  const flush = () => {
    if (current.length > 0) {
      pieces.push(normalizeRichText(current));
      current = [];
      chars = 0;
    }
  };
  const visit = (node: RichText, wrappers: readonly RichTextWrapper[]) => {
    if (typeof node === "string") {
      let offset = 0;
      while (offset < node.length) {
        if (chars >= limit) {
          flush();
        }
        const budget = limit - chars;
        const end = avoidTrailingHighSurrogateBreak(
          node,
          offset,
          Math.min(node.length, offset + budget),
        );
        const fragment = node.slice(offset, end);
        current.push(wrapRichTextFragment(fragment, wrappers));
        chars += fragment.length;
        offset = end;
      }
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) {
        visit(child, wrappers);
      }
      return;
    }
    if (node.type === "mathematical_expression" || node.type === "custom_emoji") {
      // Atomic leaves: never sliced, only placed whole into the current piece.
      const atomicChars = countRichTextChars(node);
      if (chars > 0 && chars + atomicChars > limit) {
        flush();
      }
      current.push(wrapRichTextFragment(node, wrappers));
      chars += atomicChars;
      return;
    }
    visit(node.text, [...wrappers, node]);
  };
  visit(text, []);
  flush();
  return pieces;
}

function splitOversizedRichBlock(block: InputRichBlock, limits: RichBlockLimits): InputRichBlock[] {
  const { textLimit, blockLimit } = limits;
  if (!exceedsRichBlockLimits(measureInputRichBlocks([block]), limits)) {
    return [block];
  }
  if (block.type === "pre") {
    const language = block.language;
    return splitTelegramPlainTextChunks(block.text, textLimit).map((piece) =>
      language ? { type: "pre", text: piece, language } : { type: "pre", text: piece },
    );
  }
  if (block.type === "paragraph" || block.type === "heading") {
    return splitRichTextByChars(block.text, textLimit).map((piece) =>
      block.type === "heading"
        ? { type: "heading", text: piece, size: block.size }
        : { type: "paragraph", text: piece },
    );
  }
  if (
    block.type === "blockquote" ||
    block.type === "details" ||
    block.type === "collage" ||
    block.type === "slideshow"
  ) {
    const wrapperChars =
      block.type === "blockquote"
        ? countRichTextChars(block.credit ?? "")
        : block.type === "details"
          ? countRichTextChars(block.summary)
          : countRichTextChars(block.caption?.text ?? "") +
            countRichTextChars(block.caption?.credit ?? "");
    const remainingText = textLimit - wrapperChars;
    if (
      block.blocks.length === 0 ||
      remainingText < 0 ||
      (remainingText === 0 && measureInputRichBlocks(block.blocks).chars > 0)
    ) {
      // Wrapper text cannot be divided without losing its owner; the existing
      // plain fallback handles this irreducibly oversized semantic unit.
      return [block];
    }
    const pieces = splitTelegramRichBlocks(block.blocks, {
      textLimit: Math.max(1, remainingText),
      blockLimit: Math.max(1, blockLimit - 1),
    });
    if (block.type === "blockquote") {
      // Attribution belongs at the quote's end, so emit the credit only once.
      return pieces.map((inner, index) =>
        index === pieces.length - 1 && block.credit !== undefined
          ? { type: "blockquote", blocks: inner, credit: block.credit }
          : { type: "blockquote", blocks: inner },
      );
    }
    if (block.type === "details") {
      return pieces.map((inner) => ({ ...block, blocks: inner }));
    }
    const { caption, ...album } = block;
    const albumPieces: InputRichBlock[] = [];
    for (const [index, inner] of pieces.entries()) {
      albumPieces.push(
        index === 0 && caption !== undefined
          ? { ...album, blocks: inner, caption }
          : { ...album, blocks: inner },
      );
    }
    return albumPieces;
  }
  if (block.type === "table") {
    // Row-splitting a table with rowspans would strand spans across messages;
    // such tables stay atomic and degrade via the TEXT_TOO_LONG fallback.
    if (block.cells.some((row) => row.some((cell) => (cell.rowspan ?? 1) > 1))) {
      return [block];
    }
    const { caption, ...tableRest } = block;
    const pieces: InputRichBlock[] = [];
    const groups = groupRichBlockItems(
      block.cells,
      limits,
      (row) => ({
        chars: row.reduce((total, cell) => total + countRichTextChars(cell.text ?? ""), 0),
        blocks: 1,
        media: 0,
      }),
      1,
      countRichTextChars(caption ?? ""),
    );
    for (const cells of groups) {
      pieces.push(
        pieces.length === 0 && caption !== undefined
          ? { ...tableRest, cells, caption }
          : { ...tableRest, cells },
      );
    }
    return pieces;
  }
  if (block.type === "list") {
    return groupRichBlockItems(
      block.items,
      limits,
      (item) => {
        const measured = measureInputRichBlocks(item.blocks);
        return { ...measured, blocks: measured.blocks + 1 };
      },
      1,
    ).map((items) => ({ type: "list", items }));
  }
  // Remaining atomic blocks stay intact and degrade through the existing
  // structural-error plain fallback if Telegram rejects them.
  return [block];
}

// Chunking is locality-blind for anchors: an anchor_link whose target lands in
// an earlier chunk renders as an inert link. Accepted trade-off — it needs a
// >32k message with cross-chunk fragment links, and delivery is unaffected.
export function splitTelegramRichBlocks(
  blocks: readonly InputRichBlock[],
  options: { blockLimit?: number; textLimit?: number } = {},
): InputRichBlock[][] {
  const blockLimit = Math.max(1, Math.floor(options.blockLimit ?? 500));
  const textLimit = Math.max(1, Math.floor(options.textLimit ?? 32_768));
  if (blocks.length === 0) {
    return [];
  }
  const limits = { textLimit, blockLimit };
  const expanded = normalizeInputRichBlocks(blocks).flatMap((block) =>
    splitOversizedRichBlock(block, limits),
  );
  return groupRichBlockItems(expanded, limits, (block) => measureInputRichBlocks([block]));
}
