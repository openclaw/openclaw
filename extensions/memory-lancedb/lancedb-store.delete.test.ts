import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { beforeEach, describe, expect, test, vi } from "vitest";

const lanceMocks = vi.hoisted(() => ({
  countRows: vi.fn(async () => 1),
  deleteRows: vi.fn(),
  checkoutLatest: vi.fn(async () => undefined),
  schema: vi.fn(async () => ({ fields: [{ name: "agentId" }] })),
}));

vi.mock("./lancedb-runtime.js", () => ({
  loadLanceDbModule: vi.fn(async () => ({
    connect: vi.fn(async () => ({
      tableNames: vi.fn(async () => ["memories"]),
      openTable: vi.fn(async () => ({
        checkoutLatest: lanceMocks.checkoutLatest,
        schema: lanceMocks.schema,
        countRows: lanceMocks.countRows,
        delete: lanceMocks.deleteRows,
        close: vi.fn(),
      })),
      close: vi.fn(),
    })),
  })),
}));

import { MemoryDB } from "./lancedb-store.js";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("MemoryDB delete receipts", () => {
  test("uses LanceDB's deleted-row count as the authoritative receipt", async () => {
    const db = new MemoryDB("/unused", 3);
    const memoryId = "890e1fae-1234-4678-abcd-ef0123456789";
    lanceMocks.deleteRows
      .mockResolvedValueOnce({ numDeletedRows: 0, version: 1 })
      .mockResolvedValueOnce({ numDeletedRows: 1, version: 2 })
      .mockRejectedValueOnce(new Error("delete unavailable"));

    await expect(db.delete("main", memoryId)).resolves.toBe(false);
    await expect(db.delete("main", memoryId)).resolves.toBe(true);
    await expect(db.delete("main", memoryId)).rejects.toThrow("delete unavailable");
    expect(lanceMocks.countRows).not.toHaveBeenCalled();
    expect(lanceMocks.deleteRows).toHaveBeenCalledTimes(3);
    db.close();
  });

  test.each(["search", "count", "list", "query", "delete", "store"] as const)(
    "%s propagates a refresh failure before reading or changing stale data",
    async (operation) => {
      const db = new MemoryDB("/unused", 3);
      try {
        await db.count("main");
        lanceMocks.countRows.mockClear();
        lanceMocks.checkoutLatest.mockRejectedValueOnce(new Error("refresh unavailable"));
        const operations = {
          search: () => db.search("main", [1, 0, 0]),
          count: () => db.count("main"),
          list: () => db.list("main"),
          query: () => db.query("main", { columns: ["id"] }),
          delete: () => db.delete("main", "890e1fae-1234-4678-abcd-ef0123456789"),
          store: () =>
            db.store("main", {
              text: "new memory",
              vector: [1, 0, 0],
              importance: 0.5,
              category: "fact",
            }),
        };
        const result = operations[operation]();
        await expect(result).rejects.toThrow("refresh unavailable");
        expect(lanceMocks.countRows).not.toHaveBeenCalled();
        expect(lanceMocks.deleteRows).not.toHaveBeenCalled();
        await expect(db.count("main")).resolves.toBe(1);
      } finally {
        db.close();
      }
    },
  );

  test("pending initialization callers share one table opening without extra refresh", async () => {
    const schema = createDeferred<{ fields: { name: string }[] }>();
    lanceMocks.schema.mockReturnValueOnce(schema.promise);
    const db = new MemoryDB("/unused", 3);
    try {
      const first = db.count("main");
      const second = db.count("main");
      schema.resolve({ fields: [{ name: "agentId" }] });
      await expect(Promise.all([first, second])).resolves.toEqual([1, 1]);
      expect(lanceMocks.schema).toHaveBeenCalledTimes(2);
      expect(lanceMocks.checkoutLatest).not.toHaveBeenCalled();
      await expect(db.count("main")).resolves.toBe(1);
      expect(lanceMocks.checkoutLatest).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
