import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

describe("Mantis worktree cleanup", () => {
  let repoRoot: string;
  let worktreeRoot: string;
  let worktreeDir: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-cleanup-"));
    worktreeRoot = path.join(repoRoot, ".artifacts", "run.worktrees");
    worktreeDir = path.join(worktreeRoot, "baseline-generation-test");
    await fs.mkdir(worktreeDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  function captureOwnership() {
    return captureMantisDirectoryOwnership({ directoryPath: worktreeDir, repoRoot });
  }

  function removeWorktree(
    runner: MantisCommandRunner,
    ownership: MantisDirectoryOwnership,
    timeoutMs = commandTimeouts["worktree-cleanup"],
  ) {
    return removeMantisWorktree({
      commandTimeouts: { ...commandTimeouts, "worktree-cleanup": timeoutMs },
      lane: "baseline",
      ownership,
      repoRoot,
      runner,
      worktreeDir,
    });
  }

  it("preserves a replacement introduced after the ownership check", async () => {
    const ownership = await captureOwnership();
    const displacedPath = `${worktreeDir}-displaced`;
    const sentinelPath = path.join(worktreeDir, "preserve-me.txt");
    const runner = vi.fn(async (_command: string, args: readonly string[]) => {
      if (args[1] === "remove") {
        await fs.rename(worktreeDir, displacedPath);
        await fs.mkdir(worktreeDir);
        await fs.writeFile(sentinelPath, "replacement", "utf8");
        return failedCommandResult();
      }
      return successfulCommandResult();
    });

    await expect(removeWorktree(runner, ownership)).rejects.toThrow(
      "Mantis preserved the path because Git no longer owns it",
    );

    await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("replacement");
    await expect(fs.stat(displacedPath)).resolves.toBeDefined();
  });

  it("preserves a worktree when its Windows ownership receipt has unknown targetInode", async () => {
    const ownership = await captureOwnership();
    const sentinelPath = path.join(worktreeDir, "preserve-me.txt");
    await fs.writeFile(sentinelPath, "preserve", "utf8");
    const runner = vi.fn(async () => successfulCommandResult());
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    try {
      await expect(removeWorktree(runner, { ...ownership, targetInode: 0n })).rejects.toThrow(
        "replaced before cleanup",
      );
      expect(runner).not.toHaveBeenCalled();
      await expect(fs.readFile(sentinelPath, "utf8")).resolves.toBe("preserve");
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
  });

  it("attributes a shared legacy deadline expiry to the active candidate lane", async () => {
    const outputDir = path.join(repoRoot, ".artifacts", "legacy-candidate-deadline");
    const legacyRoot = path.join(outputDir, "worktrees");
    const baselineDir = path.join(legacyRoot, "baseline");
    const candidateDir = path.join(legacyRoot, "candidate");
    await Promise.all([
      fs.mkdir(baselineDir, { recursive: true }),
      fs.mkdir(candidateDir, { recursive: true }),
    ]);
    const registeredPaths = new Set([baselineDir, candidateDir]);
    let nowMs = 0;
    const now = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
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

    try {
      await expect(
        removeLegacyMantisWorktrees({
          commandTimeouts: { ...commandTimeouts, "worktree-cleanup": 100 },
          outputDir,
          repoRoot,
          runner,
        }),
      ).rejects.toThrow("candidate worktree cleanup exceeded its total 100ms deadline");
    } finally {
      now.mockRestore();
    }
  });
});
