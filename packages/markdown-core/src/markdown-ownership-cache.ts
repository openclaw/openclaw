import { expectDefined } from "@openclaw/normalization-core";
import type {
  MarkdownBlock,
  MarkdownCodeRegion,
  MarkdownOwnership,
  ParsedOwnership,
} from "./reasoning-tag-parser.js";

// Streaming re-parses a growing reply on every delta. A settled boundary lets a
// later text that keeps the source before it reuse that ownership and parse only
// from the boundary. micromark carries container, lazy-line, and interrupt state
// into the next block (after indented code it will not start an ordered list at
// 2), so a boundary is a top-level block that starts with a visible character at
// column 0 after a blank line that follows a paragraph, heading, thematic break,
// or fenced code block, where that state is reset; parsing from it must also
// reproduce the whole parse. Link reference definitions can rewrite earlier inline
// code, so text containing "]:" never uses a boundary. Short texts are cheap to
// parse and mostly asked about once, so they skip both caches.
const OWNERSHIP_CACHE_MIN_LENGTH = 256;
// Each streamed reply keeps about two boundaries and four recent texts per delta.
const SETTLED_BOUNDARY_LIMIT = 16;
const RECENT_OWNERSHIP_LIMIT = 32;
// Cached texts stay reachable, so both caches share a budget of retained source
// characters; a text over half of it is parsed without caching.
const RETAINED_CHARS_LIMIT = 1_000_000;
const RESETTING_BLOCK_TYPES = new Set(["heading", "paragraph", "thematicBreak"]);
const BLANK_LINE_RE = /(?:\r\n|\r(?!\n)|\n)[^\S\r\n]*(?:\r|\n)/u;
// CommonMark code needs a literal delimiter or indentation, even inside containers.
const CODE_SYNTAX_RE = /[`~\t]| {4}/u;

type SettledBoundary = {
  /** Source through the first character of the boundary block. */
  prefix: string;
  /** Offset of the boundary block, where parsing resumes. */
  start: number;
  regions: MarkdownCodeRegion[];
  completedParagraphs: MarkdownOwnership["completedParagraphs"];
  /** A later candidate that did not reproduce, so it is not checked again. */
  rejectedStart?: number;
};

/** Reuses Markdown ownership across the growing texts of streamed replies. */
export function createMarkdownOwnershipCache(parseSource: (text: string) => ParsedOwnership) {
  const settledBoundaries: SettledBoundary[] = [];
  // Reply directive and media parsing ask about the same text several times per delta.
  const recentOwnership: Array<{ text: string; ownership: MarkdownOwnership }> = [];

  function trimToRetainedBudget() {
    let retained =
      recentOwnership.reduce((sum, entry) => sum + entry.text.length, 0) +
      settledBoundaries.reduce((sum, boundary) => sum + boundary.prefix.length, 0);
    // The newest text and boundary each fit in half of the budget.
    while (retained > RETAINED_CHARS_LIMIT && recentOwnership.length > 1) {
      retained -= recentOwnership.pop()?.text.length ?? 0;
    }
    while (retained > RETAINED_CHARS_LIMIT && settledBoundaries.length > 1) {
      retained -= settledBoundaries.pop()?.prefix.length ?? 0;
    }
  }

  function findSettledBoundary(text: string): SettledBoundary | undefined {
    if (!canUseBoundaries(text)) {
      return undefined;
    }
    const index = settledBoundaries.findIndex((boundary) => text.startsWith(boundary.prefix));
    if (index === -1) {
      return undefined;
    }
    const [boundary] = settledBoundaries.splice(index, 1);
    settledBoundaries.unshift(expectDefined(boundary, "settled Markdown boundary"));
    return boundary;
  }

  function resumeOwnership(text: string, boundary: SettledBoundary): ParsedOwnership {
    const { start } = boundary;
    const tail = parseSource(text.slice(start));
    const shift = <T extends { start: number; end: number }>(item: T): T => ({
      ...item,
      start: item.start + start,
      end: item.end + start,
    });
    const regions = [...boundary.regions, ...tail.ownership.regions.map(shift)];
    return {
      ownership: {
        regions,
        codeSpans: regions.map((region): [number, number] => [region.start, region.end]),
        textSpans: [],
        retainStart: start + tail.ownership.retainStart,
        completedParagraphs: [
          ...boundary.completedParagraphs,
          ...tail.ownership.completedParagraphs.map(shift),
        ],
      },
      blocks: tail.blocks.map(shift),
    };
  }

  function createSettledBoundary(
    text: string,
    parsed: ParsedOwnership,
    current: SettledBoundary | undefined,
  ): SettledBoundary | undefined {
    // Index 0 is either the first block or the block `current` starts at.
    for (let index = parsed.blocks.length - 1; index > 0; index -= 1) {
      const previous = expectDefined(parsed.blocks[index - 1], "Markdown block");
      const { start } = expectDefined(parsed.blocks[index], "Markdown block");
      if (!startsAfterReset(text, previous, start)) {
        continue;
      }
      if (start === current?.rejectedStart || !resumesIdentically(text, parsed, start)) {
        if (current) {
          current.rejectedStart = start;
        }
        return undefined;
      }
      return {
        prefix: text.slice(0, start + 1),
        start,
        regions: parsed.ownership.regions.filter((region) => region.start < start),
        completedParagraphs: parsed.ownership.completedParagraphs.filter(
          (paragraph) => paragraph.start < start,
        ),
      };
    }
    return undefined;
  }

  function resumesIdentically(text: string, parsed: ParsedOwnership, start: number): boolean {
    const tail = parseSource(text.slice(start));
    const shifted = (items: Array<{ start: number; end: number }>) =>
      JSON.stringify(
        items.map((item) => ({ ...item, start: item.start + start, end: item.end + start })),
      );
    const after = (items: Array<{ start: number }>) =>
      JSON.stringify(items.filter((item) => item.start >= start));
    return (
      shifted(tail.blocks) === after(parsed.blocks) &&
      shifted(tail.ownership.regions) === after(parsed.ownership.regions) &&
      shifted(tail.ownership.completedParagraphs) === after(parsed.ownership.completedParagraphs)
    );
  }

  return {
    parseOwnership(text: string): MarkdownOwnership {
      if (text.length < OWNERSHIP_CACHE_MIN_LENGTH || text.length > RETAINED_CHARS_LIMIT / 2) {
        return parseSource(text).ownership;
      }
      // Cached arrays and objects never leave the cache; callers receive copies.
      const recent = recentOwnership.find((entry) => entry.text === text);
      if (recent) {
        return copyOwnership(recent.ownership);
      }
      const boundary = findSettledBoundary(text);
      const parsed = boundary ? resumeOwnership(text, boundary) : parseSource(text);
      // Only a text that grew from a recent one is likely to be asked about again.
      const growing =
        boundary !== undefined || recentOwnership.some((entry) => text.startsWith(entry.text));
      const next =
        growing && canUseBoundaries(text)
          ? createSettledBoundary(text, parsed, boundary)
          : undefined;
      if (next && boundary) {
        // findSettledBoundary moved the boundary it returned to the front.
        settledBoundaries[0] = next;
      } else if (next) {
        settledBoundaries.unshift(next);
        settledBoundaries.length = Math.min(settledBoundaries.length, SETTLED_BOUNDARY_LIMIT);
      }
      recentOwnership.unshift({ text, ownership: parsed.ownership });
      recentOwnership.length = Math.min(recentOwnership.length, RECENT_OWNERSHIP_LIMIT);
      trimToRetainedBudget();
      return copyOwnership(parsed.ownership);
    },

    /** Settled code regions when the text after the boundary has no code syntax. */
    findSettledCodeRegions(text: string): MarkdownCodeRegion[] | undefined {
      const boundary = findSettledBoundary(text);
      return boundary && !CODE_SYNTAX_RE.test(text.slice(boundary.start))
        ? boundary.regions.map(copyRegion)
        : undefined;
    },
  };
}

function copyOwnership(ownership: MarkdownOwnership): MarkdownOwnership {
  return {
    ...ownership,
    regions: ownership.regions.map(copyRegion),
    codeSpans: ownership.codeSpans.map(([start, end]): [number, number] => [start, end]),
    textSpans: ownership.textSpans.map(([start, end]): [number, number] => [start, end]),
    completedParagraphs: ownership.completedParagraphs.map((paragraph) => ({ ...paragraph })),
  };
}

function copyRegion(region: MarkdownCodeRegion): MarkdownCodeRegion {
  return { ...region };
}

function canUseBoundaries(text: string): boolean {
  return text.length >= OWNERSHIP_CACHE_MIN_LENGTH && !text.includes("]:");
}

function startsAfterReset(text: string, previous: MarkdownBlock, start: number): boolean {
  const resetting =
    RESETTING_BLOCK_TYPES.has(previous.type ?? "") ||
    (previous.type === "code" &&
      /^(?:`{3}|~{3})/u.test(text.slice(previous.start, previous.start + 3)));
  // A visible first character at column 0 after a blank line always starts a block.
  return (
    resetting &&
    (text[start - 1] === "\n" || text[start - 1] === "\r") &&
    text[start] !== " " &&
    text[start] !== "\t" &&
    BLANK_LINE_RE.test(text.slice(previous.end, start))
  );
}
