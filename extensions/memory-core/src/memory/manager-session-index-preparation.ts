import {
  createMarkdownChunker,
  enforceEmbeddingMaxInputTokens,
  extractCuratedEntryRecallMetadata,
  type MemoryEntryProvenance,
} from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import type { SessionEntryPage } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import type { WorkerTaskChannel, WorkerTaskControl } from "openclaw/plugin-sdk/worker-task-server";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import {
  resolveChunkProvenance,
  type MemoryIndexPreparationInput,
} from "./manager-index-preparation.js";

export type SessionIndexPreparation = Omit<
  MemoryIndexPreparationInput,
  "content" | "entry" | "source"
> & {
  entry: Pick<MemoryIndexPreparationInput["entry"], "path" | "mtimeMs">;
};
type SessionIndexLine = {
  text: string;
  lineNo: number;
  endOfLine: boolean;
  sourceLine: number;
  provenance?: MemoryEntryProvenance;
};
/** A `reset` page discards every earlier line: the export restarted at line 1. */
export type SessionIndexPage = { lines: SessionIndexLine[]; done: boolean; reset?: boolean };
export type SessionIndexProgress = { chunks: IndexedMemoryChunk[] };

/** Frame one export page for the index worker; framing also bounds a single enormous line. */
export function sessionIndexPages(page: SessionEntryPage): SessionIndexPage[] {
  const pages: SessionIndexPage[] = [];
  let lines: SessionIndexLine[] = [];
  let bytes = 0;
  for (const [index, line] of page.lines.entries()) {
    let offset = 0;
    do {
      // Chunking owns text boundaries; this only bounds each worker message.
      const end = Math.min(line.length, offset + 16 * 1024);
      const text = line.slice(offset, end);
      lines.push({
        text,
        lineNo: page.startLine + index + 1,
        endOfLine: end === line.length,
        sourceLine: page.lineMap[index] ?? page.startLine + index + 1,
        provenance: page.lineProvenance[index],
      });
      bytes += text.length * 2 + 64;
      offset = end;
      if (lines.length >= 512 || bytes >= 64 * 1024) {
        pages.push({ lines, done: false });
        lines = [];
        bytes = 0;
      }
    } while (offset < line.length);
  }
  if (lines.length > 0) {
    pages.push({ lines, done: false });
  }
  return pages;
}

/** Both directions are acknowledged: a bounded worker never retains the full expansion. */
export async function prepareSessionIndexStream(
  input: SessionIndexPreparation,
  channel: WorkerTaskChannel,
  control: WorkerTaskControl,
): Promise<void> {
  channel.consumeInput();
  // resolveMemoryPathClassification always excludes sessions, even a path named MEMORY.md.
  const metadata = extractCuratedEntryRecallMetadata({
    curatedRoot: false,
    projectScopeEligible: false,
    sourceLines: [],
  });
  const start = () => {
    const facts = new Map<number, SessionIndexLine>();
    const pending: IndexedMemoryChunk[] = [];
    const chunker = createMarkdownChunker(input.chunking, (chunk) => {
      const provenance: MemoryEntryProvenance[] = [];
      for (const [number, fact] of facts) {
        if (number < chunk.startLine) {
          facts.delete(number);
        } else if (number <= chunk.endLine && fact.provenance) {
          provenance.push(fact.provenance);
        }
      }
      if (!chunk.text.trim()) {
        return;
      }
      chunk.provenance = resolveChunkProvenance(
        { mtimeMs: input.entry.mtimeMs, lineProvenance: provenance },
        "sessions",
        { ...chunk, startLine: 1, endLine: provenance.length },
        input.pathClassification.originClass,
      );
      // Provider fragments inherit the original chunk's full provenance and citation span.
      chunk.startLine = facts.get(chunk.startLine)?.sourceLine ?? chunk.startLine;
      chunk.endLine = facts.get(chunk.endLine)?.sourceLine ?? chunk.endLine;
      for (const fragment of input.provider
        ? enforceEmbeddingMaxInputTokens(input.provider, [chunk], input.hardMaxInputTokens)
        : [chunk]) {
        delete fragment.embeddingInput;
        pending.push(Object.assign(fragment, metadata));
      }
    });
    return { facts, pending, chunker, crossedReset: false };
  };
  let state = start();
  for (;;) {
    control.throwIfCancelled();
    const response = await channel.request({
      chunks: state.pending.splice(0),
    } satisfies SessionIndexProgress);
    // No source text from this private protocol enters diagnostics.
    // SAFETY: the paired host answers only with pages produced by sessionIndexPages.
    const page = response.input as SessionIndexPage;
    if (page.reset) {
      state = start();
    }
    for (const line of page.lines) {
      control.throwIfCancelled();
      // The reset generation starts a chunk at the first line it owns, unless that is line 1.
      if (
        !state.crossedReset &&
        input.cutoffLine !== undefined &&
        line.sourceLine >= input.cutoffLine
      ) {
        if (line.lineNo > 1) {
          state.chunker.flush();
        }
        state.crossedReset = true;
      }
      state.facts.set(line.lineNo, line);
      state.chunker.appendLine(line.text, line.lineNo, line.endOfLine);
    }
    response.consumed();
    if (page.done) {
      state.chunker.flush();
      const completed = await channel.request({
        chunks: state.pending.splice(0),
      } satisfies SessionIndexProgress);
      completed.consumed();
      return;
    }
  }
}
