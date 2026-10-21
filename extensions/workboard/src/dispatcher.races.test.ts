import path from "node:path";
import { expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestHarness } from "./test/sqlite-store.js";

function setup() {
  const { store, dbPath } = createWorkboardSqliteTestHarness();
  const create = (input: Omit<Parameters<typeof store.create>[0], "title">) =>
    store.create({
      title: "Dispatch",
      status: "ready",
      workspaceAccess: { unrestricted: true },
      ...input,
    });
  const dispatch = (params: Omit<Parameters<typeof dispatchAndStartWorkboardCards>[0], "store">) =>
    dispatchAndStartWorkboardCards({ store, ...params });
  return { store, create, dispatch, managedPath: path.dirname(dbPath) };
}

it.each([
  { name: "archived", archive: true },
  { name: "completed", status: "done" as const },
  { name: "moved to another board", boardId: "product" },
])("does not start a card $name during dispatch preflight", async (transition) => {
  const { store, create, dispatch } = setup();
  const card = await create({ boardId: "ops" });
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

  const result = await dispatch({
    subagent: { run },
    options: { maxStarts: 1, boardId: "ops", workspaceAccess: { unrestricted: true } },
  });

  expect(run).not.toHaveBeenCalled();
  expect(result).toMatchObject({
    started: [],
    startFailures: [{ cardId: card.id, error: expect.stringMatching(/archived|authority/) }],
  });
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
  const { store, create, dispatch } = setup();
  const first = await create({ priority: "urgent", agentId: "first-worker" });
  const second = await create({ priority: "high", agentId: "second-worker" });
  const healthy = await create({ priority: "normal", agentId: "healthy-worker" });
  const originalClaim = store.claim.bind(store);
  const staleCardIds = new Set([first.id, second.id]);
  vi.spyOn(store, "claim").mockImplementation(async (id, input, options) => {
    if (staleCardIds.delete(id)) {
      await store.archive(id, true);
    }
    return await originalClaim(id, input, options);
  });
  const run = vi.fn().mockResolvedValue({ runId: "healthy-run" });

  const result = await dispatch({
    subagent: { run },
    options: { maxStarts: 1, workspaceAccess: { unrestricted: true } },
  });

  expect(result.startFailures.map((failure) => failure.cardId)).toEqual([first.id, second.id]);
  expect(result.started).toMatchObject([{ cardId: healthy.id, runId: "healthy-run" }]);
  expect(run).toHaveBeenCalledOnce();
  await expect(store.get(healthy.id)).resolves.toMatchObject({ status: "running" });
  for (const cardId of [first.id, second.id]) {
    const archived = await store.get(cardId);
    expect(archived?.metadata?.archivedAt).toBeGreaterThan(0);
    expect(archived?.metadata?.claim).toBeUndefined();
  }
});

it("retains a managed worktree when pre-start lossless cleanup declines", async () => {
  const { store, create, dispatch, managedPath } = setup();
  const card = await create({ workspace: { kind: "worktree", path: "/repo", branch: "main" } });
  const removeIfLossless = vi.fn().mockResolvedValue(false);
  const result = await dispatch({
    subagent: { run: vi.fn().mockRejectedValue(new Error("model unavailable")) },
    worktrees: {
      resolveCheckoutRoot: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockResolvedValue({ id: "managed-id", path: managedPath, branch: "managed" }),
      release: vi.fn(),
      removeIfLossless,
    },
    options: { now: 10, maxStarts: 1, materializeWorktree: true },
  });

  expect(result.startFailures).toMatchObject([{ cardId: card.id, error: "model unavailable" }]);
  expect(removeIfLossless).toHaveBeenCalledOnce();
  const blocked = await store.get(card.id);
  expect(blocked?.status).toBe("blocked");
  expect(blocked?.metadata?.automation?.workspace).toMatchObject({
    kind: "worktree",
    path: managedPath,
    sourcePath: "/repo",
  });
  expect([blocked?.execution, blocked?.runId]).toEqual([undefined, undefined]);
});
