import * as lancedb from "@lancedb/lancedb";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

const entry = (text: string) => ({
  text,
  vector: [1, 0],
  importance: 0.8,
  category: "preference" as const,
});
const alphaText = "alpha private preference";
const betaText = "beta private preference";
const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-scope-" });

describe("MemoryDB agent isolation", () => {
  let db: MemoryDB;
  beforeEach(() => {
    db = new MemoryDB(getDbPath(), 2);
  });
  afterEach(() => db.close());

  test("cancels a timed-out native search and keeps the table usable", async () => {
    const stored = await db.store("alpha", entry(alphaText));

    await expect(db.search("alpha", [1, 0], 5, 0, { timeoutMs: 0 })).rejects.toThrow(
      "Query timeout",
    );
    await expect(db.search("alpha", [1, 0], 5, 0, { timeoutMs: 5_000 })).resolves.toMatchObject([
      { entry: { id: stored.id, text: alphaText } },
    ]);
  });

  test("scopes store, search, list, query, delete, and restart reads", async () => {
    const alpha = await db.store("alpha", entry(alphaText));
    await db.store("beta", entry(betaText));

    await expect(db.search("alpha", [1, 0], 5, 0)).resolves.toMatchObject([
      { entry: { id: alpha.id, text: alphaText } },
    ]);
    await expect(db.list("beta")).resolves.toMatchObject([{ text: betaText }]);
    await expect(
      db.query("alpha", {
        columns: ["id", "text"],
        filter: { column: "category", operator: "=", value: "preference" },
      }),
    ).resolves.toMatchObject([{ id: alpha.id, text: alphaText }]);

    await expect(db.delete("beta", alpha.id)).resolves.toBe(false);
    await expect(db.list("alpha")).resolves.toMatchObject([{ id: alpha.id }]);
    db.close();

    db = new MemoryDB(getDbPath(), 2);
    await expect(db.list("alpha")).resolves.toMatchObject([{ id: alpha.id, text: alphaText }]);
    await expect(db.list("beta")).resolves.toMatchObject([{ text: betaText }]);
  });

  test("rejects search when a persisted table is reopened with a different vector dimension", async () => {
    await db.store("main", entry("fixed-size vector"));
    db.close();

    db = new MemoryDB(getDbPath(), 3);
    await expect(db.search("main", [1, 0, 0], 5, 0)).rejects.toThrow(
      "No vector column found to match with the query vector dimension: 3",
    );
  });

  test("refuses an unscoped legacy table until doctor migrates it", async () => {
    const connection = await lancedb.connect(getDbPath());
    const table = await connection.createTable("memories", [
      { ...entry("legacy"), id: "legacy", createdAt: 1 },
    ]);
    table.close();
    connection.close();

    await expect(db.list("main")).rejects.toThrow(
      'Run "openclaw doctor --fix" to assign legacy rows to the default agent',
    );
    await expect(db.list("main")).rejects.toThrow(
      'Run "openclaw doctor --fix" to assign legacy rows to the default agent',
    );
  });
});
