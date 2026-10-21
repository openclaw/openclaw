import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteStores } from "./test/database-config.js";
import { createGatewayMethodCapture } from "./test/gateway-method-capture.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

const createStores = (dbPath: string) =>
  createWorkboardSqliteStores({
    dbPath,
    workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
  });

function captureCardsList(store: WorkboardStore) {
  const { api, invoke } = createGatewayMethodCapture();
  registerWorkboardGatewayMethods({ api, store });
  return async (params: Record<string, unknown> = {}, expectedSuccess = true) => {
    const [success, data, error] = (await invoke("workboard.cards.list", params)).mock.calls[0]!;
    expect(success).toBe(expectedSuccess);
    return expectedSuccess ? data : error;
  };
}

describe("workboard card list revisions", () => {
  it("shares board summaries across concurrent list shapes until a writer commits", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "On the board", boardId: "ops" });
    const metadataReads = vi.spyOn(stores.boards, "entries");
    const aggregateReads = vi.spyOn(stores.cards, "listBoardAggregates");
    const { api, invoke } = createGatewayMethodCapture();
    registerWorkboardGatewayMethods({ api, store });
    const listBoards = async () => {
      const [success, result] = (await invoke("workboard.boards.list", {})).mock.calls[0]!;
      expect(success).toBe(true);
      return result;
    };
    const listCards = captureCardsList(store);
    const [boards, ops, all, session] = await Promise.all([
      listBoards(),
      listCards({ boardId: "ops" }),
      listCards(),
      listCards({ sessionKey: "another-session" }),
    ]);
    expect(boards.boards).toContainEqual(expect.objectContaining({ id: "ops", total: 1 }));
    for (const result of [ops, all, session, await listBoards()]) {
      expect(result.boards).toEqual(boards.boards);
    }
    expect(metadataReads).toHaveBeenCalledOnce();
    expect(aggregateReads).toHaveBeenCalledOnce();

    const siblingStores = createStores(dbPath);
    const writer = new WorkboardStore(siblingStores.cards, siblingStores);
    try {
      await writer.upsertBoard({ id: "ops", name: "Operations" });
      await writer.update(card.id, { status: "done" });
      const refreshed = await listBoards();
      expect(refreshed.boards).toContainEqual(
        expect.objectContaining({ id: "ops", name: "Operations", byStatus: { done: 1 } }),
      );
      expect((await listCards({ boardId: "ops" })).boards).toEqual(refreshed.boards);
      expect(aggregateReads).toHaveBeenCalledTimes(2);
    } finally {
      await writer.close();
    }
  });

  it("bounds card pages and invalidates the first page after a committed update", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    for (let index = 0; index < 105; index++) {
      const id = `card-${String(index).padStart(3, "0")}`;
      await stores.cards.register(id, {
        version: 1,
        card: {
          id,
          title: id,
          status: "todo",
          priority: "normal",
          labels: [],
          position: 0,
          createdAt: 1,
          updatedAt: 1,
          metadata: { comments: [{ id: `${id}-comment`, body: `Comment ${index}`, createdAt: 1 }] },
        },
      });
    }
    const list = captureCardsList(store);
    const first = await list({});
    expect(first.cards).toHaveLength(100);
    expect(first.nextCursor).toEqual({ position: 0, createdAt: 1, id: "card-099" });
    expect(first.cards[99].metadata.comments[0].body).toBe("Comment 99");
    const second = await list({ after: first.nextCursor, sinceRevision: first.revision });
    expect(second.cards.map((card: { id: string }) => card.id)).toEqual([
      "card-100",
      "card-101",
      "card-102",
      "card-103",
      "card-104",
    ]);
    expect(second.nextCursor).toBeUndefined();
    expect(second.boards[0].total).toBe(105);
    await store.update("card-000", { title: "Changed on the Gateway" });
    const refreshed = await list({ sinceRevision: first.revision });
    expect(refreshed.cards[0].title).toBe("Changed on the Gateway");
    expect(refreshed.cards).toHaveLength(100);
    await list({ after: { id: "card-099" } }, false);
  });

  it("keeps session-filtered payloads and revision receipts separate from full card lists", async () => {
    const { store } = createWorkboardSqliteTestHarness();
    const first = await store.create({ title: "First session", sessionKey: "session-one" });
    const second = await store.create({ title: "Second session", sessionKey: "session-two" });
    const listCards = captureCardsList(store);
    const sessionsBefore = store.sessionsRevision;
    const filtered = await listCards({ sessionKey: "session-one" });
    expect(filtered.cards.map((card: { id: string }) => card.id)).toEqual([first.id]);
    expect(filtered.revision.sessionKey).toBe("session-one");
    expect(store.sessionsRevision).toEqual(sessionsBefore);
    const repeated = await listCards({
      sessionKey: "session-one",
      sinceRevision: filtered.revision,
    });
    expect(repeated).toEqual({ unchanged: true, revision: filtered.revision });
    expect(
      (await listCards({ sessionKey: "session-two", sinceRevision: filtered.revision })).cards.map(
        (card: { id: string }) => card.id,
      ),
    ).toEqual([second.id]);
    expect((await listCards({ sinceRevision: filtered.revision })).cards).toHaveLength(2);
    await listCards({ sessionKey: " " }, false);
  });

  it("refreshes retained lists and session revisions after sibling worker commits", async () => {
    const { store: reader, dbPath } = createWorkboardSqliteTestHarness();
    const stores = createStores(dbPath);
    const writer = new WorkboardStore(stores.cards, stores);
    try {
      const before = await reader.listCards(undefined);
      expect(before.cards).toEqual([]);
      const card = await writer.create({ title: "Created by sibling" });
      const created = await reader.listCards(undefined);
      expect(created.cards).toEqual([expect.objectContaining({ id: card.id })]);
      expect(created.revision.revision).toBeGreaterThan(before.revision.revision);
      expect(await reader.listCards(undefined)).toBe(created);

      const sessionsBefore = reader.sessionsRevision;
      await writer.upsertBoard({ id: "sessions", kind: "sessions", name: "Sibling board" });
      expect(reader.sessionsRevision.revision).toBeGreaterThan(sessionsBefore.revision);
      expect((await reader.listCards(undefined)).boards).toContainEqual(
        expect.objectContaining({ id: "sessions", name: "Sibling board" }),
      );

      await writer.update(card.id, { title: "Updated by sibling" });
      expect((await reader.listCards(undefined)).cards[0]?.title).toBe("Updated by sibling");
      await writer.delete(card.id);
      expect((await reader.listCards(undefined)).cards).toEqual([]);
    } finally {
      await writer.close();
    }
  });

  it("shares one card payload per revision and publishes one invalidation per mutation", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Before", boardId: "ops" });
    await store.claim(card.id, { ownerId: "worker", token: "test-claim-token" });
    const reads = vi.spyOn(stores.cards, "entries");
    const changes = vi.fn();
    store.onChange = changes;
    const listCards = captureCardsList(store);
    const list = (boardId?: string, sinceRevision?: unknown) =>
      listCards({ boardId, sinceRevision });
    const [first, second] = await Promise.all([list("ops"), list(" OPS ")]);
    expect(second).toBe(first);
    expect(await list("ops")).toBe(first);
    expect(reads).toHaveBeenCalledOnce();
    expect(first.cards[0].metadata.claim.token).toBe("[redacted]");
    expect((await store.get(card.id))?.metadata?.claim?.token).toBe("test-claim-token");
    expect((await list("default")).cards).toEqual([]);
    expect((await list()).cards).toEqual(first.cards);

    store.announceChangeEpoch();
    const announcement = changes.mock.calls[0]?.[0];
    expect(announcement).toMatchObject({
      epoch: first.revision.epoch,
      cardsRevision: first.revision.revision,
    });
    expect(await list("ops")).toBe(first);
    const unchanged = await listCards({ boardId: "ops", sinceRevision: first.revision });
    expect(unchanged).toEqual({ unchanged: true, revision: first.revision });
    expect((await list(undefined, first.revision)).cards).toEqual(first.cards);
    changes.mockClear();

    await store.update(card.id, { title: "After" });
    expect(changes).toHaveBeenCalledOnce();
    const next = await list("ops");
    expect(next).not.toBe(first);
    expect(next.revision.revision).toBeGreaterThan(first.revision.revision);
    for (const revision of [first.revision, { ...next.revision, epoch: "retired" }]) {
      expect(await list("ops", revision)).toBe(next);
    }
    expect([next.cards[0].title, first.cards[0].title]).toEqual(["After", "Before"]);
    expect(await list("ops")).toBe(next);

    await store.upsertBoard({ id: "empty", name: "Empty board" });
    const withBoard = await list("ops");
    expect(withBoard.boards).toContainEqual(expect.objectContaining({ id: "empty" }));
    expect(withBoard).not.toBe(next);

    expect(changes).toHaveBeenCalledTimes(2);
  });

  it("retires cached cards when a worker write commits but its reply rejects", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Before" });
    const listCards = captureCardsList(store);
    const before = await listCards({});
    expect(before.cards[0].title).toBe("Before");
    const register = stores.cards.registerIfUpdatedAt.bind(stores.cards);
    vi.spyOn(stores.cards, "registerIfUpdatedAt").mockImplementationOnce(async (...args) => {
      await register(...args);
      throw new Error("committed reply lost");
    });

    await expect(store.update(card.id, { title: "Committed" })).rejects.toThrow(
      "committed reply lost",
    );

    const after = await listCards({});
    expect(after.cards[0].title).toBe("Committed");
    expect(after.revision.revision).toBeGreaterThan(before.revision.revision);
  });

  it("returns uncached reads while a writer receipt is unsettled", async () => {
    let unsettled = false;
    const { store } = createWorkboardSqliteTestHarness({
      createStores: (dbPath) => {
        const stores = createStores(dbPath);
        return {
          ...stores,
          readWriteToken: () => (unsettled ? undefined : stores.readWriteToken()),
        };
      },
    });
    const card = await store.create({ title: "Visible during settlement" });
    const cached = await store.listCards(undefined);
    const cachedBoards = await store.listBoards();
    unsettled = true;
    const first = await store.listCards(undefined);
    const second = await store.listCards(undefined);
    expect(first.cards).toEqual([expect.objectContaining({ id: card.id })]);
    expect(second.cards).toEqual(first.cards);
    expect(first).not.toBe(cached);
    expect(second).not.toBe(first);
    const firstBoards = await store.listBoards();
    const secondBoards = await store.listBoards();
    expect(firstBoards).toEqual(cachedBoards);
    expect(firstBoards).not.toBe(cachedBoards);
    expect(secondBoards).toEqual(firstBoards);
    expect(secondBoards).not.toBe(firstBoards);
    unsettled = false;
    const settled = await store.listCards(undefined);
    expect(settled.revision.revision).toBeGreaterThan(second.revision.revision);
    expect(await store.listCards(undefined)).toBe(settled);
    const settledBoards = await store.listBoards();
    expect(await store.listBoards()).toBe(settledBoards);
  });

  it("retries failed card snapshots and refuses cached reads after store close", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const listCards = captureCardsList(store);
    vi.spyOn(stores.cards, "entries").mockRejectedValueOnce(new Error("read failed"));
    await listCards({}, false);
    await listCards();
    await store.upsertBoard({ id: "ops" });
    vi.spyOn(stores.cards, "listBoardAggregates").mockRejectedValueOnce(new Error("read failed"));
    await expect(store.listBoards()).rejects.toThrow("read failed");
    await expect(store.listBoards()).resolves.toMatchObject({
      boards: expect.arrayContaining([expect.objectContaining({ id: "ops" })]),
    });
    await store.close();
    expect((await listCards({}, false)).message).toContain("closed");
    await expect(store.listBoards()).rejects.toThrow("closed");
  });
});
