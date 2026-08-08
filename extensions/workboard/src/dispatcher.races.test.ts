import { describe, expect, it, vi } from "vitest";
import { reconcileWorkboardTerminalRun } from "./dispatcher-workspace.js";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

function createMemoryStore(): WorkboardKeyedStore {
  const entries = new Map<string, PersistedWorkboardCard>();
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
      return [...entries].map(([key, value]) => ({ key, value }));
    },
  };
}

describe("Workboard dispatcher lifecycle races", () => {
  it.each([
    { name: "archived", archive: true },
    { name: "completed", status: "done" as const },
    { name: "blocked", status: "blocked" as const },
    { name: "under review", status: "review" as const },
    { name: "moved to another board", boardId: "product" },
  ])("does not start a card $name during dispatch preflight", async (transition) => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Concurrent dispatch transition",
      status: "ready",
      boardId: "ops",
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    vi.spyOn(store, "claim").mockImplementationOnce(async (id, input, options) => {
      if ("archive" in transition) {
        await store.archive(id, true);
      } else if ("boardId" in transition) {
        await store.update(id, { boardId: transition.boardId });
      } else {
        await store.update(id, { status: transition.status });
      }
      return await originalClaim(id, input, options);
    });
    const run = vi.fn();

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, boardId: "ops", workspaceAccess: { unrestricted: true } },
    });

    expect(run).not.toHaveBeenCalled();
    expect(result.started).toEqual([]);
    expect(result.startFailures).toEqual([
      expect.objectContaining({
        cardId: card.id,
        error: expect.stringMatching(/archived|authority/),
      }),
    ]);
    const current = await store.get(card.id);
    expect(current?.metadata?.claim).toBeUndefined();
    if ("archive" in transition) {
      expect(current?.metadata?.archivedAt).toBeGreaterThan(0);
    } else if ("boardId" in transition) {
      expect(current?.metadata?.automation?.boardId).toBe("product");
    } else {
      expect(current?.status).toBe(transition.status);
    }
  });

  it("does not spend worker attempts on cards that change before they can be claimed", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const first = await store.create({
      title: "First stale dispatch",
      status: "ready",
      priority: "urgent",
      agentId: "first-worker",
      workspaceAccess: { unrestricted: true },
    });
    const second = await store.create({
      title: "Second stale dispatch",
      status: "ready",
      priority: "high",
      agentId: "second-worker",
      workspaceAccess: { unrestricted: true },
    });
    const healthy = await store.create({
      title: "Healthy dispatch",
      status: "ready",
      priority: "normal",
      agentId: "healthy-worker",
      workspaceAccess: { unrestricted: true },
    });
    const originalClaim = store.claim.bind(store);
    const staleCardIds = new Set([first.id, second.id]);
    vi.spyOn(store, "claim").mockImplementation(async (id, input, options) => {
      if (staleCardIds.delete(id)) {
        await store.archive(id, true);
      }
      return await originalClaim(id, input, options);
    });
    const run = vi.fn().mockResolvedValue({ runId: "healthy-run" });

    const result = await dispatchAndStartWorkboardCards({
      store,
      subagent: { run },
      options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
    });

    expect(result.startFailures.map((failure) => failure.cardId)).toEqual([first.id, second.id]);
    expect(result.started).toEqual([
      expect.objectContaining({ cardId: healthy.id, runId: "healthy-run" }),
    ]);
    expect(run).toHaveBeenCalledOnce();
    await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
    for (const cardId of [first.id, second.id]) {
      const archived = await store.get(cardId);
      expect(archived?.metadata?.archivedAt).toBeGreaterThan(0);
      expect(archived?.metadata?.claim).toBeUndefined();
    }
  });

  it("blocks the matching running card when its subagent ends with an error", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Failed worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-error" }) },
      options: { now: 10, maxStarts: 1 },
    });

    await reconcileWorkboardTerminalRun({
      store,
      event: { runId: "run-error", outcome: "error", error: "provider rejected request" },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked", runId: "run-error" },
      metadata: {
        attempts: [
          expect.objectContaining({
            status: "blocked",
            runId: "run-error",
            error: expect.stringContaining("provider rejected request"),
          }),
        ],
        comments: [
          expect.objectContaining({ body: expect.stringContaining("provider rejected request") }),
        ],
      },
    });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
  });

  it("reconciles a terminal event that arrives before the run id is persisted", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Terminal before persistence",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    const originalUpdate = store.update.bind(store);
    vi.spyOn(store, "update").mockImplementation(async (id, patch) => {
      if (patch.runId === "run-terminal-before-persist") {
        await reconcileWorkboardTerminalRun({
          store,
          event: {
            runId: "run-terminal-before-persist",
            outcome: "error",
            error: "worker exited immediately",
          },
        });
      }
      return await originalUpdate(id, patch);
    });

    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-terminal-before-persist" }) },
      options: { now: 10, maxStarts: 1 },
    });

    const current = await store.get(card.id);
    expect(current).toMatchObject({
      status: "blocked",
      runId: "run-terminal-before-persist",
      execution: { status: "blocked", runId: "run-terminal-before-persist" },
      metadata: {
        attempts: [
          expect.objectContaining({
            status: "blocked",
            runId: "run-terminal-before-persist",
            error: expect.stringContaining("worker exited immediately"),
          }),
        ],
      },
    });
    expect(current?.metadata?.claim).toBeUndefined();
  });

  it("blocks a nominal terminal run that omitted its Workboard lifecycle action", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Silent worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-ok" }) },
      options: { now: 10, maxStarts: 1 },
    });

    await reconcileWorkboardTerminalRun({ store, event: { runId: "run-ok", outcome: "ok" } });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "blocked",
      execution: { status: "blocked", runId: "run-ok" },
      metadata: {
        attempts: [
          expect.objectContaining({
            status: "blocked",
            runId: "run-ok",
            error: expect.stringContaining("workboard_complete or workboard_block"),
          }),
        ],
      },
    });
    expect((await store.get(card.id))?.metadata?.claim).toBeUndefined();
  });

  it("ignores terminal events for a stale run id", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Current worker",
      status: "ready",
      workspaceAccess: { unrestricted: true },
    });
    await dispatchAndStartWorkboardCards({
      store,
      subagent: { run: vi.fn().mockResolvedValue({ runId: "run-current" }) },
      options: { now: 10, maxStarts: 1 },
    });

    await reconcileWorkboardTerminalRun({
      store,
      event: { runId: "run-stale", outcome: "error", error: "late failure" },
    });

    await expect(store.get(card.id)).resolves.toMatchObject({
      status: "running",
      runId: "run-current",
      execution: { status: "running", runId: "run-current" },
      metadata: { claim: expect.objectContaining({ ownerId: "workboard-dispatcher" }) },
    });
  });
});
