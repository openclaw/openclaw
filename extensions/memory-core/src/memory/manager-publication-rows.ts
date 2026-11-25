import type {
  MemoryEmbeddingCacheEntry,
  MemoryPublicationFragment,
} from "./manager-publication-task.js";
import type { MemorySourceIndexRow } from "./manager-source-index-kernel.js";

type PublicationRow = MemorySourceIndexRow | MemoryEmbeddingCacheEntry;

/** Sealed rows of one staged source or cache write; an unsealed tail waits for its next fragment. */
export type StagedPublication = {
  rows: Array<{ row: PublicationRow; vector?: Float64Array }>;
  tail: MemoryPublicationFragment[];
};

export function* readPublicationRows<Row extends PublicationRow>(
  fragments: Iterable<MemoryPublicationFragment>,
): Generator<Row> {
  // SAFETY: Only the paired source/cache producer writes these sealed records.
  const parse = (parts: string[]) => JSON.parse(parts.join("")) as Row;
  let parts: string[] = [];
  for (const fragment of fragments) {
    parts.push(fragment.json);
    if (fragment.last) {
      yield parse(parts);
      parts = [];
    }
  }
  if (parts.length) {
    yield parse(parts);
  }
}

export function stagePublicationRows(
  stage: StagedPublication,
  fragments: readonly MemoryPublicationFragment[],
): void {
  const pending = [...stage.tail, ...fragments];
  const sealed = pending.findLastIndex((fragment) => fragment.last) + 1;
  for (const row of readPublicationRows<PublicationRow>(pending.slice(0, sealed))) {
    // Vectors stay binary64, their stored encoding, not ~20 JSON characters per dimension.
    stage.rows.push(
      "embedding" in row &&
        row.embedding.length > 0 &&
        row.embedding.every((value) => typeof value === "number")
        ? { row: { ...row, embedding: [] }, vector: Float64Array.from(row.embedding) }
        : { row },
    );
  }
  stage.tail = pending.slice(sealed);
}

export function* readStagedRows<Row extends PublicationRow>(
  stage: StagedPublication,
): Generator<Row> {
  for (const { row, vector } of stage.rows) {
    // SAFETY: stage.start pairs each staged kind with its producer's row type.
    yield (vector ? { ...row, embedding: Array.from(vector) } : row) as Row;
  }
  yield* readPublicationRows<Row>(stage.tail);
}
