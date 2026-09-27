import type { SQLInputValue } from "node:sqlite";
import { vectorToBlob } from "./vector-blob.js";

type VectorWriteDb = {
  prepare: (sql: string) => {
    run: (...params: SQLInputValue[]) => unknown;
  };
};

export function createMemoryVectorWriter(db: VectorWriteDb, tableName = "memory_index_chunks_vec") {
  let deleteStatement: ReturnType<VectorWriteDb["prepare"]> | undefined;
  let insertStatement: ReturnType<VectorWriteDb["prepare"]> | undefined;

  // One replacement owns the statements. A failed DELETE must not prevent INSERT.
  return (id: string, embedding: number[]): void => {
    try {
      (deleteStatement ??= db.prepare(`DELETE FROM ${tableName} WHERE id = ?`)).run(id);
    } catch {}
    (insertStatement ??= db.prepare(`INSERT INTO ${tableName} (id, embedding) VALUES (?, ?)`)).run(
      id,
      vectorToBlob(embedding),
    );
  };
}
