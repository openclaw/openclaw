import fs from "node:fs/promises";
import path from "node:path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { removeLegacyMantisWorktrees, removeMantisWorktree } from "./run-cleanup.runtime.js";
import type { MantisCommandRunner } from "./run-command.runtime.js";
import {
  captureMantisDirectoryOwnership,
  type MantisDirectoryOwnership,
} from "./run-directory.runtime.js";
import {
  failedCommandResult,
  successfulCommandResult,
  worktreeListOutput,
} from "./run.test-support.js";

const commandTimeouts = {
  build: 1_000,
  install: 1_000,
  qa: 1_000,
  "worktree-add": 1_000,
  "worktree-cleanup": 1_000,
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("Mantis worktree cleanup", () => {
  let repoRoot: string;
  let worktreeDir: string;
  let ownership: MantisDirectoryOwnership;
  let sentinelPath: string;

  beforeEach(async () => {
    repoRoot = tempDirs.make("mantis-cleanup-");
    worktreeDir = path.join(repoRoot, ".artifacts", "run.worktrees", "baseline-generation-test");
    await fs.mkdir(worktreeDir, { recursive: true });
    ownership = await captureMantisDirectoryOwnership({ directoryPath: worktreeDir, repoRoot });
    sentinelPath = path.join(worktreeDir, "preserve-me.txt");
  });
  afterEach(() => vi.restoreAllMocks());

  function removeWorktree(runner: MantisCommandRunner, receipt = ownership) {
    return removeMantisWorktree({
      commandTimeouts,
      lane: "baseline",
      ownership: receipt,
      repoRoot,
      runner,
      worktreeDir,
    });
  }

  it("preserves a replacement introduced after the ownership check", async () => {
    const displacedPath = `${worktreeDir}-displaced`;
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "remove") {
        await fs.rename(worktreeDir, displacedPath);
        await fs.mkdir(worktreeDir);
        await fs.writeFile(sentinelPath, "replacement", "utf8");
        return failedCommandResult();
      }
      return successfulCommandResult();
    });

    await expect(removeWorktree(runner)).rejects.toThrow(
      "Mantis preserved the path because Git no longer owns it",
    );

    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.stat(displacedPath)).resolves.toBeDefined();
  });

  it("preserves a worktree with an unknown targetInode before invoking Git", async () => {
    await fs.writeFile(sentinelPath, "preserve", "utf8");
    const runner = vi.fn(async () => successfulCommandResult());
    await expect(removeWorktree(runner, { ...ownership, targetInode: 0n })).rejects.toThrow(
      "replaced before cleanup",
    );
    expect(runner).not.toHaveBeenCalled();
    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("preserve");
  });

  it("attributes a shared legacy deadline expiry to the active candidate lane", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "legacy-candidate-deadline");
    const registeredPaths = new Set(
      ["baseline", "candidate"].map((lane) => path.join(outputDir, "worktrees", lane)),
    );
    await Promise.all([...registeredPaths].map((dir) => fs.mkdir(dir, { recursive: true })));
    let nowMs = 0;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    const runner = vi.fn(async (_command: string, args: readonly string[], execution) => {
      if (args[1] === "list") {
        return successfulCommandResult(
          [...registeredPaths].map((entry) => worktreeListOutput(entry)).join(""),
        );
      }
      if (args[1] === "remove") {
        nowMs += 60;
        registeredPaths.delete(execution.cwd);
        await fs.rm(execution.cwd, { force: true, recursive: true });
        return successfulCommandResult();
      }
      throw new Error(`unexpected git command: ${args.join(" ")}`);
    });

    await expect(
      removeLegacyMantisWorktrees({
        commandTimeouts: { ...commandTimeouts, "worktree-cleanup": 100 },
        outputDir,
        repoRoot,
        runner,
      }),
    ).rejects.toThrow("candidate worktree cleanup exceeded its total 100ms deadline");
  });
});
