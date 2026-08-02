import { describe, expect, it, vi } from "vitest";
import { cleanupWorkboardRunWorktree } from "./dispatcher-workspace.js";
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

describe("cleanupWorkboardRunWorktree", () => {
  it("releases the run lock before requesting lossless cleanup", async () => {
    const store = new WorkboardStore(createMemoryStore());
    const card = await store.create({
      title: "Artifact-producing worker",
      status: "ready",
      runId: "run-artifact",
      workspace: { kind: "worktree", path: "/tmp/worktree", branch: "main" },
      workspaceAccess: { unrestricted: true },
    });
    const worktrees = {
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(false),
    };

    await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-artifact" });

    expect(worktrees.release).toHaveBeenCalledWith({ path: "/tmp/worktree" });
    expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
      path: "/tmp/worktree",
      ownerKind: "workboard",
      ownerId: card.id,
    });
    expect(worktrees.release.mock.invocationCallOrder[0]!).toBeLessThan(
      worktrees.removeIfLossless.mock.invocationCallOrder[0]!,
    );
  });

  it("ignores runs without a persisted managed-worktree workspace", async () => {
    const store = new WorkboardStore(createMemoryStore());
    await store.create({ title: "No worktree", status: "ready", runId: "run-local" });
    const worktrees = {
      release: vi.fn(),
      removeIfLossless: vi.fn(),
    };

    await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-local" });

    expect(worktrees.release).not.toHaveBeenCalled();
    expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
  });
});
