import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const lanceMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectClose: vi.fn(),
  tableClose: vi.fn(),
  tableNames: vi.fn(async () => ["memories"]),
  schema: vi.fn(async () => ({ fields: [{ name: "agentId" }] })),
  add: vi.fn(async () => undefined),
  deleteRows: vi.fn(async () => ({ numDeletedRows: 1 })),
}));

// mock-isolation: close lifecycle tests drive an artificial delayed connect or a gated add to deterministically race close against in-flight work; the real lancedb-runtime stays isolated so no actual database is opened.
vi.mock("./lancedb-runtime.js", () => ({
  loadLanceDbModule: vi.fn(async () => ({
    connect: lanceMocks.connect,
  })),
}));

import { MemoryDB } from "./lancedb-store.js";

function makeTableHandle() {
  return {
    checkoutLatest: vi.fn(async () => undefined),
    schema: lanceMocks.schema,
    add: lanceMocks.add,
    delete: lanceMocks.deleteRows,
    vectorSearch: () => ({
      where: () => ({ limit: () => ({ toArray: vi.fn(async () => []) }) }),
    }),
    query: () => ({
      where: () => ({ select: () => ({ toArray: vi.fn(async () => []) }) }),
    }),
    close: lanceMocks.tableClose,
  };
}

function makeDbHandle() {
  return {
    tableNames: lanceMocks.tableNames,
    openTable: vi.fn(async () => makeTableHandle()),
    createEmptyTable: vi.fn(async () => makeTableHandle()),
    close: lanceMocks.connectClose,
  };
}

let db: MemoryDB;
beforeEach(() => {
  vi.clearAllMocks();
  lanceMocks.connect.mockResolvedValue(makeDbHandle());
  db = new MemoryDB("/unused", 3);
});
afterEach(async () => {
  await db.close();
});

describe("MemoryDB close lifecycle is terminal", () => {
  test("initialization completing after close publishes no handle and releases it", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      return makeDbHandle();
    });

    const pending = db.store("alpha", {
      text: "racing entry",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });

    // Let the store reach the awaiting connect before closing.
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    // close() awaits the in-flight initialization; resolve the gate so the
    // initializer can observe the closed instance and reject its handle.
    const closing = db.close();
    gate.resolve();

    // The admitted store must not commit through a handle published after close.
    await expect(pending).rejects.toThrow(/closed/i);
    await closing;

    await vi.waitFor(() => expect(lanceMocks.connectClose).toHaveBeenCalled());
    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.add).not.toHaveBeenCalled();
  });

  test("admissions are rejected once close is pending and stay rejected until reopen", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      return makeDbHandle();
    });

    // A store admitted before close races the in-flight initialization.
    const pending = db.store("alpha", {
      text: "during close",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    const closing = db.close();

    // New admission while close is pending must be rejected outright — it must
    // not re-open the database while the service is stopped.
    await expect(
      db.store("beta", {
        text: "submitted while close pending",
        vector: [0, 1, 0],
        importance: 0.5,
        category: "fact",
      }),
    ).rejects.toThrow(/closed/i);

    gate.resolve();
    await expect(pending).rejects.toThrow(/closed/i);
    await closing;

    // Still rejected after close: reopening is explicit via service start.
    await expect(
      db.store("gamma", {
        text: "after close",
        vector: [0, 0, 1],
        importance: 0.5,
        category: "fact",
      }),
    ).rejects.toThrow(/closed/i);
    expect(lanceMocks.add).not.toHaveBeenCalled();
  });

  test("reopen restores admissions on a fresh lifecycle and close still cleans up", async () => {
    await db.close();

    // Without reopen the store is closed; after reopen a new lifecycle opens.
    await expect(
      db.store("alpha", {
        text: "still closed",
        vector: [1, 0, 0],
        importance: 0.5,
        category: "fact",
      }),
    ).rejects.toThrow(/closed/i);

    db.reopen();
    await db.store("alpha", {
      text: "after reopen",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    expect(lanceMocks.connectClose).not.toHaveBeenCalled();

    await db.close();
    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
  });

  test("close drains an admitted table operation before releasing handles", async () => {
    const addGate = createDeferred<void>();
    lanceMocks.add.mockImplementationOnce(async () => {
      await addGate.promise;
    });

    // An explicit store is admitted and its add is now in flight on a real handle.
    const admitted = db.store("alpha", {
      text: "in-flight add",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await vi.waitFor(() => expect(lanceMocks.add).toHaveBeenCalled());

    // close() must wait for the admitted add to settle before releasing handles.
    const closing = db.close();

    // While the add is still pending, close must remain unsettled and the
    // native handles must stay open (drain blocks cleanup, not a no-op).
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(lanceMocks.connectClose).not.toHaveBeenCalled();
    expect(lanceMocks.tableClose).not.toHaveBeenCalled();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(closed).toBe(false);

    addGate.resolve();
    await expect(admitted).resolves.toMatchObject({ text: "in-flight add" });
    await closing;
    expect(closed).toBe(true);

    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
  });

  test("concurrent close calls share one lifecycle and close handles once", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      return makeDbHandle();
    });

    const pending = db.store("alpha", {
      text: "concurrent race",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    const closeA = db.close();
    const closeB = db.close();
    const closeC = db.close();
    gate.resolve();

    await expect(pending).rejects.toThrow(/closed/i);
    await Promise.all([closeA, closeB, closeC]);

    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(1);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(1);
  });

  test("close swallows an in-flight initialization failure and still settles", async () => {
    const gate = createDeferred<void>();
    lanceMocks.connect.mockImplementationOnce(async () => {
      await gate.promise;
      throw new Error("native connect failed");
    });

    const pending = db.store("alpha", {
      text: "failing init",
      vector: [1, 0, 0],
      importance: 0.5,
      category: "fact",
    });
    await vi.waitFor(() => expect(lanceMocks.connect).toHaveBeenCalled());

    // close() awaits the in-flight init; the gated rejection lands while close
    // is pending so the rejection-handling branch is exercised, not a
    // pre-cleared initPromise.
    const closing = db.close();
    gate.reject(new Error("native connect failed"));

    await expect(pending).rejects.toThrow("native connect failed");
    await expect(closing).resolves.toBeUndefined();
  });

  test("repeated close/reopen cycles keep the store usable across generations", async () => {
    for (let cycle = 0; cycle < 3; cycle += 1) {
      lanceMocks.connect.mockResolvedValue(makeDbHandle());
      await db.store("alpha", {
        text: `cycle ${cycle}`,
        vector: [1, 0, 0],
        importance: 0.5,
        category: "fact",
      });
      await db.close();
      db.reopen();
    }
    expect(lanceMocks.connectClose).toHaveBeenCalledTimes(3);
    expect(lanceMocks.tableClose).toHaveBeenCalledTimes(3);
  });
});
