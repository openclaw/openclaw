import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerWorkboardGatewayMethods } from "./gateway.js";
import type { WorkboardStore } from "./store.js";
import {
  createWorkboardSqliteTestHarness,
  createWorkboardSqliteTestStore,
} from "./test/sqlite-store.js";

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
  it("shares one frozen card payload per revision and publishes one invalidation per mutation", async () => {
    const { store, stores, dbPath } = createWorkboardSqliteTestHarness();
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

    await store.update(card.id, { title: "After" });
    expect(changes).toHaveBeenCalledOnce();
    const next = await list("ops");
    expect(next).not.toBe(first);
    expect(next.cards[0].title).toBe("After");
    expect(first.cards[0].title).toBe("Before");
    expect(await list("ops")).toBe(next);

    await store.upsertBoard({ id: "empty", name: "Empty board" });
    const withBoard = await list("ops");
    expect(withBoard.boards).toContainEqual(expect.objectContaining({ id: "empty" }));
    expect(withBoard).not.toBe(next);

    using external = new DatabaseSync(dbPath);
    external.prepare("UPDATE workboard_cards SET title = ? WHERE id = ?").run("External", card.id);
    expect(await store.reconcileExternalChanges()).toBe(true);
    const reconciled = await list("ops");
    expect(reconciled.cards[0].title).toBe("External");
    expect(await list("ops")).toBe(reconciled);
    expect(changes).toHaveBeenCalledTimes(3);
  });

  it("replaces a pending card read when a mutation advances its revision", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({ title: "Before" });
    const captured = createDeferred<void>();
    const release = createDeferred<void>();
    const originalList = store.list.bind(store);
    vi.spyOn(store, "list").mockImplementationOnce(async (options) => {
      const cards = await originalList(options);
      captured.resolve();
      await release.promise;
      return cards;
    });
    const listCards = captureCardsList(store);
    const pending = listCards({});
    await captured.promise;
    try {
      await store.update(card.id, { title: "After" });
      const current = await listCards({});
      release.resolve();
      const previous = await pending;
      expect(previous.mock.calls[0]?.[1]).toBe(current.mock.calls[0]?.[1]);
      expect(previous.mock.calls[0]?.[1].cards[0].title).toBe("After");
    } finally {
      release.resolve();
      await pending;
    }
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
