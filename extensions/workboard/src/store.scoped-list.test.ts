import { DatabaseSync, StatementSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

function observeReads(onRows: (sql: string, rows: Record<string, unknown>[]) => void) {
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain native methods for the same receiver.
  const all = StatementSync.prototype.all;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain native methods for the same receiver.
  const get = StatementSync.prototype.get;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Retain native methods for the same receiver.
  const iterate = StatementSync.prototype.iterate;
  const allSpy = vi.spyOn(StatementSync.prototype, "all").mockImplementation(function (
    this: StatementSync,
    ...params: Parameters<typeof all>
  ) {
    const rows = all.apply(this, params);
    onRows(this.sourceSQL, rows);
    return rows;
  });
  const getSpy = vi.spyOn(StatementSync.prototype, "get").mockImplementation(function (
    this: StatementSync,
    ...params: Parameters<typeof get>
  ) {
    const row = get.apply(this, params);
    onRows(this.sourceSQL, row ? [row] : []);
    return row;
  });
  const iterateSpy = vi.spyOn(StatementSync.prototype, "iterate").mockImplementation(function (
    this: StatementSync,
    ...params: Parameters<typeof iterate>
  ) {
    const rows = Array.from(iterate.apply(this, params));
    onRows(this.sourceSQL, rows);
    return rows.values();
  });
  return () => {
    allSpy.mockRestore();
    getSpy.mockRestore();
    iterateSpy.mockRestore();
  };
}

describe("Workboard board-scoped SQLite hydration", () => {
  it("reads only the requested board while preserving complete cards and order", async () => {
    const { store } = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
    const later = await store.create({ title: "Later", boardId: "ops", labels: ["one", "two"] });
    await store.addComment(later.id, { body: "Retain this comment" });
    const earlier = await store.create({ title: "Earlier", boardId: "ops", position: 0 });
    const other = await store.create({ title: "Other board", boardId: "product" });
    await store.addComment(other.id, { body: "Unrelated payload" });
    await store.create({ title: "Default board" });
    const expected = [await store.get(earlier.id), await store.get(later.id)];
    let fetchedRows = 0;
    let queries = 0;
    const restore = observeReads((sql, rows) => {
      if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
        queries++;
        fetchedRows += rows.length;
      }
    });
    try {
      await expect(store.list({ boardId: " OPS " })).resolves.toEqual(expected);
    } finally {
      restore();
    }
    // Two card rows, their three events, two labels and one comment.
    expect(fetchedRows).toBeGreaterThan(0);
    expect(fetchedRows).toBeLessThanOrEqual(8);
    expect(queries).toBeGreaterThan(0);
    expect(queries).toBeLessThanOrEqual(13);
    await expect(store.list({ boardId: "missing" })).resolves.toEqual([]);
    await expect(store.list({ boardId: "default" })).resolves.toEqual([
      expect.objectContaining({ title: "Default board" }),
    ]);
    await expect(store.list()).resolves.toHaveLength(4);
  });

  it("isolates unrelated corruption while retaining requested-board and full-list errors", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const selected = await store.create({ title: "Selected", boardId: "ops" });
    const unrelated = await store.create({ title: "Unrelated", boardId: "other" });
    await store.addComment(unrelated.id, { body: "Valid before corruption" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?")
        .run(unrelated.id);
      await expect(store.list({ boardId: "ops" })).resolves.toEqual([selected]);
      await expect(store.list({ boardId: "missing" })).resolves.toEqual([]);
      await expect(store.list({ boardId: "other" })).rejects.toThrow("missing body");
      await expect(store.list()).rejects.toThrow("missing body");
      raw
        .prepare("UPDATE workboard_card_comments SET body = 'Repaired' WHERE card_id = ?")
        .run(unrelated.id);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(unrelated.id);
      await expect(store.list({ boardId: "ops" })).resolves.toEqual([selected]);
      await expect(store.list({ boardId: "other" })).rejects.toThrow(SyntaxError);
      await expect(store.list()).rejects.toThrow(SyntaxError);
    } finally {
      raw.close();
    }
  });

  it("hydrates captured card IDs even if another connection moves the card after selection", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const created = await store.create({ title: "Moving card", boardId: "ops", labels: ["keep"] });
    const expected = await store.addComment(created.id, { body: "Keep across the move" });
    const raw = new DatabaseSync(dbPath);
    let moved = false;
    const restore = observeReads((sql) => {
      if (!moved && /^select\b.*\bfrom "?workboard_cards"?(?:\s|$)/iu.test(sql)) {
        moved = true;
        raw
          .prepare("UPDATE workboard_cards SET board_id = ?, automation_json = ? WHERE id = ?")
          .run(
            "other",
            JSON.stringify({ ...expected.metadata?.automation, boardId: "other" }),
            expected.id,
          );
      }
    });
    try {
      await expect(store.list({ boardId: "ops" })).resolves.toEqual([expected]);
      expect(moved).toBe(true);
    } finally {
      restore();
      raw.close();
    }
    await expect(store.list({ boardId: "ops" })).resolves.toEqual([]);
    await expect(store.list({ boardId: "other" })).resolves.toEqual([
      {
        ...expected,
        metadata: {
          ...expected.metadata,
          automation: { ...expected.metadata?.automation, boardId: "other" },
        },
      },
    ]);
  });
});

describe("Workboard card-scoped notification reads", () => {
  it("bounds fetched rows and preserves card scope, missing cards, and cursor advancement", async () => {
    const { store } = createWorkboardSqliteTestHarness({ createStores: createKernelStores });
    const selected = await store.create({
      title: "Selected notifications",
      boardId: "ops",
      sessionKey: "session-1",
      runId: "run-1",
      metadata: {
        notifications: [
          { id: "later", kind: "completed", createdAt: 101, sequence: 101000, message: "Later" },
          {
            id: "earlier",
            kind: "completed",
            createdAt: 100,
            sequence: 100000,
            message: "Earlier",
          },
        ],
      },
    });
    const other = await store.create({
      title: "Unrelated",
      boardId: "ops",
      metadata: {
        notifications: [
          { id: "unrelated", kind: "completed", createdAt: 99, message: "Unrelated" },
        ],
      },
    });
    await store.addComment(other.id, { body: "Unrelated payload" });
    await store.create({ title: "Another board", boardId: "other" });
    const subscription = await store.subscribeNotifications({
      cardId: selected.id,
      boardId: "other",
      sessionKey: "session-1",
      runId: "run-1",
      eventKinds: ["completed"],
    });
    let fetchedRows = 0;
    const restore = observeReads((sql, rows) => {
      if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
        fetchedRows += rows.length;
      }
    });
    try {
      await expect(
        store.notificationEvents({ subscriptionId: subscription.id, cardId: other.id, limit: 1 }),
      ).resolves.toMatchObject({ events: [{ id: "earlier" }] });
    } finally {
      restore();
    }
    expect(fetchedRows).toBeGreaterThan(0);
    expect(
      fetchedRows,
      "card notification reads must not hydrate unrelated cards",
    ).toBeLessThanOrEqual(5);
    await expect(store.notificationEvents({ cardId: ` ${selected.id} ` })).resolves.toMatchObject({
      events: [{ id: "earlier" }, { id: "later" }],
    });
    await expect(store.notificationEvents({ cardId: "missing" })).resolves.toEqual({ events: [] });
    await expect(
      store.advanceNotificationEvents({ subscriptionId: subscription.id, limit: 1 }),
    ).resolves.toMatchObject({ events: [{ id: "earlier" }] });
    await expect(
      store.advanceNotificationEvents({ subscriptionId: subscription.id, limit: 1 }),
    ).resolves.toMatchObject({ events: [{ id: "later" }] });
    await expect(
      store.notificationEvents({ subscriptionId: subscription.id }),
    ).resolves.toMatchObject({ events: [] });
  });

  it("isolates unrelated card corruption while retaining selected-card and board-wide failures", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const selected = await store.create({
      title: "Selected",
      boardId: "ops",
      metadata: {
        notifications: [
          { id: "selected-event", kind: "completed", createdAt: 100, message: "Done" },
        ],
      },
    });
    const other = await store.create({ title: "Unrelated", boardId: "ops" });
    await store.addComment(other.id, { body: "Valid before corruption" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw.prepare("UPDATE workboard_card_comments SET body = '' WHERE card_id = ?").run(other.id);
      await expect(store.notificationEvents({ cardId: selected.id })).resolves.toMatchObject({
        events: [{ id: "selected-event" }],
      });
      await expect(store.notificationEvents({ cardId: "missing" })).resolves.toEqual({
        events: [],
      });
      await expect(store.notificationEvents({ cardId: other.id })).rejects.toThrow("missing body");
      await expect(store.notificationEvents({ boardId: "ops" })).rejects.toThrow("missing body");
      await expect(store.notificationEvents()).rejects.toThrow("missing body");
      raw
        .prepare("UPDATE workboard_card_comments SET body = 'Repaired' WHERE card_id = ?")
        .run(other.id);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(selected.id);
      await expect(store.notificationEvents({ cardId: selected.id })).rejects.toThrow(SyntaxError);
    } finally {
      raw.close();
    }
  });
});

describe("Workboard dependency status reads", () => {
  it("prepares a card with fifty parents without hydrating each parent's tree", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness({
      createStores: createKernelStores,
    });
    const parents = [];
    for (let index = 0; index < 50; index++) {
      parents.push(
        await store.create({
          title: `Parent ${index}`,
          status: "done",
          notes: "Parent payload".repeat(100),
        }),
      );
    }
    const child = await store.create({ title: "Ready child", status: "ready" });
    const linked = {
      ...child,
      metadata: {
        ...child.metadata,
        links: parents.map((parent, index) => ({
          id: `parent-${index}`,
          type: "parent" as const,
          targetCardId: parent.id,
          createdAt: 1,
        })),
      },
    };
    await stores.cards.register(child.id, { version: 1, card: linked });
    const expected = await store.get(child.id);
    let queries = 0;
    let fetchedRows = 0;
    const restore = observeReads((sql, rows) => {
      if (/^select\b/iu.test(sql) && /\bfrom "?workboard_/iu.test(sql)) {
        queries++;
        fetchedRows += rows.length;
      }
    });
    try {
      await expect(store.prepareStart(child.id)).resolves.toEqual(expected);
    } finally {
      restore();
    }
    expect(queries).toBeLessThanOrEqual(14);
    expect(fetchedRows).toBeLessThanOrEqual(102);
    expect(queries).toBeGreaterThan(0);
    expect(fetchedRows).toBeGreaterThan(0);
  });

  it("checks dependency statuses without decoding unrelated cards or parent payloads", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const parent = await store.create({ title: "Done parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    const unrelated = await store.create({ title: "Unrelated", boardId: "other" });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id IN (?, ?)")
        .run(parent.id, unrelated.id);
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({
        id: child.id,
        status: "ready",
      });
      await expect(store.move(child.id, "done", child.position)).resolves.toMatchObject({
        id: child.id,
        status: "done",
      });
      await expect(store.get(parent.id)).rejects.toThrow(SyntaxError);
      await expect(store.get(unrelated.id)).rejects.toThrow(SyntaxError);
      await expect(store.list()).rejects.toThrow(SyntaxError);
      raw
        .prepare("UPDATE workboard_cards SET automation_json = '{invalid' WHERE id = ?")
        .run(child.id);
      await expect(store.prepareStart(child.id)).rejects.toThrow(SyntaxError);
    } finally {
      raw.close();
    }
  });

  it.each([false, true])(
    "preserves repeated parent IDs and lookup trimming (spaced: %s)",
    async (spaced) => {
      const { store, stores } = createWorkboardSqliteTestHarness();
      const parent = await store.create({ title: "Done parent", status: "done" });
      const child = await store.create({ title: "Ready child", status: "ready" });
      await stores.cards.register(child.id, {
        version: 1,
        card: {
          ...child,
          metadata: {
            ...child.metadata,
            links: [parent.id, spaced ? ` ${parent.id} ` : parent.id].map(
              (targetCardId, index) => ({
                id: `parent-${index}`,
                type: "parent",
                targetCardId,
                createdAt: 1,
              }),
            ),
          },
        },
      });
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({
        id: child.id,
        status: "ready",
      });
      if (spaced) {
        await expect(store.move(child.id, "done", child.position)).rejects.toThrow(
          "card dependencies are not done.",
        );
      } else {
        await expect(store.move(child.id, "done", child.position)).resolves.toMatchObject({
          status: "done",
        });
      }
    },
  );

  it("retains missing, unknown and invalid parent status holds", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
    const parent = await store.create({ title: "Parent", status: "done" });
    const child = await store.create({ title: "Child", parents: [parent.id] });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare("UPDATE workboard_cards SET status = 'future-status' WHERE id = ?")
        .run(parent.id);
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({ status: "todo" });
      await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(
        "card dependencies are not done.",
      );
      raw.prepare("UPDATE workboard_cards SET status = '' WHERE id = ?").run(parent.id);
      await expect(store.prepareStart(child.id)).rejects.toThrow(
        "workboard sqlite row missing status",
      );
      await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(
        "workboard sqlite row missing status",
      );
      await stores.cards.delete(parent.id);
      await expect(store.prepareStart(child.id)).resolves.toMatchObject({ status: "todo" });
      await expect(store.move(child.id, "ready", child.position)).rejects.toThrow(
        "card dependencies are not done.",
      );
    } finally {
      raw.close();
    }
  });
});
