import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cleanupWorkboardRunWorktree } from "./dispatcher-workspace.js";
import type { PersistedWorkboardCard, WorkboardKeyedStore } from "./persistence-types.js";
import { WorkboardStore } from "./store.js";

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

async function createCleanupCase(params: {
  workspacePath: string;
  artifactPath: string;
  runId: string;
}) {
  const store = new WorkboardStore(createMemoryStore());
  const card = await store.create({
    title: "Artifact-producing worker",
    status: "ready",
    workspace: { kind: "worktree", path: params.workspacePath, branch: "main" },
    workspaceAccess: { unrestricted: true },
  });
  await store.update(card.id, { runId: params.runId });
  await store.addArtifact(card.id, { path: params.artifactPath });
  return {
    card,
    store,
    worktrees: {
      release: vi.fn(),
      removeIfLossless: vi.fn().mockResolvedValue(true),
    },
  };
}

describe("cleanupWorkboardRunWorktree", () => {
  it("preserves managed worktrees referenced by card artifacts", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workboard-artifact-"));
    try {
      const workspacePath = path.join(root, "workspace");
      await fs.mkdir(workspacePath);
      const { store, worktrees } = await createCleanupCase({
        workspacePath,
        artifactPath: "dist/report.txt",
        runId: "run-artifact",
      });

      await cleanupWorkboardRunWorktree({ store, worktrees, runId: "run-artifact" });

      expect(worktrees.release).toHaveBeenCalledWith({ path: workspacePath });
      expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves managed worktrees reached through artifact path aliases", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workboard-artifact-"));
    try {
      const workspacePath = path.join(root, "workspace");
      const aliasPath = path.join(root, "artifact-alias");
      await fs.mkdir(workspacePath);
      await fs.writeFile(path.join(workspacePath, "report.txt"), "report\n");
      await fs.symlink(workspacePath, aliasPath, process.platform === "win32" ? "junction" : "dir");
      const { store, worktrees } = await createCleanupCase({
        workspacePath,
        artifactPath: path.join(aliasPath, "report.txt"),
        runId: "run-aliased-artifact",
      });

      await cleanupWorkboardRunWorktree({
        store,
        worktrees,
        runId: "run-aliased-artifact",
      });

      expect(worktrees.release).toHaveBeenCalledWith({ path: workspacePath });
      expect(worktrees.removeIfLossless).not.toHaveBeenCalled();
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans managed worktrees when an in-worktree artifact alias resolves outside", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workboard-artifact-"));
    try {
      const workspacePath = path.join(root, "workspace");
      const outsidePath = path.join(root, "outside");
      const aliasPath = path.join(workspacePath, "artifact-alias");
      await fs.mkdir(workspacePath);
      await fs.mkdir(outsidePath);
      await fs.writeFile(path.join(outsidePath, "report.txt"), "report\n");
      await fs.symlink(outsidePath, aliasPath, process.platform === "win32" ? "junction" : "dir");
      const { card, store, worktrees } = await createCleanupCase({
        workspacePath,
        artifactPath: path.join("artifact-alias", "report.txt"),
        runId: "run-escaping-artifact",
      });

      await cleanupWorkboardRunWorktree({
        store,
        worktrees,
        runId: "run-escaping-artifact",
      });

      expect(worktrees.release).not.toHaveBeenCalled();
      expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
        path: workspacePath,
        ownerKind: "workboard",
        ownerId: card.id,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cleans managed worktrees when card artifacts resolve outside them", async () => {
    const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workboard-artifact-"));
    try {
      const workspacePath = path.join(root, "workspace");
      await fs.mkdir(workspacePath);
      const { card, store, worktrees } = await createCleanupCase({
        workspacePath,
        artifactPath: "../shared/report.txt",
        runId: "run-external-artifact",
      });

      await cleanupWorkboardRunWorktree({
        store,
        worktrees,
        runId: "run-external-artifact",
      });

      expect(worktrees.removeIfLossless).toHaveBeenCalledWith({
        path: workspacePath,
        ownerKind: "workboard",
        ownerId: card.id,
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
