// Memory Core tests cover manager.vector dedupe plugin behavior.
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { replaceMemoryVectorRow } from "./manager-vector-write.js";

describe("memory vector dedupe", () => {
  let db: DatabaseSync | null = null;

  afterEach(() => {
    db?.close();
    db = null;
  });

  it("deletes existing vector rows before inserting replacements", () => {
    db = new DatabaseSync(":memory:");
<<<<<<< HEAD
    db.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
=======
    db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df

    replaceMemoryVectorRow({
      db,
      id: "chunk-1",
      embedding: [1, 0, 0],
    });

    db.exec(`
      CREATE TRIGGER fail_if_vector_row_not_deleted
<<<<<<< HEAD
      BEFORE INSERT ON memory_index_chunks_vec
      WHEN EXISTS (SELECT 1 FROM memory_index_chunks_vec WHERE id = NEW.id)
=======
      BEFORE INSERT ON chunks_vec
      WHEN EXISTS (SELECT 1 FROM chunks_vec WHERE id = NEW.id)
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      BEGIN
        SELECT RAISE(FAIL, 'vector row not deleted before insert');
      END;
    `);

    expect(
      replaceMemoryVectorRow({
        db,
        id: "chunk-1",
        embedding: [2, 0, 0],
      }),
    ).toBeUndefined();

    const row = db
<<<<<<< HEAD
      .prepare(
        "SELECT COUNT(*) as c, length(embedding) as bytes FROM memory_index_chunks_vec WHERE id = ?",
      )
=======
      .prepare("SELECT COUNT(*) as c, length(embedding) as bytes FROM chunks_vec WHERE id = ?")
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
      .get("chunk-1") as { c: number; bytes: number } | undefined;
    expect(row?.c).toBe(1);
    expect(row?.bytes).toBe(12);
  });
});
