// Exact-card Workboard worker admission and isolation.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("Workboard exact dispatch", () => {
  it("dispatches one exact queued card without enumerating or mutating unrelated ready or stale cards", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const store = createWorkboardSqliteTestStore();
      const stale = await store.create({
        title: "Expired unrelated worker",
        status: "ready",
        boardId: "ops",
        agentId: "expired-owner",
      });
      await store.claim(stale.id, {
        ownerId: "expired-owner",
        token: "expired-token",
        ttlSeconds: 1,
      });
      const urgent = await store.create({
        title: "Unrelated urgent card",
        status: "ready",
        priority: "urgent",
        boardId: "ops",
        agentId: "urgent-owner",
        workspaceAccess: { unrestricted: true },
      });
      const target = await store.create({
        title: "Exact queued target",
        status: "ready",
        priority: "low",
        boardId: "ops",
        agentId: "target-owner",
        workspaceAccess: { unrestricted: true },
      });
      vi.setSystemTime(1_000_000 + 10 * 60 * 1000);
      const staleBefore = await store.get(stale.id);
      const urgentBefore = await store.get(urgent.id);
      const list = vi.spyOn(store, "list");
      const run = vi.fn().mockResolvedValue({ runId: "target-run" });

      const result = await dispatchAndStartWorkboardCards({
        store,
        subagent: { run },
        options: {
          cardId: target.id,
          targetMode: "dispatch",
          boardId: "ops",
          maxStarts: 1,
          now: Date.now(),
        },
      });

      expect(list).not.toHaveBeenCalled();
      expect(result.startFailures).toEqual([]);
      expect(run).toHaveBeenCalledOnce();
      expect(result.started).toEqual([
        expect.objectContaining({ cardId: target.id, runId: "target-run" }),
      ]);
      expect(result.started[0]).not.toHaveProperty("card");
      await expect(store.get(target.id)).resolves.toMatchObject({
        status: "running",
        metadata: { claim: { ownerId: "target-owner" } },
      });
      await expect(store.get(stale.id)).resolves.toEqual(staleBefore);
      await expect(store.get(urgent.id)).resolves.toEqual(urgentBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps dependency-gated exact dispatch targets out of worker admission", async () => {
    const store = createWorkboardSqliteTestStore();
    const parent = await store.create({ title: "Incomplete parent", status: "todo" });
    const target = await store.create({
      title: "Dependency-gated target",
      status: "todo",
      agentId: "target-owner",
      workspaceAccess: { unrestricted: true },
    });
    await store.linkCards(parent.id, target.id);
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { cardId: target.id, targetMode: "dispatch", maxStarts: 1 },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: target.id,
        error: expect.stringMatching(/dependency.*ready/i),
      }),
    ]);
    await expect(store.get(target.id)).resolves.toMatchObject({ status: "todo" });
  });
});
