import { endianness } from "node:os";
import { constants, DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeMemoryVectors } from "./manager-search-knn.test-support.js";

function vectorHex(values: number[]): string {
  const view = new DataView(new ArrayBuffer(values.length * 4));
  values.forEach((value, index) => view.setFloat32(index * 4, value, endianness() === "LE"));
  return Buffer.from(view.buffer).toString("hex").toUpperCase();
}

describe("memory vector dedupe", () => {
  let db: DatabaseSync;
  const trigger = (name: string, event: "INSERT" | "DELETE", body: string, when = "") =>
    db.exec(`CREATE TRIGGER ${name} BEFORE ${event} ON memory_index_chunks_vec
      ${when} BEGIN ${body} END;`);

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE memory_index_chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");
    trigger(
      "fail_if_vector_row_not_deleted",
      "INSERT",
      "SELECT RAISE(FAIL, 'vector row not deleted before insert');",
      "WHEN EXISTS (SELECT 1 FROM memory_index_chunks_vec WHERE id = NEW.id)",
    );
  });

  afterEach(() => db.close());

  const rows = () =>
    db
      .prepare("SELECT id, hex(embedding) AS embedding FROM memory_index_chunks_vec ORDER BY id")
      .all();
  const write = (id: string, embedding: number[]) => writeMemoryVectors(db, [{ id, embedding }]);
  const expectVectors = (...entries: [string, number[]][]) =>
    expect(rows()).toEqual(entries.map(([id, values]) => ({ id, embedding: vectorHex(values) })));

  it("deletes existing vector rows and binds each replacement independently", () => {
    write("chunk-1", [1, 0, 0]);
    write("chunk-2", [-0, 0.5, -1.25]);
    expect(write("chunk-1", [2, -3, 0.125])).toBeUndefined();
    expectVectors(["chunk-1", [2, -3, 0.125]], ["chunk-2", [-0, 0.5, -1.25]]);
  });

  it("replaces a batch and keeps the final embedding for a repeated id", () => {
    write("chunk-1", [1, 0, 0]);
    writeMemoryVectors(db, [
      { id: "chunk-1", embedding: [0, 1, 0] },
      { id: "chunk-2", embedding: [0, 0, 1] },
      { id: "chunk-1", embedding: [-1, 0, 0] },
    ]);
    expectVectors(["chunk-1", [-1, 0, 0]], ["chunk-2", [0, 0, 1]]);
  });

  it("propagates DELETE preparation failure and permits a later retry", () => {
    let denied = false;
    db.setAuthorizer((action, table) => {
      if (!denied && action === constants.SQLITE_DELETE && table === "memory_index_chunks_vec") {
        denied = true;
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    });
    expect(() => write("chunk-1", [1, 0, 0])).toThrow(/not authorized/);
    expect(denied).toBe(true);
    expectVectors();
    write("chunk-1", [0, 2, -0.5]);
    expectVectors(["chunk-1", [0, 2, -0.5]]);
  });

  it.each(["DELETE", "INSERT"] as const)("recovers after a %s step failure", (event) => {
    const deleting = event === "DELETE";
    write("chunk-1", [1, 0, 0]);
    if (deleting) {
      db.exec("CREATE TABLE delete_attempts (id TEXT)");
    }
    trigger(
      "refuse_write",
      event,
      `${deleting ? "INSERT INTO delete_attempts VALUES (OLD.id);" : ""} SELECT RAISE(FAIL, 'write refused');`,
      deleting ? "" : "WHEN NEW.id = 'chunk-1'",
    );
    expect(() => write("chunk-1", [0, 1, 0])).toThrow("write refused");
    if (deleting) {
      expect(db.prepare("SELECT id FROM delete_attempts").all()).toEqual([{ id: "chunk-1" }]);
      expectVectors(["chunk-1", [1, 0, 0]]);
      db.exec("DROP TRIGGER refuse_write");
    } else {
      expectVectors();
    }
    const id = deleting ? "chunk-1" : "chunk-2";
    const embedding = deleting ? [0, 1, 0] : [0.25, -2, 3];
    write(id, embedding);
    expectVectors([id, embedding]);
  });
});
