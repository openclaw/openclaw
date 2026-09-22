import { avoidTrailingHighSurrogateBreak } from "@openclaw/normalization-core/utf16-slice";
import {
  attachBlockMetadata,
  attachListItemMetadata,
  copyHtmlTags,
  sliceListMarker,
  type MarkdownIRWithMetadata,
  type MarkdownListItemWithMetadata,
} from "./ir-metadata.js";
import { sliceAnnotationSpans, sliceLinkSpans, sliceStyleSpans } from "./ir-spans.js";
import type { MarkdownIR } from "./ir.js";

type MarkdownIRRange = { start: number; end: number };

function normalizeSliceRange(ir: MarkdownIR, start: number, end: number): MarkdownIRRange {
  const textLength = ir.text.length;
  const integerStart = Math.trunc(start) || 0;
  const integerEnd = Math.trunc(end) || 0;
  let normalizedStart =
    integerStart < 0 ? Math.max(textLength + integerStart, 0) : Math.min(integerStart, textLength);
  let normalizedEnd =
    integerEnd < 0 ? Math.max(textLength + integerEnd, 0) : Math.min(integerEnd, textLength);

  if (normalizedStart < normalizedEnd) {
    // Normalize once so text, formatting, links, and structural metadata share
    // the same complete-code-point boundaries.
    const safeStart = avoidTrailingHighSurrogateBreak(ir.text, 0, normalizedStart);
    if (safeStart !== normalizedStart) {
      normalizedStart = safeStart < normalizedStart ? safeStart : normalizedStart - 1;
    }

    const safeEnd = avoidTrailingHighSurrogateBreak(ir.text, 0, normalizedEnd);
    if (safeEnd !== normalizedEnd) {
      normalizedEnd = safeEnd > normalizedEnd ? safeEnd : normalizedEnd + 1;
    }
  }

  return { start: normalizedStart, end: normalizedEnd };
}

export function sliceMarkdownIR(ir: MarkdownIR, start: number, end: number): MarkdownIR {
  return sliceNormalizedMarkdownIR(ir, normalizeSliceRange(ir, start, end));
}

function sliceNormalizedMarkdownIR(
  ir: MarkdownIR,
  { start: normalizedStart, end: normalizedEnd }: MarkdownIRRange,
): MarkdownIR {
  const metadataIR: MarkdownIRWithMetadata = ir;
  const annotations = sliceAnnotationSpans(ir.annotations ?? [], normalizedStart, normalizedEnd);
  const sourceListItems: MarkdownListItemWithMetadata[] = ir.listItems ?? [];
  const listItems = sourceListItems.flatMap((item) => {
    const listMarker = item.listMarker
      ? sliceListMarker(item.listMarker, normalizedStart, normalizedEnd)
      : undefined;
    const taskMarker = item.taskMarker
      ? sliceListMarker(item.taskMarker, normalizedStart, normalizedEnd)
      : undefined;
    const content =
      item.contentStart !== undefined && item.contentEnd !== undefined
        ? sliceListMarker(
            { start: item.contentStart, end: item.contentEnd },
            normalizedStart,
            normalizedEnd,
          )
        : undefined;
    return listMarker || taskMarker
      ? [
          attachListItemMetadata(
            {
              kind: item.kind,
              ...(listMarker ? { listMarker } : {}),
              ...(item.task ? { task: true as const } : {}),
              ...(taskMarker ? { taskMarker } : {}),
              ...(item.listId !== undefined ? { listId: item.listId } : {}),
              ...(item.parentListId !== undefined ? { parentListId: item.parentListId } : {}),
              ...(item.depth !== undefined ? { depth: item.depth } : {}),
              ...(item.start !== undefined
                ? { start: Math.max(item.start, normalizedStart) - normalizedStart }
                : {}),
              ...(item.end !== undefined
                ? { end: Math.min(item.end, normalizedEnd) - normalizedStart }
                : {}),
            },
            {
              ...(content ? { contentStart: content.start, contentEnd: content.end } : {}),
              ...(item.markerOnly ? { markerOnly: true as const } : {}),
              sourceMarker: item.sourceMarker,
              sourceContent: item.sourceContent,
              sourceIndent: item.sourceIndent,
              sourceStartLine: item.sourceStartLine,
              sourceEndLine: item.sourceEndLine,
            },
          ),
        ]
      : [];
  });
  const blocks = (metadataIR.blocks ?? []).flatMap((block) => {
    if (block.start === block.end) {
      const containsPoint =
        normalizedStart === normalizedEnd
          ? block.start === normalizedStart
          : block.start >= normalizedStart && block.start < normalizedEnd;
      return containsPoint
        ? [{ ...block, start: block.start - normalizedStart, end: block.end - normalizedStart }]
        : [];
    }
    const sliced = sliceListMarker(block, normalizedStart, normalizedEnd);
    return sliced ? [{ ...block, ...sliced }] : [];
  });
  const sliced: MarkdownIR = {
    text: ir.text.slice(normalizedStart, normalizedEnd),
    styles: sliceStyleSpans(ir.styles, normalizedStart, normalizedEnd),
    links: sliceLinkSpans(ir.links, normalizedStart, normalizedEnd),
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(listItems.length > 0 ? { listItems } : {}),
  };
  return copyHtmlTags(ir, attachBlockMetadata(sliced, blocks), normalizedStart, normalizedEnd);
}

/** Chunkers supply ordered, disjoint ranges; metadata itself need not be sorted. */
export function sliceMarkdownIRRanges(ir: MarkdownIR, ranges: MarkdownIRRange[]): MarkdownIR[] {
  const partitions: Array<{ range: MarkdownIRRange; metadata: MarkdownIRWithMetadata }> =
    ranges.map(({ start, end }) => ({
      range: normalizeSliceRange(ir, start, end),
      metadata: { text: ir.text, styles: [], links: [] },
    }));

  function visitRanges(
    start: number,
    end: number,
    visit: (metadata: MarkdownIRWithMetadata, index: number) => void,
  ) {
    let low = 0;
    let high = partitions.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const partition = partitions[middle];
      if (partition && partition.range.end < start) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    for (let index = low; index < partitions.length; index += 1) {
      const partition = partitions[index];
      if (!partition || partition.range.start > end) {
        break;
      }
      visit(partition.metadata, index);
    }
  }

  // Inclusive candidate boundaries retain block points. The single-slice owner
  // still decides exact overlap, clipping, provenance, and metadata descriptors.
  for (const span of ir.styles) {
    visitRanges(span.start, span.end, (metadata) => metadata.styles.push(span));
  }
  for (const span of ir.links) {
    visitRanges(span.start, span.end, (metadata) => metadata.links.push(span));
  }
  for (const span of ir.annotations ?? []) {
    visitRanges(span.start, span.end, (metadata) => (metadata.annotations ??= []).push(span));
  }
  for (const item of ir.listItems ?? []) {
    const visited = new Set<number>();
    for (const marker of [item.listMarker, item.taskMarker]) {
      if (!marker) {
        continue;
      }
      visitRanges(marker.start, marker.end, (metadata, index) => {
        if (!visited.has(index)) {
          visited.add(index);
          (metadata.listItems ??= []).push(item);
        }
      });
    }
  }
  const metadataIR: MarkdownIRWithMetadata = ir;
  for (const block of metadataIR.blocks ?? []) {
    visitRanges(block.start, block.end, (metadata) => (metadata.blocks ??= []).push(block));
  }
  for (const tag of ir.htmlTags ?? []) {
    // Search by the tag's end so a long tag split across many chunks costs O(log n).
    let low = 0;
    let high = partitions.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const partition = partitions[middle];
      if (partition && partition.range.end < tag.end) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    for (let index = low; index < partitions.length; index += 1) {
      const partition = partitions[index];
      if (!partition || partition.range.start > tag.start) {
        break;
      }
      (partition.metadata.htmlTags ??= []).push(tag);
    }
  }
  return partitions.map(({ metadata, range }) => sliceNormalizedMarkdownIR(metadata, range));
}
