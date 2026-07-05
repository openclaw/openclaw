// Memory Core plugin module implements manager vector write behavior.
import type { SQLInputValue } from "node:sqlite";
<<<<<<< HEAD
import { vectorToBlob } from "./vector-blob.js";
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

type VectorWriteDb = {
  prepare: (sql: string) => {
    run: (...params: SQLInputValue[]) => unknown;
  };
};

<<<<<<< HEAD
=======
const vectorToBlob = (embedding: number[]): Buffer =>
  Buffer.from(new Float32Array(embedding).buffer);

>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
export function replaceMemoryVectorRow(params: {
  db: VectorWriteDb;
  id: string;
  embedding: number[];
  tableName?: string;
}): void {
<<<<<<< HEAD
  const tableName = params.tableName ?? "memory_index_chunks_vec";
=======
  const tableName = params.tableName ?? "chunks_vec";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  try {
    params.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(params.id);
  } catch {}
  params.db
    .prepare(`INSERT INTO ${tableName} (id, embedding) VALUES (?, ?)`)
    .run(params.id, vectorToBlob(params.embedding));
}
