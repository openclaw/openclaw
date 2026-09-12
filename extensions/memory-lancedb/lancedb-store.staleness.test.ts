import { describe, expect, test } from "vitest";
import { MemoryDB } from "./lancedb-store.js";
import { installTmpDirHarness } from "./test-helpers.js";

describe("MemoryDB observes externally committed rows", () => {
  const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-staleness-" });

  test.each(["search", "count", "list", "query", "delete"] as const)(
    "%s observes a commit before any other reader operation refreshes the handle",
    async (operation) => {
      const reader = new MemoryDB(getDbPath(), 2);
      const writer = new MemoryDB(getDbPath(), 2);
      try {
        await expect(reader.count("alpha")).resolves.toBe(0);
        const external = await writer.store("alpha", {
          text: "committed by another writer",
          vector: [1, 0],
          importance: 0.5,
          category: "other",
        });
        switch (operation) {
          case "search":
            await expect(reader.search("alpha", [1, 0], 5, 0)).resolves.toMatchObject([
              { entry: { id: external.id, text: external.text } },
            ]);
            break;
          case "count":
            await expect(reader.count("alpha")).resolves.toBe(1);
            break;
          case "list":
            await expect(reader.list("alpha", 5)).resolves.toMatchObject([{ id: external.id }]);
            break;
          case "query":
            await expect(reader.query("alpha", { columns: ["id", "text"] })).resolves.toMatchObject(
              [{ id: external.id, text: external.text }],
            );
            break;
          case "delete":
            await expect(reader.delete("alpha", external.id)).resolves.toBe(true);
            writer.close();
            await expect(writer.count("alpha")).resolves.toBe(0);
        }
      } finally {
        reader.close();
        writer.close();
      }
    },
  );

  test("refreshing preserves agent scope before ranking and observes later commits", async () => {
    const reader = new MemoryDB(getDbPath(), 2);
    const writer = new MemoryDB(getDbPath(), 2);
    try {
      await expect(reader.count("alpha")).resolves.toBe(0);
      await writer.store("beta", {
        text: "beta private preference",
        vector: [1, 0],
        importance: 0.9,
        category: "preference",
      });
      const local = await writer.store("alpha", {
        text: "alpha preference",
        vector: [0.8, 0.2],
        importance: 0.5,
        category: "preference",
      });
      await expect(reader.search("alpha", [1, 0], 1, 0)).resolves.toMatchObject([
        { entry: { id: local.id } },
      ]);
      await expect(reader.count("beta")).resolves.toBe(1);
      await writer.store("alpha", {
        text: "later alpha fact",
        vector: [0, 1],
        importance: 0.5,
        category: "fact",
      });
      await expect(reader.count("alpha")).resolves.toBe(2);
    } finally {
      reader.close();
      writer.close();
    }
  });
});
