import { describe, expect, it, vi } from "vitest";
import { createKernelStores } from "./test/sqlite-kernel.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard dependency and scheduled promotion", () => {
  it("creates idempotent child cards and promotes them when parents finish", async () => {
    const store = createWorkboardSqliteTestStore({ createStores: createKernelStores });
    const parent = await store.create({ title: "Parent", status: "running" });
    const child = await store.create({
      title: "Child",
      status: "todo",
      parents: [parent.id],
      tenant: "release",
      idempotencyKey: "fanout:1",
      skills: ["testing"],
      workspace: { kind: "scratch" },
    });

    expect(child.status).toBe("todo");
    expect(child.metadata?.links).toEqual([
      expect.objectContaining({ type: "parent", targetCardId: parent.id }),
    ]);
    await expect(store.get(parent.id)).resolves.toMatchObject({
      metadata: { links: [expect.objectContaining({ type: "child", targetCardId: child.id })] },
    });
    await expect(
      store.create({
        title: "Duplicate child",
        tenant: "release",
        idempotencyKey: "fanout:1",
      }),
    ).resolves.toMatchObject({ id: child.id });
    await expect(
      store.create({
        title: "Different tenant child",
        tenant: "qa",
        idempotencyKey: "fanout:1",
      }),
    ).resolves.toMatchObject({ title: "Different tenant child" });
    await expect(
      store.create({ title: "Unscoped child", idempotencyKey: "fanout:1" }),
    ).resolves.toMatchObject({ title: "Unscoped child" });

    await store.complete(parent.id, { summary: "Parent done." });
    const { promoted } = await store.dispatch();

    expect(promoted).toEqual([expect.objectContaining({ id: child.id, status: "ready" })]);
    await expect(store.get(child.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        automation: {
          tenant: "release",
          idempotencyKey: "fanout:1",
          skills: ["testing"],
          workspace: { kind: "scratch" },
        },
      },
    });
  });

  it("does not promote or claim an archived scheduled card", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      const store = createWorkboardSqliteTestStore();
      const card = await store.create({
        title: "Archived scheduled work",
        status: "scheduled",
        scheduledAt: 2_000,
      });
      const archived = await store.archive(card.id, true);
      const changes = vi.fn();
      store.subscribeChanges(changes);

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await expect(store.dispatch(3_000 + attempt)).resolves.toEqual({
          promoted: [],
          reclaimed: [],
          blocked: [],
          orchestrated: [],
          count: 0,
        });
      }
      await expect(store.claim(card.id, { ownerId: "worker" })).rejects.toThrow(/archived/);
      await expect(store.get(card.id)).resolves.toEqual(archived);
      expect(changes).not.toHaveBeenCalled();

      vi.setSystemTime(3_000);
      await store.archive(card.id, false);
      await expect(store.claim(card.id, { ownerId: "worker" })).resolves.toMatchObject({
        card: { id: card.id, status: "running" },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
