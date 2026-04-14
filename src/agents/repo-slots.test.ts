import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepoSlotBranchName,
  ensureRepoSlot,
  listRepoSlots,
  removeRepoSlot,
  resetRepoSlot,
} from "./repo-slots.js";

function git(args: string[], cwd: string) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initRepo(root: string) {
  fs.mkdirSync(root, { recursive: true });
  git(["init", "-q"], root);
  git(["config", "user.name", "OpenClaw Tests"], root);
  git(["config", "user.email", "tests@example.com"], root);
  fs.writeFileSync(path.join(root, "note.txt"), "base\n", "utf8");
  git(["add", "note.txt"], root);
  git(["commit", "-qm", "base"], root);
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("repo slots", () => {
  it("creates, lists, resets, and removes isolated repo slots", async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-repo-slots-"));
    tempDirs.push(tempRoot);
    const repoRoot = path.join(tempRoot, "canonical");
    const stateDir = path.join(tempRoot, "state");
    initRepo(repoRoot);

    const ensured = await ensureRepoSlot({
      repoPath: repoRoot,
      slot: "alpha",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });

    expect(ensured.created).toBe(true);
    expect(fs.existsSync(path.join(ensured.record.workspaceDir, ".git"))).toBe(true);
    expect(ensured.record.workspaceDir).not.toBe(repoRoot);
    expect(ensured.record.branch).toBe(buildRepoSlotBranchName("alpha"));
    expect(git(["branch", "--show-current"], ensured.record.workspaceDir)).toBe(
      buildRepoSlotBranchName("alpha"),
    );

    const listed = await listRepoSlots({ ...process.env, OPENCLAW_STATE_DIR: stateDir });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.slot).toBe("alpha");
    expect(listed[0]?.branch).toBe(buildRepoSlotBranchName("alpha"));

    fs.writeFileSync(path.join(ensured.record.workspaceDir, "scratch.txt"), "temp\n", "utf8");
    fs.writeFileSync(path.join(ensured.record.workspaceDir, "note.txt"), "changed\n", "utf8");

    const reset = await resetRepoSlot({
      repoPath: repoRoot,
      slot: "alpha",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    expect(reset.slot).toBe("alpha");
    expect(reset.branch).toBe(buildRepoSlotBranchName("alpha"));
    expect(fs.existsSync(path.join(reset.workspaceDir, "scratch.txt"))).toBe(false);
    expect(fs.readFileSync(path.join(reset.workspaceDir, "note.txt"), "utf8")).toBe("base\n");
    expect(git(["branch", "--show-current"], reset.workspaceDir)).toBe(
      buildRepoSlotBranchName("alpha"),
    );

    const removed = await removeRepoSlot({
      repoPath: repoRoot,
      slot: "alpha",
      env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
    });
    expect(removed.removed).toBe(true);
    expect(fs.existsSync(reset.workspaceDir)).toBe(false);
  });
});
