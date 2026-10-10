import type { DatabaseSync, StatementSync } from "node:sqlite";
import { vectorToBlob } from "./vector-blob.js";

export function createMemoryVectorWriter(db: DatabaseSync) {
  const tableName = "memory_index_chunks_vec";
  let deleteStatement: StatementSync | undefined;
  let insertStatement: StatementSync | undefined;

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
