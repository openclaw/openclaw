import { DatabaseSync } from "node:sqlite";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { WorkboardSessionPlacementWrite } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
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

describe("Sessions board storage", () => {
  it("preserves card boards and makes the new board kind immutable", async () => {
    const store = createWorkboardSqliteTestStore();
    const cardBoard = await store.upsertBoard({ id: "cards", name: "Cards" });
    expect(cardBoard).not.toHaveProperty("kind");
    expect(cardBoard).not.toHaveProperty("sessions");
    const board = await store.upsertBoard({ id: "sessions", kind: "sessions", name: "Sessions" });
    expect(board.sessions?.columns.map((column) => column.id)).toEqual([
      "needs-input",
      "stuck",
      "working",
      "in-review",
      "merged",
      "done",
    ]);
    await expect(store.upsertBoard({ id: "sessions", kind: "cards" })).rejects.toThrow(
      "kind cannot be changed",
    );
    await expect(store.upsertBoard({ id: "cards", kind: "sessions" })).rejects.toThrow(
      "kind cannot be changed",
    );
    await expect(store.upsertBoard({ id: "default", kind: "sessions" })).rejects.toThrow(
      "kind cannot be changed",
    );
    await store.create({ title: "Inferred namespace", boardId: "inferred" });
    await expect(store.upsertBoard({ id: "inferred", kind: "sessions" })).rejects.toThrow(
      "kind cannot be changed",
    );
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
    const { store, stores } = createWorkboardSqliteTestHarness();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const card = await store.create({ title: "Existing", sessionKey: "agent:main:example" });
    await expect(store.create({ title: "Forbidden", boardId: "sessions" })).rejects.toThrow(
      "Sessions boards do not hold cards",
    );
    // Capture must reject the requested destination even when it can reuse an existing card elsewhere.
    await expect(
      store.captureSession({ title: "Captured", boardId: "sessions", sessionKey: card.sessionKey }),
    ).rejects.toThrow("Sessions boards do not hold cards");
    await expect(store.update(card.id, { boardId: "sessions" })).rejects.toThrow(
      "Sessions boards do not hold cards",
    );
    await expect(store.dispatch({ boardId: "sessions" })).rejects.toThrow(
      "Sessions boards do not hold cards",
    );
    // The worker guard also protects callers below the public store facade.
    await expect(
      stores.cards.register(card.id, {
        version: 1,
        card: { ...card, metadata: { automation: { boardId: "sessions" } } },
      }),
    ).rejects.toThrow("Sessions boards do not hold cards");
    expect(await store.list()).toEqual([card]);
  });

  it("rejects stale pins after an operator move or spec change", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const { sessions: expectedSpec } = await store.getSessionsBoard("sessions");
    const changes = vi.fn();
    store.subscribeChanges(changes);
    expect(await store.writeSessionPlacement("sessions", placement(), { expectedSpec })).toBe(true);
    expect(
      await store.writeSessionPlacement(
        "sessions",
        placement({ columnId: "merged", expectedUpdatedAt: 1000 }),
        { expectedSpec },
      ),
    ).toBe(true);
    // Same-millisecond writes still advance the revision and fence delayed moves.
    expect(await store.listSessionPlacements("sessions")).toEqual([
      placement({ columnId: "merged", updatedAt: 1001 }),
    ]);
    expect(
      await store.writeSessionPlacement("sessions", placement({ expectedUpdatedAt: 1000 }), {
        expectedSpec,
      }),
    ).toBe(false);
    expect(changes).toHaveBeenCalledTimes(2);
    await store.updateSessionsBoard("sessions", { scope: { includeArchived: true } });
    expect(
      await store.writeSessionPlacement("sessions", placement({ expectedUpdatedAt: 1001 }), {
        expectedSpec,
      }),
    ).toBe(false);
    expect(await store.listSessionPlacements("sessions")).toEqual([
      placement({ columnId: "merged", updatedAt: 1001 }),
    ]);
    const current = await store.getSessionsBoard("sessions");
    await expect(
      store.writeSessionPlacement("sessions", placement({ columnId: "missing" }), {
        expectedSpec: current.sessions,
      }),
    ).rejects.toThrow("Unknown sessions board column");
  });

  it("normalizes retired instructions and repairs placements while preserving operator pins", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const board = await store.upsertBoard({ id: "sessions", kind: "sessions" });
    await store.writeSessionPlacement("sessions", placement(), { expectedSpec: board.sessions! });
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
    const stores = createKernelStores(dbPath);
    const reopened = new WorkboardStore(stores.cards, stores);
    try {
      expect((await reopened.getSessionsBoard("sessions")).sessions).toEqual(board.sessions);
      expect(await reopened.repairSessionPlacements()).toEqual({ placements: 2, boards: 0 });
      expect(await reopened.repairSessionPlacements()).toEqual({ placements: 0, boards: 0 });
      expect(await reopened.listSessionPlacements("sessions")).toEqual([placement()]);
    } finally {
      await reopened.close();
    }
  });

  it("deletes only the sessions board and its placements", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const board = await store.updateSessionsBoard("sessions", {
      agentSessionKey: "agent:main:board-agent",
    });
    const card = await store.create({ title: "Keep this card" });
    await store.writeSessionPlacement("sessions", placement(), { expectedSpec: board.sessions });
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
      const { store, stores } = createWorkboardSqliteTestHarness();
      await store.upsertBoard({ id: "sessions", kind: "sessions" });
      const board = await store.getSessionsBoard("sessions");
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      let active = true;
      const assertCurrent = () => {
        if (!active) {
          throw new Error("Caller authority is no longer active.");
        }
      };
      const pause = async () => {
        entered.resolve();
        await release.promise;
      };
      const update = stores.sessionsBoard.update.bind(stores.sessionsBoard);
      const write = stores.sessionsBoard.writePlacement.bind(stores.sessionsBoard);
      using updateSpy = vi.spyOn(stores.sessionsBoard, "update");
      updateSpy.mockImplementation(async (...args) => {
        await pause();
        return update(...args);
      });
      using writeSpy = vi.spyOn(stores.sessionsBoard, "writePlacement");
      writeSpy.mockImplementation(async (...args) => {
        await pause();
        return write(...args);
      });
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
});

describe("Sessions board schema reopening", () => {
  it("preserves prior-schema cards and admits a new Sessions board through the Gateway method", async () => {
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

    {
      using prior = new DatabaseSync(dbPath);
      // These are the only schema additions for Sessions boards; preserve the existing migration receipt.
      prior.exec(`
        DROP TABLE workboard_session_placements;
        ALTER TABLE workboard_boards DROP COLUMN kind;
        ALTER TABLE workboard_boards DROP COLUMN sessions_spec;
      `);
    }

    const reopenedStores = createKernelStores(dbPath);
    const reopened = new WorkboardStore(reopenedStores.cards, reopenedStores);
    try {
      expect((await reopenedStores.boards.lookup(board.id))?.board).toEqual(board);
      const restoredBoard = (await reopened.listBoards()).boards.find(
        (entry) => entry.id === board.id,
      );
      expect(restoredBoard).toMatchObject({
        id: board.id,
        name: "Planning",
        color: "blue",
        total: 1,
      });
      expect(restoredBoard).not.toHaveProperty("kind");
      expect(restoredBoard).not.toHaveProperty("sessions");
      expect(await reopened.get(card.id)).toEqual(card);

      const registerGatewayMethod = vi.fn<OpenClawPluginApi["registerGatewayMethod"]>();
      const api = createTestPluginApi({ registerGatewayMethod });
      registerWorkboardGatewayMethods({ api, store: reopened });
      const upsert = registerGatewayMethod.mock.calls.find(
        ([method]) => method === "workboard.boards.upsert",
      )![1];
      const respond = vi.fn();
      await upsert({
        params: { id: "sessions", kind: "sessions", name: "Sessions" },
        respond,
      } as never);
      expect(respond).toHaveBeenCalledWith(true, {
        board: expect.objectContaining({ id: "sessions", kind: "sessions", name: "Sessions" }),
      });
      expect(await reopened.getSessionsBoard("sessions")).toMatchObject({
        id: "sessions",
        kind: "sessions",
        sessions: { columns: expect.any(Array) },
      });
      expect(await reopened.listSessionPlacements("sessions")).toEqual([]);
    } finally {
      await reopened.close();
    }

    using migrated = new DatabaseSync(dbPath, { readOnly: true });
    expect(
      migrated.prepare("SELECT COUNT(*) AS count FROM workboard_session_placements").get(),
    ).toEqual({
      count: 0,
    });
  });
});
