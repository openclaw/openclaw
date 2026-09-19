import { DatabaseSync } from "node:sqlite";
import type { WorkboardNotificationSubscription } from "@openclaw/workboard-contract";
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

describe("Workboard scoped subscription listing", () => {
  it("returns only scoped subscriptions from persistence without dropping cursor fields", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const subscriptions: WorkboardNotificationSubscription[] = [
      {
        id: "c",
        boardId: "alpha",
        cardId: "card",
        createdAt: 20,
        updatedAt: 30,
        eventKinds: ["completed"],
        deliveredEventIds: ["legacy-event"],
        lastEventAt: 0,
        lastEventId: "cursor",
        lastEventSequence: 0,
      },
      { id: "a", boardId: "alpha", target: "channel", createdAt: 10, updatedAt: 31 },
      { id: "b", boardId: "beta", cardId: "card", createdAt: 10, updatedAt: 32 },
      { id: "d", boardId: "beta", cardId: "other", createdAt: 40, updatedAt: 41 },
    ];
    for (const subscription of subscriptions) {
      await stores.subscriptions.register(subscription.id, { version: 1, subscription });
    }
    const entries = stores.subscriptions.entries.bind(stores.subscriptions);
    let returnedRows = 0;
    const reads = vi.spyOn(stores.subscriptions, "entries").mockImplementation(async (...args) => {
      const rows = await entries(...args);
      returnedRows += rows.length;
      return rows;
    });
    try {
      for (const [input, expectedIds] of [
        [{ boardId: " ALPHA " }, ["a", "c"]],
        [{ cardId: " card " }, ["b", "c"]],
        [{ boardId: "alpha", cardId: "card" }, ["c"]],
        [{ boardId: "alpha", cardId: "other" }, []],
        [{ boardId: "missing" }, []],
        [{ boardId: " ", cardId: " " }, ["a", "b", "c", "d"]],
        [{}, ["a", "b", "c", "d"]],
      ] as const) {
        returnedRows = 0;
        reads.mockClear();
        const result = await store.listNotificationSubscriptions(input);
        expect(result.subscriptions).toEqual(
          expectedIds.map((id) => subscriptions.find((subscription) => subscription.id === id)),
        );
        expect(reads).toHaveBeenCalled();
        expect(returnedRows, JSON.stringify(input)).toBeLessThanOrEqual(expectedIds.length);
      }
    } finally {
      reads.mockRestore();
    }
  });

  it("keeps exact card matching and refreshes between calls", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const lower = await store.subscribeNotifications({ cardId: "card" });
    await store.subscribeNotifications({ cardId: "Card" });
    const nul = await store.subscribeNotifications({ cardId: "card\0tail" });
    const replacement = await store.subscribeNotifications({ cardId: "\ufffd" });
    expect((await store.listNotificationSubscriptions({ cardId: "card" })).subscriptions).toEqual([
      lower,
    ]);
    expect(
      (await store.listNotificationSubscriptions({ cardId: "card\0tail" })).subscriptions,
    ).toEqual([nul]);
    expect((await store.listNotificationSubscriptions({ cardId: "\ud800" })).subscriptions).toEqual(
      [],
    );
    expect((await store.listNotificationSubscriptions({ cardId: "\ufffd" })).subscriptions).toEqual(
      [replacement],
    );
    await store.deleteNotificationSubscription(lower.id);
    expect((await store.listNotificationSubscriptions({ cardId: "card" })).subscriptions).toEqual(
      [],
    );
  });

  it("validates selected and unscoped rows while excluding unrelated malformed subscriptions", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    const selected = await store.subscribeNotifications({ boardId: "alpha", cardId: "card" });
    const unrelated = await store.subscribeNotifications({ boardId: "beta", cardId: "other" });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare(
        "UPDATE workboard_notification_subscriptions SET event_kinds_json = ? WHERE id = ?",
      ).run("{", unrelated.id);
      expect(
        (await store.listNotificationSubscriptions({ boardId: "alpha" })).subscriptions,
      ).toEqual([selected]);
      await expect(store.listNotificationSubscriptions({ boardId: "beta" })).rejects.toThrow();
      await expect(store.listNotificationSubscriptions()).rejects.toThrow();
    } finally {
      db.close();
    }
  });

  it("deletes board notification subscriptions with empty board metadata", async () => {
    const { store, dbPath } = createWorkboardSqliteTestHarness();
    await store.upsertBoard({ id: "ops", name: "Ops" });
    await store.subscribeNotifications({
      boardId: "ops",
      target: "session:operator",
      eventKinds: ["completed"],
    });

    await expect(store.deleteBoard("default")).rejects.toThrow("default board cannot be deleted");
    const card = await store.create({ title: "Still on board", boardId: "ops" });
    await store.archive(card.id, true);
    await expect(store.deleteBoard("ops")).rejects.toThrow("board still has cards");
    await expect(store.listNotificationSubscriptions({ boardId: "ops" })).resolves.toMatchObject({
      subscriptions: [expect.objectContaining({ boardId: "ops" })],
    });
    await store.delete(card.id);
    await store.create({ title: "Other board card", boardId: "product" });
    const unrelated = await store.subscribeNotifications({
      boardId: "product",
      target: "session:unrelated",
    });
    const raw = new DatabaseSync(dbPath);
    try {
      raw
        .prepare(
          "UPDATE workboard_notification_subscriptions SET event_kinds_json = ? WHERE id = ?",
        )
        .run("{", unrelated.id);
      const readUnrelated = raw.prepare(
        "SELECT * FROM workboard_notification_subscriptions WHERE id = ?",
      );
      const unrelatedBefore = readUnrelated.get(unrelated.id);
      expect(unrelatedBefore).toMatchObject({ id: unrelated.id, event_kinds_json: "{" });

      await expect(store.deleteBoard("ops")).resolves.toEqual({ deleted: true });
      await expect(store.listNotificationSubscriptions({ boardId: "ops" })).resolves.toEqual({
        subscriptions: [],
      });
      expect(readUnrelated.get(unrelated.id)).toEqual(unrelatedBefore);
    } finally {
      raw.close();
    }
  });
});
