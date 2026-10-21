import { expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import type { WorkboardWorkspaceAccess } from "./workspace-access.js";

const fullHostAccess: WorkboardWorkspaceAccess = { unrestricted: true };
const workspaceAccess: WorkboardWorkspaceAccess = {
  unrestricted: false,
  roots: ["/workspace"],
  writable: true,
};
const readOnlyAccess: WorkboardWorkspaceAccess = { ...workspaceAccess, writable: false };

async function setup(persisted: WorkboardWorkspaceAccess | undefined) {
  const store = createWorkboardSqliteTestStore();
  const card = await store.create({
    title: "Outside checkout",
    status: "ready",
    workspace: { kind: "worktree", path: "/repo" },
    workspaceAccess: persisted,
  });
  return { store, card, run: vi.fn() };
}

it.each([
  ["host-authorized card", fullHostAccess, workspaceAccess, true],
  ["unknown card authority", undefined, workspaceAccess, false],
  ["workspace-bound card", workspaceAccess, workspaceAccess, false],
  ["admin caller with restricted card", workspaceAccess, fullHostAccess, false],
  ["read-only caller", fullHostAccess, readOnlyAccess, false],
] as const)("offers an admin retry for %s", async (_name, persisted, caller, hint) => {
  const { store, card, run } = await setup(persisted);
  const create = vi.fn();

  const result = await dispatchAndStartWorkboardCards({
    store,
    subagent: { run },
    worktrees: {
      resolveCheckoutRoot: vi.fn(),
      create,
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    },
    options: { maxStarts: 1, materializeWorktree: true, workspaceAccess: caller },
  });

  expect(result).toMatchObject({ started: [], startFailures: [{ cardId: card.id }] });
  expect(result.startFailures[0]?.error.includes("--admin")).toBe(hint);
  expect(result.startFailures[0]?.error.includes("operator.admin")).toBe(hint);
  expect(run).not.toHaveBeenCalled();
  expect(create).not.toHaveBeenCalled();
  await expect(store.get(card.id)).resolves.toEqual(card);
});

it("does not classify arbitrary error prose as an admin-recoverable refusal", async () => {
  const { store, card, run } = await setup(fullHostAccess);
  const message = "workspace path is outside the caller's allowed workspaces.";

  const result = await dispatchAndStartWorkboardCards({
    store,
    subagent: { run },
    options: {
      maxStarts: 1,
      workspaceAccess,
      resolveAgentWorkspace: () => {
        throw new Error(message);
      },
    },
  });

  expect(result.startFailures).toEqual([{ cardId: card.id, title: card.title, error: message }]);
  expect(run).not.toHaveBeenCalled();
  await expect(store.get(card.id)).resolves.toEqual(card);
});
