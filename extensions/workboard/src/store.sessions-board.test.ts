import { copyFileSync, renameSync } from "node:fs";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { openNodeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import type { WorkboardSessionPlacementWrite } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

function placement(
  overrides: Partial<WorkboardSessionPlacementWrite> = {},
): WorkboardSessionPlacementWrite {
  return {
    sessionKey: "agent:main:example",
    columnId: "working",
    source: "operator",
    reason: "pinned",
    factsHash: "",
    updatedAt: 1000,
    ...overrides,
  };
}

async function sessionBoard(options: Parameters<typeof createWorkboardSqliteTestHarness>[0] = {}) {
  const harness = createWorkboardSqliteTestHarness(options);
  await harness.store.upsertBoard({ id: "sessions", kind: "sessions" });
  const board = await harness.store.getSessionsBoard("sessions");
  return {
    ...harness,
    board,
    pin: (patch: Partial<WorkboardSessionPlacementWrite> = {}, expectedSpec = board.sessions) =>
      harness.store.writeSessionPlacement("sessions", placement(patch), { expectedSpec }),
  };
}

function reopen(dbPath: string) {
  const stores = createKernelStores(dbPath);
  const store = new WorkboardStore(stores.cards, stores);
  return { store, stores, [Symbol.asyncDispose]: () => store.close() };
}

describe("Sessions board storage", () => {
  it("preserves card boards and makes the new board kind immutable", async () => {
    const store = createWorkboardSqliteTestStore();
    const cardBoard = await store.upsertBoard({ id: "cards", name: "Cards" });
    expect(cardBoard).not.toHaveProperty("kind");
    expect(cardBoard).not.toHaveProperty("sessions");
    await store.upsertBoard({ id: "sessions", kind: "sessions", name: "Sessions" });
    await expect(store.upsertBoard({ id: "sessions", kind: "cards" })).rejects.toThrow(
      "kind cannot be changed",
    );
    await store.create({ title: "Inferred namespace", boardId: "inferred" });
    for (const id of ["cards", "default", "inferred"]) {
      await expect(store.upsertBoard({ id, kind: "sessions" })).rejects.toThrow(
        "kind cannot be changed",
      );
    }
    await store.updateSessionsBoard("sessions", { scope: { maxAgeHours: 24 } });
    expect(await store.upsertBoard({ id: "sessions", name: "Renamed" })).toMatchObject({
      kind: "sessions",
      name: "Renamed",
      sessions: { scope: { maxAgeHours: 24 } },
    });
    expect(
      (await store.listBoards()).boards.find((entry) => entry.id === "sessions"),
    ).toMatchObject({
      kind: "sessions",
      sessions: { scope: { maxAgeHours: 24 } },
      total: 0,
    });
    expect(
      (await store.listBoards()).boards.find((entry) => entry.id === "cards"),
    ).not.toHaveProperty("kind");
  });

  it("rejects card create, capture, transfer, and dispatch without modifying cards", async () => {
    const { store, stores } = await sessionBoard();
    const card = await store.create({ title: "Existing", sessionKey: "agent:main:example" });
    for (const write of [
      () => store.create({ title: "Forbidden", boardId: "sessions" }),
      // The destination must be checked before reusing this card from another board.
      () =>
        store.captureSession({
          title: "Captured",
          boardId: "sessions",
          sessionKey: card.sessionKey,
        }),
      () => store.update(card.id, { boardId: "sessions" }),
      () => store.dispatch({ boardId: "sessions" }),
      () =>
        stores.cards.register(card.id, {
          version: 1,
          card: { ...card, metadata: { automation: { boardId: "sessions" } } },
        }),
    ]) {
      await expect(write()).rejects.toThrow("Sessions boards do not hold cards");
    }
    expect(await store.list()).toEqual([card]);
  });

  it("rejects stale pins after an operator move or spec change", async () => {
    const { store, pin } = await sessionBoard();
    const changes = vi.fn();
    store.onChange = changes;
    expect(await pin({ expectedUpdatedAt: 1000 })).toBe(false);
    expect(await pin()).toBe(true);
    expect(await pin()).toBe(false);
    expect(await pin({ columnId: "merged", expectedUpdatedAt: 1000 })).toBe(true);
    // Same-millisecond writes still advance the revision and fence delayed moves.
    expect(await store.listSessionPlacements("sessions")).toEqual([
      placement({ columnId: "merged", updatedAt: 1001 }),
    ]);
    expect(await pin({ expectedUpdatedAt: 1000 })).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    await store.updateSessionsBoard("sessions", { scope: { includeArchived: true } });
    expect(await pin({ expectedUpdatedAt: 1001 })).toBe(false);
    expect(await store.listSessionPlacements("sessions")).toEqual([
      placement({ columnId: "merged", updatedAt: 1001 }),
    ]);
    const current = await store.getSessionsBoard("sessions");
    await expect(pin({ columnId: "missing" }, current.sessions)).rejects.toThrow(
      "Unknown sessions board column",
    );
  });

  test("writes placements without a precondition SELECT", async () => {
    const { pin } = await sessionBoard({ createStores: createKernelStores });
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the native receiver below.
    const get = StatementSync.prototype.get;
    const reads: string[] = [];
    using spy = vi.spyOn(StatementSync.prototype, "get");
    spy.mockImplementation(function (this: StatementSync, ...params: Parameters<typeof get>) {
      reads.push(this.sourceSQL);
      return get.apply(this, params);
    });
    expect(await pin()).toBe(true);
    expect(await pin({ expectedUpdatedAt: 1000 })).toBe(true);
    expect(reads.filter((sql) => sql.includes("workboard_session_placements"))).toEqual([]);
  });

  // Injects legacy session placement data through a native SQLite file handle.
  test("normalizes retired instructions and repairs placements while preserving operator pins", async () => {
    const { store, dbPath, board, pin } = await sessionBoard({
      createStores: createKernelStores,
    });
    await pin();
    await store.close();
    {
      using legacy = new DatabaseSync(dbPath);
      const insert = legacy.prepare(
        "INSERT INTO workboard_session_placements VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      for (const source of ["state", "model"]) {
        insert.run("sessions", `agent:main:${source}`, "working", source, "old", "old-hash", 1000);
      }
      legacy
        .prepare("UPDATE workboard_boards SET sessions_spec = ? WHERE id = ?")
        .run(
          JSON.stringify({ ...board.sessions, instructions: "Retired instructions" }),
          "sessions",
        );
    }
    await using opened = reopen(dbPath);
    expect((await opened.store.getSessionsBoard("sessions")).sessions).toEqual(board.sessions);
    expect(await opened.store.repairSessionPlacements()).toEqual({ placements: 2, boards: 0 });
    expect(await opened.store.repairSessionPlacements()).toEqual({ placements: 0, boards: 0 });
    expect(await opened.store.listSessionPlacements("sessions")).toEqual([placement()]);
  });

  it("deletes only the sessions board and its placements", async () => {
    const { store, stores, pin } = await sessionBoard();
    await store.updateSessionsBoard("sessions", {
      agentSessionKey: "agent:main:board-agent",
    });
    const card = await store.create({ title: "Keep this card" });
    await pin({}, (await store.getSessionsBoard("sessions")).sessions);
    const sibling = await store.upsertBoard({ id: "sibling", kind: "sessions" });
    await store.writeSessionPlacement("sibling", placement(), { expectedSpec: sibling.sessions! });
    expect(await store.deleteBoard("sessions")).toEqual({ deleted: true });
    expect(await stores.sessionsBoard.listPlacements("sessions")).toEqual([]);
    await expect(store.getSessionsBoard("sessions")).rejects.toThrow("board not found");
    expect(await store.list()).toEqual([card]);
    expect(await store.listSessionPlacements("sibling")).toEqual([placement()]);
    const recreated = await store.upsertBoard({ id: "sessions", kind: "sessions" });
    expect(recreated.sessions?.agentSessionKey).toBeUndefined();
    expect(await store.listSessionPlacements("sessions")).toEqual([]);
  });

  it.each(["update", "write"] as const)(
    "rejects %s when caller authority ends before the worker write",
    async (action) => {
      const { store, stores, board } = await sessionBoard();
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Caller authority is no longer active.");
        }
      };
      const paused = async <T>(run: () => Promise<T>) => {
        entered.resolve();
        await release.promise;
        return run();
      };
      const update = stores.sessionsBoard.update.bind(stores.sessionsBoard);
      const write = stores.sessionsBoard.writePlacement.bind(stores.sessionsBoard);
      using updateSpy = vi.spyOn(stores.sessionsBoard, "update");
      updateSpy.mockImplementation((...args) => paused(() => update(...args)));
      using writeSpy = vi.spyOn(stores.sessionsBoard, "writePlacement");
      writeSpy.mockImplementation((...args) => paused(() => write(...args)));
      const pending =
        action === "update"
          ? store.updateSessionsBoard("sessions", { scope: { maxAgeHours: 1 } }, assertCurrent)
          : store.writeSessionPlacement("sessions", placement(), {
              expectedSpec: board.sessions,
              assertCurrent,
            });
      const rejected = expect(pending).rejects.toThrow("Caller authority is no longer active.");
      try {
        await entered.promise;
        active = false;
      } finally {
        release.resolve();
      }
      await rejected;
      expect(await store.getSessionsBoard("sessions")).toEqual(board);
      expect(await store.listSessionPlacements("sessions")).toEqual([]);
    },
  );
  // Rebuilds and reopens a prior-schema SQLite file.
  test("preserves prior-schema cards and admits a new Sessions board after reopening", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const board = await store.upsertBoard({ id: "planning", name: "Planning", color: "blue" });
    const card = await store.create({
      boardId: board.id,
      title: "Keep the existing card",
      notes: "Prior-schema content",
      labels: ["migration"],
    });
    await store.close();

    // Model the prior schema's first admission, rather than altering admitted format facts.
    renameSync(dbPath, `${dbPath}.seed`);
    copyFileSync(`${dbPath}.seed`, dbPath);
    {
      using prior = openNodeSqliteDatabase(dbPath);
      // These are the only schema additions for Sessions boards; preserve the existing migration receipt.
      prior.exec(`
        DROP TABLE workboard_session_placements;
        ALTER TABLE workboard_boards DROP COLUMN kind;
        ALTER TABLE workboard_boards DROP COLUMN sessions_spec;
      `);
    }

    await using opened = reopen(dbPath);
    const { store: reopened, stores } = opened;
    expect((await stores.boards.lookup(board.id))?.board).toEqual(board);
    expect((await reopened.listBoards()).boards).toContainEqual(
      expect.objectContaining({ id: board.id, total: 1 }),
    );
    expect(await reopened.get(card.id)).toEqual(card);

    await expect(
      reopened.upsertBoard({ id: "sessions", kind: "sessions", name: "Sessions" }),
    ).resolves.toMatchObject({ id: "sessions", kind: "sessions", name: "Sessions" });
    expect(await reopened.getSessionsBoard("sessions")).toMatchObject({
      id: "sessions",
      kind: "sessions",
      sessions: { columns: expect.any(Array) },
    });
    expect(await reopened.listSessionPlacements("sessions")).toEqual([]);
  });
});
