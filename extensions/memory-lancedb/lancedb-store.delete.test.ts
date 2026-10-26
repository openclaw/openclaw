import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installTmpDirHarness } from "./test-helpers.js";

const lanceMocks = vi.hoisted(() => ({
  countRows: vi.fn(async () => 1),
  queryRows: vi.fn(async () => [{ id: "known" }]),
  deleteRows: vi.fn(),
  checkoutLatest: vi.fn(async () => undefined),
  schema: vi.fn(async () => ({ fields: [{ name: "agentId" }] })),
}));

vi.mock("./lancedb-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./lancedb-runtime.js")>()),
  loadLanceDbModule: vi.fn(async () => ({
    connect: vi.fn(async () => ({
      tableNames: async () => ["memories"],
      openTable: async () => ({
        checkoutLatest: lanceMocks.checkoutLatest,
        schema: lanceMocks.schema,
        countRows: lanceMocks.countRows,
        query: () => ({
          where: () => ({ select: () => ({ toArray: lanceMocks.queryRows }) }),
        }),
        delete: lanceMocks.deleteRows,
        close() {},
      }),
      close() {},
    })),
  })),
}));

import { MemoryDB } from "./lancedb-store.js";

let db: MemoryDB;
const { getDbPath } = installTmpDirHarness({ prefix: "openclaw-memory-lifetime-" });
const memoryId = "890e1fae-1234-4678-abcd-ef0123456789";
const query = () => db.query("main", { columns: ["id"] });
const entry = { text: "new", vector: [1, 0, 0], importance: 0.5, category: "fact" as const };
const knownRows = [{ id: "known" }];
beforeEach(() => {
  vi.clearAllMocks();
  db = new MemoryDB(getDbPath(), 3);
});
afterEach(() => db.close());

test("propagates native delete failures", async () => {
  lanceMocks.deleteRows.mockRejectedValueOnce(new Error("delete unavailable"));
  await expect(db.delete("main", memoryId)).rejects.toThrow("delete unavailable");
  expect(lanceMocks.countRows).not.toHaveBeenCalled();
});

test.each([
  ["search", () => db.search("main", [1, 0, 0])],
  ["query", query],
  ["delete", () => db.delete("main", memoryId)],
  ["store", () => db.store("main", entry)],
] as const)("%s rejects stale access and recovers", async (_name, run) => {
  await query();
  lanceMocks.queryRows.mockClear();
  lanceMocks.checkoutLatest.mockRejectedValueOnce(new Error("refresh unavailable"));
  await expect(run()).rejects.toThrow("refresh unavailable");
  expect(lanceMocks.queryRows).not.toHaveBeenCalled();
  expect(lanceMocks.deleteRows).not.toHaveBeenCalled();
  await expect(query()).resolves.toEqual(knownRows);
});

test("pending initialization callers share one table opening without extra refresh", async () => {
  const schema = createDeferred<{ fields: { name: string }[] }>();
  lanceMocks.schema.mockReturnValueOnce(schema.promise);
  const first = query();
  const second = query();
  schema.resolve({ fields: [{ name: "agentId" }] });
  await expect(Promise.all([first, second])).resolves.toEqual([knownRows, knownRows]);
  expect(lanceMocks.schema).toHaveBeenCalledTimes(1);
  expect(lanceMocks.checkoutLatest).not.toHaveBeenCalled();
  await expect(query()).resolves.toEqual(knownRows);
  expect(lanceMocks.checkoutLatest).toHaveBeenCalledTimes(1);
});

test("close retains custody until an accepted native query settles", async () => {
  const started = createDeferred<void>();
  const rows = createDeferred<Array<{ id: string }>>();
  lanceMocks.queryRows.mockImplementationOnce(() => {
    started.resolve();
    return rows.promise;
  });
  const reading = query();
  await started.promise;
  const closing = db.close();
  const maintenance = new MemoryDB(getDbPath(), 3);
  try {
    await expect(maintenance.optimize()).rejects.toThrow(/in use/);
  } finally {
    rows.resolve(knownRows);
    await reading;
    await closing;
    await expect(query()).rejects.toThrow(/closed/);
    await maintenance.close();
  }
});
