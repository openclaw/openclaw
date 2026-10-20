import {
  createMarkdownChunker,
  enforceEmbeddingMaxInputTokens,
  extractCuratedEntryRecallMetadata,
  type MemoryEntryProvenance,
} from "openclaw/plugin-sdk/memory-core-host-engine-indexing";
import type { WorkerTaskChannel, WorkerTaskControl } from "openclaw/plugin-sdk/worker-task-server";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import {
  resolveChunkProvenance,
  type MemoryIndexPreparationInput,
} from "./manager-index-preparation.js";

export type SessionIndexPreparation = Omit<
  MemoryIndexPreparationInput,
  "content" | "entry" | "cutoffLine"
> & {
  resetAtLine?: number;
  entry: Pick<MemoryIndexPreparationInput["entry"], "path" | "mtimeMs">;
};
export type SessionIndexLine = {
  text: string;
  lineNo: number;
  endOfLine: boolean;
  sourceLine: number;
  provenance?: MemoryEntryProvenance;
};
export type SessionIndexPage = { lines: SessionIndexLine[]; done: boolean };
export type SessionIndexProgress = { chunks: IndexedMemoryChunk[] };

/** Walk the immutable source without allocating an array for every transcript line. */
export function* sessionIndexPages(
  input: MemoryIndexPreparationInput,
): Generator<SessionIndexPage> {
  let offset = 0;
  let lineIndex = 0;
  let lines: SessionIndexLine[] = [];
  let bytes = 0;
  while (offset <= input.content.length) {
    const newline = input.content.indexOf("\n", offset);
    const lineEnd = newline < 0 ? input.content.length : newline;
    do {
      // Framing also bounds a single enormous message; chunking owns its text boundaries.
      const end = Math.min(lineEnd, offset + 16 * 1024);
      const text = input.content.slice(offset, end);
      lines.push({
        text,
        lineNo: lineIndex + 1,
        endOfLine: end === lineEnd,
        sourceLine: input.entry.lineMap?.[lineIndex] ?? lineIndex + 1,
        provenance: input.entry.lineProvenance?.[lineIndex],
      });
      bytes += text.length * 2 + 64;
      offset = end;
      if (lines.length >= 512 || bytes >= 64 * 1024) {
        yield { lines, done: false };
        lines = [];
        bytes = 0;
      }
    } while (offset < lineEnd);
    lineIndex++;
    offset = newline < 0 ? input.content.length + 1 : lineEnd + 1;
  }
  yield { lines, done: true };
}

/** Both directions are acknowledged: a bounded worker never retains the full expansion. */
export async function prepareSessionIndexStream(
  input: SessionIndexPreparation,
  channel: WorkerTaskChannel,
  control: WorkerTaskControl,
): Promise<void> {
  channel.consumeInput();
  let pending: IndexedMemoryChunk[] = [];
  let crossedReset = false;
  const facts = new Map<number, SessionIndexLine>();
  // resolveMemoryPathClassification always excludes sessions, even a path named MEMORY.md.
  const metadata = extractCuratedEntryRecallMetadata({
    curatedRoot: false,
    projectScopeEligible: false,
    sourceLines: [],
  });
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
  for (;;) {
    control.throwIfCancelled();
    const response = await channel.request({ chunks: pending } satisfies SessionIndexProgress);
    pending = [];
    // No source text from this private protocol enters diagnostics.
    // SAFETY: the paired host answers only with pages produced by sessionIndexPages.
    const page = response.input as SessionIndexPage;
    for (const line of page.lines) {
      control.throwIfCancelled();
      if (!crossedReset && line.lineNo === input.resetAtLine) {
        chunker.flush();
        crossedReset = true;
      }
      facts.set(line.lineNo, line);
      chunker.appendLine(line.text, line.lineNo, line.endOfLine);
    }
    response.consumed();
    if (page.done) {
      chunker.flush();
      const completed = await channel.request({ chunks: pending } satisfies SessionIndexProgress);
      completed.consumed();
      return;
    }
  }
}
