import { DatabaseSync } from "node:sqlite";
import type { WorkboardNotificationSubscription } from "@openclaw/workboard-contract";
import { expect, it, vi } from "vitest";
import { sqliteOnly as test } from "./test/sqlite-only.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const table = "workboard_notification_subscriptions";
function setup() {
  const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
  const list = async (input?: Parameters<typeof store.listNotificationSubscriptions>[0]) =>
    (await store.listNotificationSubscriptions(input)).subscriptions;
  const subscribe = store.subscribeNotifications.bind(store);
  return { store, stores, dbPath, list, subscribe };
}

it("returns only scoped subscriptions from persistence without dropping cursor fields", async () => {
  const { stores, list } = setup();
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
  using reads = vi.spyOn(stores.subscriptions, "entries");
  for (const [input, expectedIds] of [
    [{ boardId: " ALPHA " }, ["a", "c"]],
    [{ cardId: " card " }, ["b", "c"]],
    [{ boardId: "alpha", cardId: "card" }, ["c"]],
    [{ boardId: "alpha", cardId: "other" }, []],
    [{ boardId: "missing" }, []],
    [{ boardId: " ", cardId: " " }, ["a", "b", "c", "d"]],
    [{}, ["a", "b", "c", "d"]],
  ] as const) {
    reads.mockClear();
    expect(await list(input)).toEqual(
      expectedIds.map((id) => subscriptions.find((subscription) => subscription.id === id)),
    );
    const batches = await Promise.all(reads.mock.results.map(({ value }) => value));
    expect(batches.flat().length, JSON.stringify(input)).toBeLessThanOrEqual(expectedIds.length);
  }
});

// Stores a NUL-containing text key, unsupported by PostgreSQL text.
test("keeps exact card matching and refreshes between calls", async () => {
  const { store, list, subscribe } = setup();
  const lower = await subscribe({ cardId: "card" });
  await subscribe({ cardId: "Card" });
  const nul = await subscribe({ cardId: "card\0tail" });
  const replacement = await subscribe({ cardId: "\ufffd" });
  expect(await list({ cardId: "card" })).toEqual([lower]);
  expect(await list({ cardId: "card\0tail" })).toEqual([nul]);
  expect(await list({ cardId: "\ud800" })).toEqual([]);
  expect(await list({ cardId: "\ufffd" })).toEqual([replacement]);
  await store.deleteNotificationSubscription(lower.id);
  expect(await list({ cardId: "card" })).toEqual([]);
});

test("validates selected and unscoped rows while excluding unrelated malformed subscriptions", async () => {
  const { dbPath, list, subscribe } = setup();
  const selected = await subscribe({ boardId: "alpha", cardId: "card" });
  const unrelated = await subscribe({ boardId: "beta", cardId: "other" });
  using db = new DatabaseSync(dbPath);
  db.prepare(`UPDATE ${table} SET event_kinds_json = ? WHERE id = ?`).run("{", unrelated.id);
  expect(await list({ boardId: "alpha" })).toEqual([selected]);
  await expect(list({ boardId: "beta" })).rejects.toThrow();
  await expect(list()).rejects.toThrow();
});

test("deletes board notification subscriptions with empty board metadata", async () => {
  const { store, dbPath, list, subscribe } = setup();
  await store.upsertBoard({ id: "ops", name: "Ops" });
  await subscribe({ boardId: "ops", target: "session:operator", eventKinds: ["completed"] });

  await expect(store.deleteBoard("default")).rejects.toThrow("default board cannot be deleted");
  const card = await store.create({ title: "Still on board", boardId: "ops" });
  await store.archive(card.id, true);
  await expect(store.deleteBoard("ops")).rejects.toThrow("board still has cards");
  await expect(list({ boardId: "ops" })).resolves.toMatchObject([{ boardId: "ops" }]);
  await store.delete(card.id);
  await store.create({ title: "Other board card", boardId: "product" });
  const unrelated = await subscribe({ boardId: "product", target: "session:unrelated" });
  using raw = new DatabaseSync(dbPath);
  raw.prepare(`UPDATE ${table} SET event_kinds_json = ? WHERE id = ?`).run("{", unrelated.id);
  const readUnrelated = raw.prepare(`SELECT * FROM ${table} WHERE id = ?`);
  const unrelatedBefore = readUnrelated.get(unrelated.id);
  expect(unrelatedBefore).toMatchObject({ id: unrelated.id, event_kinds_json: "{" });

  await expect(store.deleteBoard("ops")).resolves.toEqual({ deleted: true });
  await expect(list({ boardId: "ops" })).resolves.toEqual([]);
  expect(readUnrelated.get(unrelated.id)).toEqual(unrelatedBefore);
});
