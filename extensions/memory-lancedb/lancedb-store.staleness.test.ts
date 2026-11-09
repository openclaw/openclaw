import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { MemoryDB, type MemoryEntry } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

describe("MemoryDB observes externally committed rows", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-staleness-" });

  let reader: MemoryDB;
  let writer: MemoryDB;
  beforeEach(() => {
    reader = new MemoryDB(getDbPath(), 2);
    writer = new MemoryDB(getDbPath(), 2);
  });
  afterEach(() => Promise.all([reader.close(), writer.close()]));
  const entry = (
    text: string,
    vector = [1, 0],
    importance = 0.5,
    category: MemoryEntry["category"] = "preference",
  ) => ({ text, vector, importance, category });

  test.each(["search", "list", "query", "delete"] as const)(
    "%s observes a commit before any other reader operation refreshes the handle",
    async (operation) => {
      await expect(reader.list("alpha")).resolves.toEqual([]);
      const external = await writer.store(
        "alpha",
        entry("committed by another writer", [1, 0], 0.5, "other"),
      );
      switch (operation) {
        case "search":
          await expect(reader.search("alpha", [1, 0], 5, 0)).resolves.toMatchObject([
            { entry: { id: external.id, text: external.text } },
          ]);
          break;
        case "list":
          await expect(reader.list("alpha", 5)).resolves.toMatchObject([{ id: external.id }]);
          break;
        case "query":
          await expect(reader.query("alpha", { columns: ["id", "text"] })).resolves.toMatchObject([
            { id: external.id, text: external.text },
          ]);
          break;
        case "delete":
          await expect(reader.delete("alpha", external.id)).resolves.toBe(true);
          await writer.close();
          writer.start();
          await expect(writer.list("alpha")).resolves.toEqual([]);
      }
    },
  );

  test("refreshing preserves agent scope before ranking and observes later commits", async () => {
    await expect(reader.list("alpha")).resolves.toEqual([]);
    await writer.store("beta", entry("beta private preference", [1, 0], 0.9));
    const local = await writer.store("alpha", entry("alpha preference", [0.8, 0.2]));
    await expect(reader.search("alpha", [1, 0], 1, 0)).resolves.toMatchObject([
      { entry: { id: local.id } },
    ]);
    await expect(reader.list("beta")).resolves.toHaveLength(1);
    await writer.store("alpha", entry("later alpha fact", [0, 1], 0.5, "fact"));
    await expect(reader.list("alpha")).resolves.toHaveLength(2);
  });
});
