import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDLE_GC_MS, ManagedWorktreeService } from "../../../src/agents/worktrees/service.js";
import { closeOpenClawStateDatabaseForTest } from "../../../src/state/openclaw-state-db.js";
import { withWorkboardArtifactRetention } from "./artifact-retention.js";
import { cleanupWorkboardRunWorktree } from "./dispatcher-workspace.js";
import { createWorkboardSqliteStores } from "./sqlite-store.js";
import { WorkboardStore } from "./store.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

describe("Workboard artifact worktree retention", () => {
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;
  let sqlite: ReturnType<typeof createWorkboardSqliteStores>;
  let store: WorkboardStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "workboard-retention-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await fs.writeFile(path.join(repo, ".gitignore"), "dist/\n");
    await git(repo, "add", "README.md", ".gitignore");
    await git(repo, "commit", "-m", "initial");
    const remote = path.join(root, "remote.git");
    await execFileAsync("git", ["clone", "--bare", repo, remote]);
    await git(repo, "remote", "add", "origin", remote);
    await git(repo, "push", "-u", "origin", "main");
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
    sqlite = createWorkboardSqliteStores({ env });
    const cards = withWorkboardArtifactRetention(sqlite.cards, {
      setRetentionClaim: async (params) =>
        service.setRetentionClaimByPath(
          params.path,
          { ownerKind: params.ownerKind, ownerId: params.ownerId },
          { claimId: params.claimId, active: params.active },
        ),
    });
    store = new WorkboardStore(cards, {
      boards: sqlite.boards,
      subscriptions: sqlite.subscriptions,
      attachments: sqlite.attachments,
      dataVersion: sqlite.dataVersion,
    });
  });

  afterEach(async () => {
    sqlite.close();
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function createCardWorktree(name: string) {
    const card = await store.create({
      title: name,
      status: "ready",
      runId: `run-${name}`,
    });
    const worktree = await service.create({
      repoRoot: repo,
      name,
      ownerKind: "workboard",
      ownerId: card.id,
    });
    await service.acquire(worktree.id);
    await store.update(card.id, {
      workspace: { kind: "worktree", path: worktree.path, branch: worktree.branch },
      workspaceAccess: { unrestricted: true },
    });
    return { card, worktree };
  }

  function runtimeWorktrees(activeService = service) {
    return {
      release: async ({ path: worktreePath }: { path: string }) => {
        await activeService.releaseByPath(worktreePath);
      },
      removeIfLossless: async (params: { path: string; ownerKind: "workboard"; ownerId: string }) =>
        await activeService.removeIfLosslessByPath(params.path, {
          ownerKind: params.ownerKind,
          ownerId: params.ownerId,
        }),
    };
  }

  it("persists an aliased local artifact claim until the reference is externalized", async () => {
    const { card, worktree } = await createCardWorktree("aliased-artifact");
    const artifactDir = path.join(worktree.path, "dist");
    const alias = path.join(root, "artifact-alias");
    await fs.mkdir(artifactDir);
    await fs.writeFile(path.join(artifactDir, "report.txt"), "report\n");
    await fs.symlink(worktree.path, alias, process.platform === "win32" ? "junction" : "dir");
    await store.addArtifact(card.id, { path: path.join(alias, "dist", "report.txt") });
    expect((await sqlite.cards.lookup(card.id))?.card.metadata?.artifacts).toHaveLength(1);

    const restarted = new ManagedWorktreeService({ env, now: () => now });
    await cleanupWorkboardRunWorktree({
      store,
      worktrees: runtimeWorktrees(restarted),
      runId: `run-aliased-artifact`,
    });
    await expect(fs.stat(worktree.path)).resolves.toBeDefined();
    now += IDLE_GC_MS + 1;
    expect((await restarted.gc()).removed).toEqual([]);
    expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([]);
    expect((await restarted.gc({ limits: { maxTotalSizeBytes: 1 } })).removed).toEqual([]);

    const persisted = await store.get(card.id);
    await store.update(card.id, {
      metadata: {
        ...persisted?.metadata,
        artifacts: [{ url: "https://example.invalid/report.txt" }],
      },
    });
    expect((await restarted.gc({ limits: { maxCount: 0 } })).removed).toEqual([worktree.id]);
    await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not claim URL-only or outside-worktree artifacts", async () => {
    for (const [name, artifact] of [
      ["url-artifact", { url: "https://example.invalid/report.txt" }],
      ["outside-artifact", { path: path.join(root, "shared", "report.txt") }],
    ] as const) {
      const { card, worktree } = await createCardWorktree(name);
      await store.addArtifact(card.id, artifact);
      await cleanupWorkboardRunWorktree({
        store,
        worktrees: runtimeWorktrees(),
        runId: `run-${name}`,
      });
      await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("releases the claim after the card is archived", async () => {
    const { card, worktree } = await createCardWorktree("archived-artifact");
    await fs.mkdir(path.join(worktree.path, "dist"));
    await fs.writeFile(path.join(worktree.path, "dist", "report.txt"), "report\n");
    await store.addArtifact(card.id, { path: "dist/report.txt" });
    await store.archive(card.id, true);

    await cleanupWorkboardRunWorktree({
      store,
      worktrees: runtimeWorktrees(),
      runId: "run-archived-artifact",
    });

    await expect(fs.stat(worktree.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
