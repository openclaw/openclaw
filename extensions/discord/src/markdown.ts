import { fromMarkdown } from "mdast-util-from-markdown";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-chunking";
import { findDiscordUrlRanges } from "./url-ranges.js";

type PositionedMarkdownNode = {
  type: string;
  children?: PositionedMarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

const DISCORD_NATIVE_TOKEN_RE = /<a?:[A-Za-z0-9_]+:\d+>|<\/[^>]+:\d+>/giu;

function normalizeDiscordBold(markdown: string): string {
  // This outbound contract is CommonMark: `__x__` is bold, never Discord-native underline.
  if (!markdown.includes("__")) {
    return markdown;
  }
  const spans: Array<{ start: number; end: number }> = [];
  const contentEdits: Array<{
    spanId: number;
    start: number;
    marker: string;
    consume: number;
    delimiter: false;
  }> = [];
  const starEmphasisDelimiters = new Set<number>();
  const astLinkRanges: Array<{ start: number; end: number }> = [];
  const sourceTree = fromMarkdown(markdown) as PositionedMarkdownNode;
  const pending: Array<{ node: PositionedMarkdownNode; spanId?: number }> = [{ node: sourceTree }];
  for (let event = pending.pop(); event; event = pending.pop()) {
    const { node } = event;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      node.type === "link" &&
      start !== undefined &&
      end !== undefined &&
      markdown[start] === "<" &&
      markdown[end - 1] === ">"
    ) {
      astLinkRanges.push({ start, end });
    }
    let spanId = event.spanId;
    let enteredSpan = false;
    if (
      node.type === "strong" &&
      start !== undefined &&
      end !== undefined &&
      markdown.startsWith("__", start) &&
      markdown.slice(end - 2, end) === "__"
    ) {
      spanId = spans.length;
      spans.push({ start, end });
      enteredSpan = true;
    }
    if (spanId !== undefined && start !== undefined && end !== undefined) {
      if (
        node.type === "strong" &&
        !enteredSpan &&
        markdown.startsWith("**", start) &&
        markdown.slice(end - 2, end) === "**"
      ) {
        contentEdits.push(
          { spanId, start, marker: "****", consume: 2, delimiter: false },
          { spanId, start: end - 2, marker: "****", consume: 2, delimiter: false },
        );
      } else if (node.type === "emphasis" && markdown[start] === "*" && markdown[end - 1] === "*") {
        starEmphasisDelimiters.add(start);
        starEmphasisDelimiters.add(end - 1);
        const intraword =
          /[\p{L}\p{N}]/u.test(markdown[start - 1] ?? "") ||
          /[\p{L}\p{N}]/u.test(markdown[end] ?? "");
        if (!intraword) {
          contentEdits.push(
            { spanId, start, marker: "_", consume: 1, delimiter: false },
            { spanId, start: end - 1, marker: "_", consume: 1, delimiter: false },
          );
        }
      } else if (node.type === "text") {
        for (let offset = start; offset < end; offset += 1) {
          if (markdown[offset] !== "*") {
            continue;
          }
          let precedingSlashes = 0;
          for (let index = offset - 1; index >= start && markdown[index] === "\\"; index -= 1) {
            precedingSlashes += 1;
          }
          if (precedingSlashes % 2 === 0) {
            contentEdits.push({
              spanId,
              start: offset,
              marker: "\\",
              consume: 0,
              delimiter: false,
            });
          }
        }
      }
    }
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({ node: child, spanId });
      }
    }
  }
  if (spans.length === 0) {
    return markdown;
  }
  const strongInteriorStartByEnd = new Map<number, number>();
  for (const span of spans) {
    const interiorStart = span.start + 2;
    strongInteriorStartByEnd.set(
      span.end,
      Math.min(strongInteriorStartByEnd.get(span.end) ?? interiorStart, interiorStart),
    );
  }
  const nativeTokenRanges = [...markdown.matchAll(DISCORD_NATIVE_TOKEN_RE)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
  }));
  const protectedRanges = [
    ...findDiscordUrlRanges(markdown),
    ...astLinkRanges,
    ...nativeTokenRanges,
  ]
    // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a private array.
    .sort((left, right) => left.start - right.start)
    .map(({ start, end: rawEnd }) => {
      let end = rawEnd;
      while (/[.,!?;:'"]/u.test(markdown[end - 1] ?? "")) {
        end -= 1;
      }
      let previousEnd = -1;
      while (end !== previousEnd) {
        previousEnd = end;
        while (starEmphasisDelimiters.has(end - 1)) {
          end -= 1;
        }
        let strongInteriorStart = strongInteriorStartByEnd.get(end);
        while (strongInteriorStart !== undefined && start >= strongInteriorStart) {
          end -= 2;
          strongInteriorStart = strongInteriorStartByEnd.get(end);
        }
      }
      return { start, end };
    });
  const edits = [
    ...spans.flatMap((span, spanId) =>
      [span.start, span.end - 2].map((start) => ({
        spanId,
        start,
        marker: "**",
        consume: 2,
        delimiter: true,
      })),
    ),
    ...contentEdits,
    // oxlint-disable-next-line unicorn/no-array-sort -- The spread creates a private array.
  ].sort((left, right) => left.start - right.start);
  const renderEdits = (selectedEdits: typeof edits) => {
    let cursor = 0;
    let rendered = "";
    for (const edit of selectedEdits) {
      rendered += `${markdown.slice(cursor, edit.start)}${edit.marker}`;
      cursor = edit.start + edit.consume;
    }
    return rendered + markdown.slice(cursor);
  };
  const protectedSpanIds = new Set<number>();
  const protectedEditKeys = new Set<string>();
  let rangeIndex = 0;
  for (const edit of edits) {
    while ((protectedRanges[rangeIndex]?.end ?? Number.POSITIVE_INFINITY) <= edit.start) {
      rangeIndex += 1;
    }
    const range = protectedRanges[rangeIndex];
    const overlapsRange =
      range &&
      (edit.consume === 0
        ? edit.start >= range.start && edit.start < range.end
        : edit.start < range.end && edit.start + edit.consume > range.start);
    if (overlapsRange) {
      // Bare URLs keep their whole bold span when normalization would touch URL syntax.
      // Angle autolinks already isolate that syntax, so only their overlapping edit is omitted.
      if (
        edit.delimiter ||
        !astLinkRanges.some(
          ({ start, end }) => edit.start >= start && edit.start + edit.consume <= end,
        )
      ) {
        protectedSpanIds.add(edit.spanId);
      } else {
        protectedEditKeys.add(`${edit.start}:${edit.consume}:${edit.marker}`);
      }
    }
  }
  const seenEdits = new Set<string>();
  return renderEdits(
    edits.filter((edit) => {
      const key = `${edit.start}:${edit.consume}:${edit.marker}`;
      if (protectedSpanIds.has(edit.spanId) || protectedEditKeys.has(key) || seenEdits.has(key)) {
        return false;
      }
      seenEdits.add(key);
      return true;
    }),
  );
}

export function renderDiscordMarkdown(markdown: string, tableMode: MarkdownTableMode): string {
  return normalizeDiscordBold(convertMarkdownTables(markdown, tableMode));
}
