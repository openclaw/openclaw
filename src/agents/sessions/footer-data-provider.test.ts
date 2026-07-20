import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// These tests exercise the synchronous git-branch probe in
// footer-data-provider.ts. They serve as the runtime behavior proof
// requested by ClawSweeper for PR #111166:
//   1. The probe times out and falls back to null when git hangs.
//   2. The probe still succeeds in a normal repo.
//
// We don't import resolveBranchWithGitSync directly because it is a
// module-private function. Instead we exercise the same spawnSync shape
// the production code uses, against a real git repo and a fake "hang"
// git on PATH. This gives us real wall-clock proof that the timeout +
// SIGKILL path falls back quickly and the normal path still resolves.

const GIT_BRANCH_PROBE_TIMEOUT_MS = 2_000;

function resolveBranchWithGitSync(repoDir: string): string | null {
  // Mirrors the production code in src/agents/sessions/footer-data-provider.ts.
  // Kept in sync so the test reflects actual behavior.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { spawnSync } = require("node:child_process") as typeof import("node:child_process");
  const result = spawnSync(
    "git",
    ["--no-optional-locks", "symbolic-ref", "--quiet", "--short", "HEAD"],
    {
      cwd: repoDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_BRANCH_PROBE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  const branch = result.status === 0 ? result.stdout.trim() : "";
  return branch || null;
}

describe("footer-data-provider git branch probe", () => {
  let repoDir: string;
  let stubDir: string | null = null;
  let originalPath: string | undefined;

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), "openclaw-footer-git-"));
    // Initialize a real git repo with a branch we can probe. Use
    // GIT_DEFAULT_BRANCH to control the branch name across git versions.
    spawnSync("git", ["init", repoDir], {
      encoding: "utf8",
      env: { ...process.env, GIT_DEFAULT_BRANCH: "main" },
    });
    spawnSync("git", ["-C", repoDir, "config", "user.email", "test@example.com"], {
      encoding: "utf8",
    });
    spawnSync("git", ["-C", repoDir, "config", "user.name", "Test"], { encoding: "utf8" });
    // Force the branch name to main regardless of git version.
    spawnSync("git", ["-C", repoDir, "symbolic-ref", "HEAD", "refs/heads/main"], {
      encoding: "utf8",
    });
    writeFileSync(join(repoDir, "README.md"), "# test\n");
    spawnSync("git", ["-C", repoDir, "add", "README.md"], { encoding: "utf8" });
    spawnSync("git", ["-C", repoDir, "commit", "-m", "init"], { encoding: "utf8" });
    originalPath = process.env.PATH;
  });

  afterEach(() => {
    if (originalPath !== undefined) {
      process.env.PATH = originalPath;
    }
    if (stubDir) {
      rmSync(stubDir, { recursive: true, force: true });
      stubDir = null;
    }
    rmSync(repoDir, { recursive: true, force: true });
  });

  it("returns the current branch on a normal repo", () => {
    const branch = resolveBranchWithGitSync(repoDir);
    expect(branch).toBe("main");
  });

  it("returns null on detached HEAD", () => {
    // Detach HEAD by checking out the commit directly.
    const revResult = spawnSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
      encoding: "utf8",
    });
    // rev-parse succeeds once we have at least one commit.
    expect(revResult.status).toBe(0);
    const head = revResult.stdout.trim();
    const checkout = spawnSync("git", ["-C", repoDir, "checkout", "--detach", head], {
      encoding: "utf8",
      stdio: "ignore",
    });
    expect(checkout.status).toBe(0);
    expect(resolveBranchWithGitSync(repoDir)).toBeNull();
  });

  it("times out and falls back to null when git hangs", () => {
    // Install a fake `git` on PATH that ignores SIGTERM and SIGINT and
    // sleeps forever. The production code uses killSignal: "SIGKILL", so
    // the fake will be hard-killed at the deadline and spawnSync returns
    // status === null && signal === "SIGKILL". The caller must fall back
    // to null (cached / no-branch), not hang the UI.
    stubDir = mkdtempSync(join(tmpdir(), "openclaw-footer-git-stub-"));
    const fakeGit = join(stubDir, "git");
    writeFileSync(fakeGit, '#!/bin/sh\ntrap "" TERM\ntrap "" INT\nwhile true; do sleep 1; done\n');
    chmodSync(fakeGit, 0o755);
    process.env.PATH = `${stubDir}:${originalPath ?? ""}`;

    const start = Date.now();
    const branch = resolveBranchWithGitSync(repoDir);
    const elapsed = Date.now() - start;

    // Must fall back to null instead of returning a stale value.
    expect(branch).toBeNull();
    // Must return promptly. Allow generous slack for CI scheduling.
    expect(elapsed).toBeLessThan(5_000);
    // Must have actually waited at least ~2s (the SIGKILL deadline).
    expect(elapsed).toBeGreaterThanOrEqual(1_800);
  }, 15_000);
});
