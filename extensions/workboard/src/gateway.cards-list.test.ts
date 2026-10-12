import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import { workboardSqliteBackendEntrypoint } from "./sqlite-backend-entrypoint.test-support.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

function captureCardsList(store: WorkboardStore) {
  let list: Parameters<OpenClawPluginApi["registerGatewayMethod"]>[1];
  const api = createTestPluginApi({
    registerGatewayMethod: (name, handler) => {
      if (name === "workboard.cards.list") {
        list = handler;
      }
    },
  });
  registerWorkboardGatewayMethods({ api, store });
  return async (params: Record<string, unknown>) => {
    const respond = vi.fn();
    await list({ params, respond } as never);
    return respond;
  };
}

describe("workboard card list revisions", () => {
  it("refreshes retained lists and session revisions after sibling worker commits", async () => {
    const { store: reader, dbPath } = createWorkboardSqliteTestHarness();
    const stores = createWorkboardSqliteStores({
      dbPath,
      workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
    });
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

  it("shares one frozen card payload per revision and publishes one invalidation per mutation", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Before", boardId: "ops" });
    await store.claim(card.id, { ownerId: "worker", token: "test-claim-token" });
    const reads = vi.spyOn(stores.cards, "entries");
    const changes = vi.fn();
    store.subscribeChanges(changes);
    const listCards = captureCardsList(store);
    const list = async (boardId?: string) => {
      const respond = await listCards({ boardId });
      expect(respond.mock.calls[0]?.[0]).toBe(true);
      return respond.mock.calls[0]?.[1];
    };
    const [first, second] = await Promise.all([list("ops"), list(" OPS ")]);
    expect(second).toBe(first);
    expect(await list("ops")).toBe(first);
    expect(reads).toHaveBeenCalledOnce();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.cards[0].metadata.automation)).toBe(true);
    expect(first.cards[0].metadata.claim.token).toBe("[redacted]");
    expect((await store.get(card.id))?.metadata?.claim?.token).toBe("test-claim-token");
    expect(() => first.cards.push(card)).toThrow(TypeError);
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
    expect(unchanged.mock.calls[0]?.[1]).toEqual({ unchanged: true, revision: first.revision });
    const otherScope = await listCards({ sinceRevision: first.revision });
    expect(otherScope.mock.calls[0]?.[1].cards).toEqual(first.cards);
    changes.mockClear();

    await store.update(card.id, { title: "After" });
    expect(changes).toHaveBeenCalledOnce();
    const next = await list("ops");
    expect(next).not.toBe(first);
    expect(next.revision.revision).toBeGreaterThan(first.revision.revision);
    const changed = await listCards({ boardId: "ops", sinceRevision: first.revision });
    expect(changed.mock.calls[0]?.[1]).toBe(next);
    const previousEpoch = await listCards({
      boardId: "ops",
      sinceRevision: { ...next.revision, epoch: "retired" },
    });
    expect(previousEpoch.mock.calls[0]?.[1]).toBe(next);
    expect(next.cards[0].title).toBe("After");
    expect(first.cards[0].title).toBe("Before");
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
    expect(before.mock.calls[0]?.[1].cards[0].title).toBe("Before");
    const register = stores.cards.registerIfUpdatedAt.bind(stores.cards);
    vi.spyOn(stores.cards, "registerIfUpdatedAt").mockImplementationOnce(async (...args) => {
      await register(...args);
      throw new Error("committed reply lost");
    });

    await expect(store.update(card.id, { title: "Committed" })).rejects.toThrow(
      "committed reply lost",
    );

    const after = await listCards({});
    expect(after.mock.calls[0]?.[1].cards[0].title).toBe("Committed");
    expect(after.mock.calls[0]?.[1].revision.revision).toBeGreaterThan(
      before.mock.calls[0]?.[1].revision.revision,
    );
  });

  it("returns uncached reads while a writer receipt is unsettled", async () => {
    let unsettled = false;
    const { store } = createWorkboardSqliteTestHarness({
      createStores: (dbPath) => {
        const stores = createWorkboardSqliteStores({
          dbPath,
          workerModuleUrl: resolveRuntimeWorkerUrl(workboardSqliteBackendEntrypoint),
        });
        return {
          ...stores,
          readWriteToken: () => (unsettled ? undefined : stores.readWriteToken()),
        };
      },
    });
    const card = await store.create({ title: "Visible during settlement" });
    const cached = await store.listCards(undefined);
    unsettled = true;
    const first = await store.listCards(undefined);
    const second = await store.listCards(undefined);
    expect(first.cards).toEqual([expect.objectContaining({ id: card.id })]);
    expect(second.cards).toEqual(first.cards);
    expect(first).not.toBe(cached);
    expect(second).not.toBe(first);
    unsettled = false;
    const settled = await store.listCards(undefined);
    expect(settled.revision.revision).toBeGreaterThan(second.revision.revision);
    expect(await store.listCards(undefined)).toBe(settled);
  });

  it("retries failed card snapshots and refuses cached reads after store close", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const listCards = captureCardsList(store);
    vi.spyOn(stores.cards, "entries").mockRejectedValueOnce(new Error("read failed"));
    const failed = await listCards({});
    expect(failed.mock.calls[0]?.[0]).toBe(false);
    const recovered = await listCards({});
    expect(recovered.mock.calls[0]?.[0]).toBe(true);
    await store.close();
    const closed = await listCards({});
    expect(closed.mock.calls[0]?.[0]).toBe(false);
    expect(closed.mock.calls[0]?.[2].message).toContain("closed");
  });

  it("invalidates committed attachment deletion even if the remaining card update fails", async () => {
    const { store, stores } = createWorkboardSqliteTestHarness();
    const card = await store.create({ title: "Attachment" });
    const attached = await store.addAttachment(card.id, {
      fileName: "proof.txt",
      contentBase64: "cHJvb2Y=",
    });
    const listCards = captureCardsList(store);
    const before = await listCards({});
    expect(before.mock.calls[0]?.[1].cards[0].metadata.attachments).toHaveLength(1);
    const changes = vi.fn();
    store.subscribeChanges(changes);
    vi.spyOn(stores.cards, "registerIfUpdatedAt").mockRejectedValueOnce(new Error("write failed"));
    await expect(
      store.deleteAttachment(card.id, attached.metadata!.attachments![0]!.id),
    ).rejects.toThrow("write failed");
    expect(changes).toHaveBeenCalledOnce();
    const after = await listCards({});
    expect(after.mock.calls[0]?.[1].cards[0].metadata?.attachments).toBeUndefined();
  });
});
