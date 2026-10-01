import type { WorkboardSessionPlacement } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

function placement(overrides: Partial<WorkboardSessionPlacement> = {}): WorkboardSessionPlacement {
  return {
    sessionKey: "agent:main:example",
    columnId: "working",
    source: "state",
    reason: "active",
    factsHash: "facts-1",
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
      "working",
      "stuck",
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
    await store.updateSessionsBoard("sessions", { instructions: "Sort by urgency." });
    expect(await store.upsertBoard({ id: "sessions", name: "Renamed" })).toMatchObject({
      kind: "sessions",
      name: "Renamed",
      sessions: { instructions: "Sort by urgency." },
    });
    expect(
      (await store.listBoards()).boards.find((entry) => entry.id === "sessions"),
    ).toMatchObject({
      kind: "sessions",
      sessions: { instructions: "Sort by urgency." },
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

  it("validates full column replacements and keeps rejected patches out of durable state", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const original = await store.getSessionsBoard("sessions");
    for (const patch of [
      { columns: [] },
      { columns: [original.sessions.columns[0]] },
      {
        columns: Array.from({ length: 13 }, (_, index) => ({
          id: `column-${index}`,
          label: "Column",
          description: "Description",
          fallback: index === 0,
        })),
      },
      { columns: original.sessions.columns.map((column) => ({ ...column, id: "duplicate" })) },
      { columns: original.sessions.columns.map((column) => ({ ...column, fallback: false })) },
      { columns: original.sessions.columns.map((column) => ({ ...column, fallback: true })) },
      { columns: original.sessions.columns.map((column) => ({ ...column, label: "" })) },
      {
        columns: original.sessions.columns.map((column) => ({
          ...column,
          description: "x".repeat(401),
        })),
      },
      { columns: original.sessions.columns.map((column) => ({ ...column, color: "chartreuse" })) },
      {
        columns: original.sessions.columns.map((column) => ({
          ...column,
          match: { run: ["running"] },
        })),
      },
      { instructions: "x".repeat(2001) },
      { scope: { maxAgeHours: -1 } },
      { scope: { includeArchived: "yes" } },
      { scope: { agentIds: [""] } },
      { kind: "cards" },
    ]) {
      await expect(store.updateSessionsBoard("sessions", patch)).rejects.toThrow();
    }
    expect(await store.getSessionsBoard("sessions")).toEqual(original);
    const updated = await store.updateSessionsBoard("sessions", {
      columns: [
        {
          id: "attention",
          label: "Attention",
          description: "Needs a person.",
          match: { health: ["waiting-on-user"], archived: false },
        },
        {
          id: "other",
          label: "Everything else",
          description: "Remaining sessions.",
          fallback: true,
        },
      ],
      instructions: "Keep related sessions together.",
      scope: { agentIds: ["main"], includeArchived: true, maxAgeHours: 24 },
      agentSessionKey: "agent:main:board-agent",
    });
    expect(updated.sessions.columns.map((column) => column.id)).toEqual(["attention", "other"]);
    expect(updated.sessions.scope).toEqual({
      agentIds: ["main"],
      includeArchived: true,
      maxAgeHours: 24,
    });
    await store.upsertBoard({ id: "cards" });
    await expect(store.updateSessionsBoard("cards", { instructions: "invalid" })).rejects.toThrow(
      "not a Sessions board",
    );
  });

  it("atomically rejects stale model batches after operator moves or spec changes", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const { sessions: expectedSpec } = await store.getSessionsBoard("sessions");
    const changes = vi.fn();
    store.subscribeChanges(changes);
    expect(await store.writeSessionPlacements("sessions", [placement()], { expectedSpec })).toBe(
      true,
    );
    expect(
      await store.writeSessionPlacements(
        "sessions",
        [
          {
            ...placement({ columnId: "merged", source: "operator", reason: "pinned" }),
            expectedUpdatedAt: 1000,
          },
        ],
        { expectedSpec },
      ),
    ).toBe(true);
    // The worker advances same-millisecond writes, so a delayed read cannot overwrite a pin.
    expect(await store.listSessionPlacements("sessions")).toEqual([
      placement({ columnId: "merged", source: "operator", reason: "pinned", updatedAt: 1001 }),
    ]);
    expect(
      await store.writeSessionPlacements(
        "sessions",
        [
          placement({ sessionKey: "agent:main:new" }),
          { ...placement({ source: "model" }), expectedUpdatedAt: 1000 },
        ],
        { expectedSpec },
      ),
    ).toBe(false);
    expect(await store.listSessionPlacements("sessions")).toHaveLength(1);
    expect(changes).toHaveBeenCalledTimes(2);
    await store.updateSessionsBoard("sessions", { instructions: "Prioritize review." });
    expect(
      await store.writeSessionPlacements(
        "sessions",
        [placement({ sessionKey: "agent:main:new" })],
        { expectedSpec },
      ),
    ).toBe(false);
    expect(await store.listSessionPlacements("sessions")).toHaveLength(1);
    const current = await store.getSessionsBoard("sessions");
    await expect(
      store.writeSessionPlacements("sessions", [placement({ columnId: "missing" })], {
        expectedSpec: current.sessions,
      }),
    ).rejects.toThrow("Unknown sessions board column");
  });

  it("deletes only the sessions board and its placements", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const board = await store.updateSessionsBoard("sessions", {
      agentSessionKey: "agent:main:board-agent",
    });
    const card = await store.create({ title: "Keep this card" });
    await store.writeSessionPlacements("sessions", [placement()], { expectedSpec: board.sessions });
    expect(await store.deleteBoard("sessions")).toEqual({ deleted: true });
    expect(await stores.sessionsBoard.listPlacements("sessions")).toEqual([]);
    await expect(store.getSessionsBoard("sessions")).rejects.toThrow("board not found");
    expect(await store.list()).toEqual([card]);
  });

  it("rechecks classifier authority at the worker write boundary", async () => {
    const store = createWorkboardSqliteTestStore();
    await store.upsertBoard({ id: "sessions", kind: "sessions" });
    const board = await store.getSessionsBoard("sessions");
    await expect(
      store.writeSessionPlacements("sessions", [placement()], {
        expectedSpec: board.sessions,
        assertCurrent: () => {
          throw new Error("classifier owner retired");
        },
      }),
    ).rejects.toThrow("classifier owner retired");
    expect(await store.listSessionPlacements("sessions")).toEqual([]);
  });
});
