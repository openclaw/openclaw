import { RequestScopedSubagentRuntimeError } from "openclaw/plugin-sdk/error-runtime";
// Workboard tests cover dispatcher plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { WorkboardStore, type PersistedWorkboardCard, type WorkboardKeyedStore } from "./store.js";

function createMemoryStore<T = PersistedWorkboardCard>(): WorkboardKeyedStore<T> {
  const entries = new Map<string, T>();
  return {
    async register(key, value) {
      entries.set(key, value);
    },
    async lookup(key) {
      return entries.get(key);
    },
    async delete(key) {
      return entries.delete(key);
    },
    async entries() {
      return [...entries].flatMap(([key, value]) => (value ? [{ key, value }] : []));
    },
  };
}

describe("dispatchAndStartWorkboardCards", () => {
  it("claims ready cards and starts bounded subagent worker runs", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First worker",
      status: "ready",
      priority: "urgent",
      agentId: "codex-main",
    });
    const second = await store.create({
      title: "Second worker",
      status: "ready",
      priority: "normal",
      agentId: "codex-main",
    });
    const otherAgent = await store.create({
      title: "Other worker",
      status: "ready",
      priority: "high",
      agentId: "codex-side",
    });
    const run = vi
      .fn()
      .mockResolvedValueOnce({ runId: "run-first" })
      .mockResolvedValueOnce({ runId: "run-other" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started.map((entry) => entry.cardId).toSorted()).toEqual(
      [first.id, otherAgent.id].toSorted(),
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      lane: `workboard:default:${first.id}`,
      deliver: false,
    });
    expect(run.mock.calls[0]?.[0]?.message).toContain("Claim token:");
    expect(run.mock.calls[0]?.[0]?.message).toContain("workboard_complete with the card id");
    expect(run.mock.calls[0]?.[0]?.message).not.toContain("ownerId and token");
    await expect(store.get(first.id)).resolves.toMatchObject({
      status: "running",
      sessionKey: `agent:codex-main:subagent:workboard-default-${first.id}`,
      runId: "run-first",
      execution: { status: "running", runId: "run-first" },
      metadata: {
        claim: { ownerId: "codex-main" },
        workerLogs: [expect.objectContaining({ message: expect.stringContaining("run-first") })],
      },
    });
    await expect(store.get(second.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { dispatchCount: 1 } },
    });
  });

  it("does not let review cards consume an agent running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Waiting for operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    const ready = await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([
      expect.objectContaining({
        cardId: ready.id,
        runId: "run-next",
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
  });

  it("starts only targeted ready cards when cardIds are supplied", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const target = await store.create({
      title: "Target child",
      status: "ready",
      priority: "normal",
      agentId: "child-agent",
    });
    const unrelated = await store.create({
      title: "Unrelated ready",
      status: "ready",
      priority: "urgent",
      agentId: "other-agent",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-target" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, cardIds: [target.id] },
    });

    expect(result.started).toEqual([
      expect.objectContaining({ cardId: target.id, runId: "run-target" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(target.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-target",
    });
    const unrelatedAfter = await store.get(unrelated.id);
    expect(unrelatedAfter).toMatchObject({ status: "ready" });
    expect(unrelatedAfter?.runId).toBeUndefined();
  });

  it("does not let off-board or archived stale claims consume the target owner slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({
      title: "Off-board active worker",
      status: "running",
      boardId: "other-board",
      agentId: "marshal",
    });
    await store.create({
      title: "Off-board blocked stale claim",
      status: "blocked",
      boardId: "other-board",
      agentId: "marshal",
      metadata: {
        claim: {
          ownerId: "marshal",
          token: "stale-off-board",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: 2,
        },
      },
    });
    await store.create({
      title: "Archived stale claim",
      status: "blocked",
      boardId: "mission",
      agentId: "marshal",
      metadata: {
        archivedAt: 5,
        claim: {
          ownerId: "marshal",
          token: "stale-archived",
          claimedAt: 1,
          lastHeartbeatAt: 1,
          expiresAt: 2,
        },
      },
    });
    const target = await store.create({
      title: "Wave target",
      status: "ready",
      boardId: "mission",
      agentId: "marshal",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-target" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, boardId: "mission", cardIds: [target.id] },
    });

    expect(result.skipped).toEqual([]);
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: target.id, runId: "run-target" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(target.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-target",
    });
  });

  it("records a targeted skip when same-board active work owns the slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const active = await store.create({
      title: "Active same-board worker",
      status: "running",
      boardId: "mission",
      agentId: "marshal",
    });
    const target = await store.create({
      title: "Blocked by active owner",
      status: "ready",
      boardId: "mission",
      agentId: "marshal",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-target" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, boardId: "mission", cardIds: [target.id] },
    });

    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({
        cardId: target.id,
        reason: expect.stringContaining(active.id),
      }),
    ]);
    expect(run).not.toHaveBeenCalled();
    await expect(store.get(target.id)).resolves.toMatchObject({
      status: "ready",
      metadata: {
        workerLogs: [
          expect.objectContaining({
            level: "warning",
            message: expect.stringContaining("Dispatcher skipped worker start"),
          }),
        ],
      },
    });
  });

  it("blocks targeted cards when subagent runtime is unavailable", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const parent = await store.create({
      title: "Parent",
      status: "ready",
      priority: "normal",
    });
    const target = await store.create({
      title: "Target child",
      parents: [parent.id],
      priority: "normal",
      agentId: "child-agent",
    });
    const unrelated = await store.create({
      title: "Unrelated child",
      parents: [parent.id],
      priority: "urgent",
      agentId: "other-agent",
    });
    const claimedParent = await store.claim(parent.id, { ownerId: "parent-agent" });
    await store.complete(
      parent.id,
      { summary: "Parent done." },
      { ownerId: "parent-agent", token: claimedParent.token },
    );
    const run = vi.fn().mockRejectedValue(new RequestScopedSubagentRuntimeError());

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, cardIds: [target.id] },
    });

    expect(result.promoted).toEqual([expect.objectContaining({ id: target.id, status: "ready" })]);
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: target.id,
        error: expect.stringContaining("subagent methods are only available"),
      }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    const targetAfter = await store.get(target.id);
    expect(targetAfter).toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("Dispatcher could not start worker"),
          }),
        ],
      },
    });
    expect(targetAfter?.metadata?.claim).toBeUndefined();
    await expect(store.get(unrelated.id)).resolves.toMatchObject({ status: "todo" });
  });

  it("starts workers only for the selected board", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const ops = await store.create({
      title: "Ops worker",
      status: "ready",
      priority: "urgent",
      boardId: "ops",
    });
    const product = await store.create({
      title: "Product worker",
      status: "ready",
      priority: "urgent",
      boardId: "product",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-ops" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3, boardId: "ops" },
    });

    expect(result.started).toEqual([expect.objectContaining({ cardId: ops.id })]);
    expect(run).toHaveBeenCalledOnce();
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      sessionKey: `subagent:workboard-ops-${ops.id}`,
      lane: `workboard:ops:${ops.id}`,
    });
    await expect(store.get(product.id)).resolves.toMatchObject({
      status: "ready",
      metadata: { automation: { boardId: "product" } },
    });
  });

  it("keeps claimed review cards in the owner running slot", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const review = await store.create({
      title: "Claimed operator review",
      status: "review",
      priority: "normal",
      agentId: "codex-main",
    });
    await store.claim(review.id, { ownerId: "codex-main", token: "review-token" });
    await store.create({
      title: "Next ready card",
      status: "ready",
      priority: "high",
      agentId: "codex-main",
    });
    const run = vi.fn().mockResolvedValue({ runId: "run-next" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 3 },
    });

    expect(result.started).toEqual([]);
    expect(run).not.toHaveBeenCalled();
  });

  it("blocks a card when worker start fails after claim", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({ title: "Fail worker", status: "ready" });
    const run = vi.fn().mockRejectedValue(new Error("model unavailable"));

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { now: 10, maxStarts: 1 },
    });

    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({ cardId: card.id, error: "model unavailable" }),
    ]);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionKey: `subagent:workboard-default-${card.id}`,
      }),
    );
    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      metadata: {
        comments: [
          expect.objectContaining({
            body: expect.stringContaining("Dispatcher could not start worker"),
          }),
        ],
      },
    });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
  });
});
