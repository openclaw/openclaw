import type { DatabaseSync } from "node:sqlite";
import { vectorToBlob } from "./vector-blob.js";

export function writeMemoryVectors(
  db: DatabaseSync,
  rows: readonly { id: string; embedding: number[] }[],
): void {
  if (rows.length === 0) {
    return;
  }
  // A repeated id within one publication has the same last-write-wins behavior.
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  // sqlite-vec only uses its primary-key lookup for scalar equality.
  const deletion = db.prepare("DELETE FROM memory_index_chunks_vec WHERE id = ?");
  for (const row of unique) {
    deletion.run(row.id);
  }
  db.prepare(
    `INSERT INTO memory_index_chunks_vec (id, embedding) VALUES ${unique.map(() => "(?, ?)").join(",")}`,
  ).run(...unique.flatMap((row) => [row.id, vectorToBlob(row.embedding)]));
}
