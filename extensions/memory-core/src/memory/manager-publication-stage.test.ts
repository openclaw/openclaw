import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { MemoryPublicationStage } from "./manager-publication-stage.js";

const tempTables = (db: DatabaseSync) =>
  db.prepare("SELECT name FROM temp.sqlite_schema WHERE type = 'table'").all();

describe("memory publication stage", () => {
  it("keeps small sources in memory and moves large ones to a dropped TEMP table", () => {
    const db = new DatabaseSync(":memory:");
    const small = new MemoryPublicationStage(db);
    small.append([{ json: "{}", last: true }]);
    expect([...small.read()]).toEqual([{ json: "{}", last: true }]);
    expect(tempTables(db)).toEqual([]);
    small.close();

    const large = new MemoryPublicationStage(db);
    const chunk = "x".repeat(1024 * 1024);
    const fragments = Array.from({ length: 20 }, (_, index) => ({
      json: `${index}${chunk}`,
      last: index % 2 === 1,
    }));
    large.append(fragments);
    large.append([{ json: "tail", last: true }]);
    expect(tempTables(db)).toHaveLength(1);
    expect([...large.read()]).toEqual([...fragments, { json: "tail", last: true }]);
    large.close();
    expect(tempTables(db)).toEqual([]);
    db.close();
  });
});
