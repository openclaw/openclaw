import {
  CHARS_PER_TOKEN_ESTIMATE,
  estimateStringChars,
} from "@openclaw/normalization-core/cjk-chars";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { buildTextEmbeddingInput, type EmbeddingInput } from "./embedding-inputs.js";
import { hashText } from "./hash.js";
import type { MemoryEntryProvenance } from "./types.js";

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  entryStartLine?: number;
  entryEndLine?: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
  provenance?: MemoryEntryProvenance;
};

// Persisted with index metadata so boundary changes rebuild unchanged files.
export const MEMORY_CHUNKING_VERSION = 4;

export type CuratedMarkdownEntry = {
  startLine: number;
  endLine: number;
  text: string;
  kind: "entry" | "section";
};
export function splitCuratedMarkdownEntries(content: string): CuratedMarkdownEntry[] {
  const lines = content.split("\n");
  const entries: CuratedMarkdownEntry[] = [];
  let startIndex = 0;
  let kind: CuratedMarkdownEntry["kind"] = lines[0]?.startsWith("- ") ? "entry" : "section";
  const flush = (endIndex: number) => {
    if (endIndex < startIndex) {
      return;
    }
    entries.push({
      startLine: startIndex + 1,
      endLine: endIndex + 1,
      text: lines.slice(startIndex, endIndex + 1).join("\n"),
      kind,
    });
  };
  for (let index = 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextKind = line.startsWith("- ")
      ? "entry"
      : /^#{1,6}(?:\s|$)/u.test(line)
        ? "section"
        : undefined;
    if (!nextKind) {
      continue;
    }
    flush(index - 1);
    startIndex = index;
    kind = nextKind;
  }
  flush(lines.length - 1);
  return entries;
}

/** Takes the trailing slice of text within the weighted char budget, without splitting surrogate pairs. */
function takeTailByEstimatedChars(text: string, budget: number): string {
  let acc = 0;
  let start = text.length;
  while (start > 0) {
    const previous = start - ((text.codePointAt(start - 2) ?? 0) > 0xffff ? 2 : 1);
    acc += estimateStringChars(text.slice(previous, start));
    if (!(acc <= budget)) {
      break;
    }
    start = previous;
  }
  return text.slice(start);
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number; perEntry?: boolean },
): MemoryChunk[] {
  const lines = content.split("\n");
  const maxChars = Math.max(32, chunking.tokens * CHARS_PER_TOKEN_ESTIMATE);
  const overlapChars = Math.max(0, chunking.overlap * CHARS_PER_TOKEN_ESTIMATE);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;
  let entryStartLine: number | undefined;
  let entryFirstChunk = 0;
  const curatedEntryStarts = chunking.perEntry
    ? new Map(splitCuratedMarkdownEntries(content).map((entry) => [entry.startLine, entry]))
    : undefined;

  const flush = () => {
    const firstEntry = current[0];
    const lastEntry = current[current.length - 1];
    if (!firstEntry || !lastEntry) {
      return;
    }
    const text = current.map((entry) => entry.line).join("\n");
    const startLine = firstEntry.lineNo;
    const endLine = lastEntry.lineNo;
    chunks.push({
      startLine,
      endLine,
      text,
      hash: hashText(text),
      embeddingInput: buildTextEmbeddingInput(text),
    });
  };

  const carryOverlap = (window: number) => {
    if (window <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i -= 1) {
      const entry = current[i];
      if (!entry) {
        continue;
      }
      const entrySize = estimateStringChars(entry.line) + 1;
      const remaining = window - acc;
      if (entrySize > remaining) {
        // A segment wider than the remaining window keeps only its trailing
        // slice, measured in the same weighted units as the budget.
        const tail = kept.length === 0 ? takeTailByEstimatedChars(entry.line, remaining - 1) : "";
        if (tail.length > 0) {
          kept.unshift({ line: tail, lineNo: entry.lineNo });
          acc += estimateStringChars(tail) + 1;
        }
        break;
      }
      acc += entrySize;
      kept.unshift(entry);
      if (acc >= window) {
        break;
      }
    }
    current = kept;
    currentChars = acc;
  };

  const appendSegment = (segment: string, lineNo: number, chars: number) => {
    const lineSize = chars + 1;
    if (currentChars + lineSize > maxChars && current.length > 0) {
      flush();
      // Carry and the incoming segment share one budget, including line separators.
      carryOverlap(Math.min(overlapChars, Math.max(0, maxChars - lineSize)));
    }
    current.push({ line: segment, lineNo });
    currentChars += lineSize;
  };

  const finishEntry = (entryEndLine: number) => {
    if (entryStartLine === undefined) {
      return;
    }
    // Every size fragment remains part of the same curated entry and inherits
    // its full annotation span; dropping scope on later fragments can leak them.
    for (const chunk of chunks.slice(entryFirstChunk)) {
      chunk.entryStartLine = entryStartLine;
      chunk.entryEndLine = entryEndLine;
    }
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const curatedEntry = curatedEntryStarts?.get(lineNo);
    if (curatedEntry) {
      if (current.length > 0) {
        flush();
      }
      finishEntry(lineNo - 1);
      current = [];
      currentChars = 0;
      entryStartLine = curatedEntry.kind === "entry" ? lineNo : undefined;
      entryFirstChunk = chunks.length;
    }
    if (line.length === 0) {
      appendSegment("", lineNo, 0);
    } else {
      for (let start = 0; start < line.length;) {
        const coarse = truncateUtf16Safe(line.slice(start), maxChars);
        const coarseChars = estimateStringChars(coarse);
        if (coarseChars > maxChars) {
          // Rare and supplementary ideographs can cost several tokens each.
          // Split by the estimator's units while keeping every code point intact.
          let partStart = 0;
          let partEnd = 0;
          let partChars = 0;
          for (const character of coarse) {
            const chars = estimateStringChars(character);
            if (partChars + chars > maxChars) {
              appendSegment(coarse.slice(partStart, partEnd), lineNo, partChars);
              partStart = partEnd;
              partChars = 0;
            }
            partEnd += character.length;
            partChars += chars;
          }
          appendSegment(coarse.slice(partStart), lineNo, partChars);
        } else {
          appendSegment(coarse, lineNo, coarseChars);
        }
        start += coarse.length;
      }
    }
  }
  flush();
  finishEntry(lines.length);
  return chunks;
}

/**
 * Remap chunk startLine/endLine from content-relative positions to original
 * source file positions using a lineMap.  Each entry in lineMap gives the
 * 1-indexed source line for the corresponding 0-indexed content line.
 *
 * This is used for session JSONL files where buildSessionEntry() flattens
 * messages into a plain-text string before chunking.  Without remapping the
 * stored line numbers would reference positions in the flattened text rather
 * than the original JSONL file.
 */
export function remapChunkLines(chunks: MemoryChunk[], lineMap: number[] | undefined): void {
  if (!lineMap || lineMap.length === 0) {
    return;
  }
  for (const chunk of chunks) {
    // startLine/endLine are 1-indexed; lineMap is 0-indexed by content line
    chunk.startLine = lineMap[chunk.startLine - 1] ?? chunk.startLine;
    chunk.endLine = lineMap[chunk.endLine - 1] ?? chunk.endLine;
  }
}
