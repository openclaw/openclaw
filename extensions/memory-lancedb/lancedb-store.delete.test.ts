import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { installTmpDirHarness } from "./test-helpers.js";

const lanceMocks = vi.hoisted(() => ({
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
const knownRows = [{ id: "known" }];
beforeEach(() => {
  vi.clearAllMocks();
  db = new MemoryDB(getDbPath(), 3);
});
afterEach(() => db.close());

test.each(["refresh", "delete"] as const)("propagates %s failures and recovers", async (phase) => {
  await query();
  lanceMocks.queryRows.mockClear();
  const operation = phase === "refresh" ? lanceMocks.checkoutLatest : lanceMocks.deleteRows;
  operation.mockRejectedValueOnce(new Error("unavailable"));
  await expect(db.delete("main", memoryId)).rejects.toThrow("unavailable");
  if (phase === "refresh") {
    expect(lanceMocks.deleteRows).not.toHaveBeenCalled();
  }
  await expect(query()).resolves.toEqual(knownRows);
});

test("shared initialization and close retain custody until admitted reads settle", async () => {
  const schema = createDeferred<{ fields: { name: string }[] }>();
  lanceMocks.schema.mockReturnValueOnce(schema.promise);
  const started = createDeferred<void>();
  const rows = createDeferred<Array<{ id: string }>>();
  lanceMocks.queryRows.mockImplementationOnce(() => {
    started.resolve();
    return rows.promise;
  });
  const reading = [query(), query()];
  schema.resolve({ fields: [{ name: "agentId" }] });
  await started.promise;
  expect(lanceMocks.schema).toHaveBeenCalledTimes(1);
  expect(lanceMocks.checkoutLatest).not.toHaveBeenCalled();
  const closing = db.close();
  const maintenance = new MemoryDB(getDbPath(), 3);
  try {
    await expect(maintenance.optimize()).rejects.toThrow(/in use/);
  } finally {
    rows.resolve(knownRows);
    await expect(Promise.all(reading)).resolves.toEqual([knownRows, knownRows]);
    await closing;
    await expect(query()).rejects.toThrow(/closed/);
    await maintenance.close();
  }
});
