// Memory Core tests cover manager.vector dedupe plugin behavior.
import { endianness } from "node:os";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMemoryVectorWriter } from "./manager-vector-write.js";

function vectorHex(values: number[]): string {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, endianness() === "LE"));
  return Buffer.from(view.buffer).toString("hex").toUpperCase();
}

describe("memory vector dedupe", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
    db.exec(`
      CREATE TRIGGER fail_if_vector_row_not_deleted
      BEFORE INSERT ON memory_index_chunks_vec
      WHEN EXISTS (SELECT 1 FROM memory_index_chunks_vec WHERE id = NEW.id)
      BEGIN
        SELECT RAISE(FAIL, 'vector row not deleted before insert');
      END;
    `);
  });

  afterEach(() => {
    db.close();
  });

  const rows = () =>
    db
      .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
      .all();

  it("deletes existing vector rows and binds each replacement independently", () => {
    const write = createMemoryVectorWriter(db);
    write("chunk-1", [1, 0, 0]);
    write("chunk-2", [-0, 0.5, -1.25]);
    expect(write("chunk-1", [2, -3, 0.125])).toBeUndefined();
    expect(rows()).toEqual([
      { id: "chunk-1", embedding: vectorHex([2, -3, 0.125]) },
      { id: "chunk-2", embedding: vectorHex([-0, 0.5, -1.25]) },
    ]);
  });

  it("still inserts after DELETE preparation fails and retries that DELETE on reuse", () => {
    const write = createMemoryVectorWriter(db);
    let denied = false;
    db.setAuthorizer((action, table) => {
      if (!denied && action === constants.SQLITE_DELETE && table === "memory_index_chunks_vec") {
        denied = true;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    try {
      write("chunk-1", [1, 0, 0]);
      expect(denied).toBe(true);
      expect(rows()).toEqual([{ id: "chunk-1", embedding: vectorHex([1, 0, 0]) }]);
      write("chunk-1", [0, 2, -0.5]);
      expect(rows()).toEqual([{ id: "chunk-1", embedding: vectorHex([0, 2, -0.5]) }]);
    } finally {
      db.setAuthorizer(null);
    }
  });

  it("attempts INSERT after a DELETE step failure and reuses the writer after recovery", () => {
    const write = createMemoryVectorWriter(db);
    write("chunk-1", [1, 0, 0]);
    db.exec(`
      CREATE TABLE delete_attempts (id TEXT);
      CREATE TRIGGER fail_vector_delete
      BEFORE DELETE ON memory_index_chunks_vec
      BEGIN
        INSERT INTO delete_attempts VALUES (OLD.id);
        SELECT RAISE(FAIL, 'delete-step');
      END;
    `);
    expect(() => write("chunk-1", [0, 1, 0])).toThrow("vector row not deleted before insert");
    expect(db.prepare("SELECT id FROM delete_attempts").all()).toEqual([{ id: "chunk-1" }]);
    expect(rows()).toEqual([{ id: "chunk-1", embedding: vectorHex([1, 0, 0]) }]);
    db.exec("DROP TRIGGER fail_vector_delete");
    write("chunk-1", [0, 1, 0]);
    expect(rows()).toEqual([{ id: "chunk-1", embedding: vectorHex([0, 1, 0]) }]);
  });

  it("propagates INSERT failure after deletion without retaining stale bindings", () => {
    const write = createMemoryVectorWriter(db);
    write("chunk-1", [1, 0, 0]);
    db.exec(`
      CREATE TRIGGER refuse_vector_insert
      BEFORE INSERT ON memory_index_chunks_vec
      WHEN NEW.id = 'chunk-1'
      BEGIN
        SELECT RAISE(FAIL, 'insert refused');
      END;
    `);
    expect(() => write("chunk-1", [0, 1, 0])).toThrow("insert refused");
    expect(rows()).toEqual([]);
    write("chunk-2", [0.25, -2, 3]);
    expect(rows()).toEqual([{ id: "chunk-2", embedding: vectorHex([0.25, -2, 3]) }]);
  });
});
