import { describe, expect, it, vi } from "vitest";
import { dispatchAndStartWorkboardCards } from "./dispatcher.js";
import { createWorkboardSqliteTestStore } from "./test/sqlite-store.js";
import type { WorkboardWorkspaceAccess } from "./workspace-access.js";

const fullHostAccess: WorkboardWorkspaceAccess = { unrestricted: true };
const workspaceAccess: WorkboardWorkspaceAccess = {
  unrestricted: false,
  roots: ["/workspace"],
  writable: true,
};
const readOnlyAccess: WorkboardWorkspaceAccess = {
  unrestricted: false,
  roots: ["/workspace"],
  writable: false,
};

describe("Workboard workspace refusal diagnostics", () => {
  it.each([
    {
      name: "host-authorized card",
      persisted: fullHostAccess,
      caller: workspaceAccess,
      hint: true,
    },
    { name: "unknown card authority", persisted: undefined, caller: workspaceAccess, hint: false },
    {
      name: "workspace-bound card",
      persisted: workspaceAccess,
      caller: workspaceAccess,
      hint: false,
    },
    {
      name: "admin caller with restricted card",
      persisted: workspaceAccess,
      caller: fullHostAccess,
      hint: false,
    },
    { name: "read-only caller", persisted: fullHostAccess, caller: readOnlyAccess, hint: false },
  ])("suggests admin only when it can address $name", async ({ persisted, caller, hint }) => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Outside checkout",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
      workspaceAccess: persisted,
    });
    const run = vi.fn();
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

    expect(result.started).toEqual([]);
    expect(result.startFailures).toHaveLength(1);
    expect(result.startFailures[0]?.cardId).toBe(card.id);
    expect(result.startFailures[0]?.error.includes("--admin")).toBe(hint);
    expect(result.startFailures[0]?.error.includes("operator.admin")).toBe(hint);
    expect(run).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    await expect(store.get(card.id)).resolves.toEqual(card);
  });

  it("does not classify arbitrary error prose as an admin-recoverable refusal", async () => {
    const store = createWorkboardSqliteTestStore();
    const card = await store.create({
      title: "Failed workspace resolution",
      status: "ready",
      workspace: { kind: "worktree", path: "/repo" },
      workspaceAccess: fullHostAccess,
    });
    const run = vi.fn();
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
});
