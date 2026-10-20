// Focused Workboard dispatch and recovery store behavior.
import { describe, expect, it, vi } from "vitest";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";

describe("WorkboardStore dispatch and recovery", () => {
  it("promotes, reassigns, and reclaims cards for operator recovery", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Recover me",
      status: "blocked",
      agentId: "old-agent",
      metadata: { failureCount: 2 },
    });
    await store.refreshDiagnostics(Date.now() + 2 * 24 * 60 * 60 * 1000);

    const reassigned = await store.reassign(card.id, {
      agentId: "new-agent",
      status: "todo",
      reason: "route to fresh agent",
    });
    expect(reassigned).toMatchObject({
      agentId: "new-agent",
      status: "todo",
    });
    expect(reassigned.metadata?.failureCount).toBeUndefined();
    expect(reassigned.metadata?.diagnostics?.map((entry) => entry.kind) ?? []).not.toContain(
      "repeated_failures",
    );

    await expect(store.promote(card.id)).resolves.toMatchObject({ status: "ready" });
    const claimed = await store.claim(card.id, { ownerId: "new-agent" });

    const reclaimed = await store.reclaim(claimed.card.id, { reason: "stale session" }, null);
    expect(reclaimed).toMatchObject({ status: "ready" });
    expect(reclaimed.metadata?.claim).toBeUndefined();

    const running = await store.create({
      title: "Running recovery",
      status: "running",
      execution: {
        id: "exec-reclaim",
        kind: "agent-session",
        engine: "codex",
        mode: "autonomous",
        status: "running",
        model: "openai/gpt-5.5",
        startedAt: 100,
        updatedAt: 100,
      },
    });
    await store.claim(running.id, { ownerId: "main" });
    const stopped = await store.reclaim(running.id, { reason: "replace worker" }, null);
    expect(stopped.execution).toBeUndefined();
    expect(stopped.metadata?.claim).toBeUndefined();
    expect(stopped.metadata?.attempts).toEqual([expect.objectContaining({ status: "stopped" })]);
    expect(stopped.metadata?.failureCount).toBeUndefined();
  });

  it("limits exact-card worker context to explicit parent results", async () => {
    const store = createWorkboardSqliteTestStore();
    const parent = await store.create({
      title: "Exact parent",
      status: "done",
      agentId: "agent-a",
      metadata: { automation: { summary: "Required parent result." } },
    });
    await store.create({
      title: "Unrelated assignee history",
      status: "done",
      agentId: "agent-a",
      metadata: { automation: { summary: "Unrelated private history." } },
    });
    const child = await store.create({
      title: "Exact child",
      agentId: "agent-a",
      parents: [parent.id],
    });

    const context = await store.buildWorkerContext(child.id, { relatedOnly: true });

    expect(context).toContain("Required parent result.");
    expect(context).not.toContain("Unrelated private history.");
    expect(context).not.toContain("## Recent done work by agent-a");
  });

  it("dispatches one exact card without enumerating or mutating unrelated cards", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      const store = createWorkboardSqliteTestStore();
      const stale = await store.create({
        title: "Expired unrelated worker",
        status: "ready",
        boardId: "ops",
      });
      await store.claim(stale.id, {
        ownerId: "expired-owner",
        token: "expired-token",
        ttlSeconds: 1,
      });
      const sibling = await store.create({
        title: "Unrelated urgent card",
        status: "ready",
        priority: "urgent",
        boardId: "ops",
      });
      const target = await store.create({
        title: "Exact dispatch target",
        status: "ready",
        priority: "low",
        boardId: "ops",
      });
      const staleBefore = await store.get(stale.id);
      const siblingBefore = await store.get(sibling.id);
      vi.setSystemTime(1_000_000 + 10 * 60 * 1000);
      const list = vi.spyOn(store, "list");

      const dispatch = await store.dispatch({
        now: Date.now(),
        boardId: "ops",
        cardId: target.id,
      });

      expect(list).not.toHaveBeenCalled();
      expect(dispatch).toEqual({
        promoted: [],
        reclaimed: [],
        blocked: [],
        orchestrated: [],
        count: 0,
      });
      await expect(store.get(target.id)).resolves.toMatchObject({
        status: "ready",
        metadata: { automation: { dispatchCount: 1, lastDispatchAt: Date.now() } },
      });

      const nextDispatchAt = Date.now() + 1;
      await expect(
        store.dispatch({ now: nextDispatchAt, boardId: "ops", cardId: target.id }),
      ).resolves.toEqual(dispatch);
      await expect(store.get(target.id)).resolves.toMatchObject({
        status: "ready",
        metadata: { automation: { dispatchCount: 2, lastDispatchAt: nextDispatchAt } },
      });
      expect(list).not.toHaveBeenCalled();
      await expect(store.get(stale.id)).resolves.toEqual(staleBefore);
      await expect(store.get(sibling.id)).resolves.toEqual(siblingBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["", "   ", 42])(
    "rejects invalid exact-card input %j without mutation",
    async (cardId) => {
      const store = createWorkboardSqliteTestStore();
      const sibling = await store.create({ title: "Unrelated ready card", status: "ready" });

      await expect(store.dispatch({ now: 10, cardId })).rejects.toThrow(
        "cardId must be a non-empty string.",
      );
      await expect(store.get(sibling.id)).resolves.toEqual(sibling);
    },
  );

  it("rejects an exact-card board mismatch before mutating the card", async () => {
    const store = createWorkboardSqliteTestStore();
    const target = await store.create({
      title: "Wrong-board target",
      status: "ready",
      boardId: "product",
    });

    await expect(store.dispatch({ now: 10, boardId: "ops", cardId: target.id })).rejects.toThrow(
      `belongs to board product, not ops`,
    );
    await expect(store.get(target.id)).resolves.toEqual(target);
  });

  it("rejects an invalid external intent before preparing a claimed launch", async () => {
    const store = createWorkboardSqliteTestStore();
    const target = await store.create({ title: "Intent-bound launch", status: "ready" });
    const claimed = await store.claim(target.id, { ownerId: "worker" });

    await expect(
      store.prepareExecutionLaunch(target.id, {
        requestedSessionKey: "subagent:workboard-intent-bound",
        now: 100,
        scope: { ownerId: "worker", token: claimed.token },
        intentRunId: "not-a-receipt",
      }),
    ).rejects.toThrow("intentRunId must be a wb-<40 lowercase hex> dispatch intent id.");
    await expect(store.get(target.id)).resolves.toEqual(claimed.card);
  });
});
