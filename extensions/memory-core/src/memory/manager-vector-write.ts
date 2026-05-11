import type { SQLInputValue } from "node:sqlite";
import {
  MEMORY_INDEX_TABLE_NAMES,
  serializeEmbedding,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";

type VectorWriteDb = {
  prepare: (sql: string) => {
    run: (...params: SQLInputValue[]) => unknown;
  };
};

const vectorToBlob = (embedding: number[]): Uint8Array => serializeEmbedding(embedding);

export function replaceMemoryVectorRow(params: {
  db: VectorWriteDb;
  id: string;
  embedding: number[];
  tableName?: string;
}): void {
  const tableName = params.tableName ?? MEMORY_INDEX_TABLE_NAMES.vector;
  try {
    params.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(params.id);
  } catch {}
  params.db
    .prepare(`INSERT INTO ${tableName} (id, embedding) VALUES (?, ?)`)
    .run(params.id, vectorToBlob(params.embedding));
}
