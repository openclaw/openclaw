import { describe, expect, it } from "vitest";
import { WorkboardStore } from "./store.js";
import { createKernelStores } from "./test/sqlite-kernel.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

const columns = {
  visible: ["triage", "scheduled", "blocked", "done"],
  labels: { triage: "Todo", scheduled: "In progress", blocked: "Needs you" },
  emptyColumnMode: "show",
};

describe("Cards board columns", () => {
  it("persists columns across reopen and keeps them through upserts that omit them", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    expect(await store.upsertBoard({ id: "overview", name: "Overview", columns })).toMatchObject({
      columns,
    });
    expect(await store.upsertBoard({ id: "overview", name: "Renamed" })).toMatchObject({
      name: "Renamed",
      columns,
    });
    await store.create({ title: "Hidden status card", boardId: "overview", status: "review" });
    await store.close();

    const stores = createKernelStores(dbPath);
    const reopened = new WorkboardStore(stores.cards, stores);
    try {
      const board = (await reopened.listBoards()).boards.find((entry) => entry.id === "overview");
      expect(board).toMatchObject({ name: "Renamed", columns, byStatus: { review: 1 } });
      // Card status semantics are unchanged by presentation.
      expect((await reopened.list({ boardId: "overview" })).map((card) => card.status)).toEqual([
        "review",
      ]);
    } finally {
      await reopened.close();
    }
  });

  it("leaves boards without columns on the default presentation and resets with null", async () => {
    const store = createWorkboardSqliteTestStore();
    expect(await store.upsertBoard({ id: "plain", name: "Plain" })).not.toHaveProperty("columns");
    await store.upsertBoard({ id: "plain", columns: { visible: ["done", "todo"] } });
    expect(await store.upsertBoard({ id: "plain", columns: null })).not.toHaveProperty("columns");
    const board = (await store.listBoards()).boards.find((entry) => entry.id === "plain");
    expect(board).not.toHaveProperty("columns");
  });

  it.each([
    [{ visible: [] }, "columns.visible must list"],
    [{ visible: ["todo", "todo"] }, "columns.visible must list"],
    [{ visible: ["todo", "someday"] }, "columns.visible must list"],
    [{ visible: ["todo"], labels: { someday: "Later" } }, "unknown status: someday"],
    [{ visible: ["todo"], labels: { todo: " " } }, "must be 1-40 characters"],
    [{ visible: ["todo"], labels: { todo: "x".repeat(41) } }, "must be 1-40 characters"],
    [{ visible: ["todo"], emptyColumnMode: "fold" }, "show, collapse or hide"],
    ["todo", "must be an object"],
  ])("rejects invalid columns %j without changing the board", async (value, message) => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "overview", columns });
    await expect(store.upsertBoard({ id: "overview", columns: value })).rejects.toThrow(message);
    const board = (await store.listBoards()).boards.find((entry) => entry.id === "overview");
    expect(board?.columns).toEqual(columns);
  });

  it("rejects Cards columns on Sessions boards", async () => {
    const store = createWorkboardSqliteTestStore();
    await expect(
      store.upsertBoard({ id: "sessions", kind: "sessions", columns: { visible: ["todo"] } }),
    ).rejects.toThrow("columns apply only to Cards boards");
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    await expect(
      store.upsertBoard({ id: "sessions", columns: { visible: ["todo"] } }),
    ).rejects.toThrow("columns apply only to Cards boards");
    const board = await store.getSessionsBoard("sessions");
    expect(board).not.toHaveProperty("columns");
    expect(board.sessions.columns.length).toBeGreaterThan(1);
  });
});
