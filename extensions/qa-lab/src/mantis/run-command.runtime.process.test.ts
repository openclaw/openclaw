import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, expect, it } from "vitest";
import { removeMantisWorktree } from "./run-cleanup.runtime.js";
import { defaultMantisCommandRunner, MantisCommandCleanupError } from "./run-command.runtime.js";
import { captureMantisDirectoryOwnership } from "./run-directory.runtime.js";
import { runMantisBeforeAfter } from "./run.runtime.js";
import { successfulCommandResult } from "./run.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
const makeRoot = (prefix: string) => fs.realpath(roots.make(prefix));
function runBeforeAfter(options: Parameters<typeof runMantisBeforeAfter>[0]) {
  return runMantisBeforeAfter({ skipBuild: true, skipInstall: true, ...options });
}

it.skipIf(process.platform === "win32")(
  "settles successful command descendants before returning ownership to worktree cleanup",
  async () => {
    const cwd = await makeRoot("mantis-command-owner-");
    const pidFile = path.join(cwd, "descendant.pid");
    const childScript = `
      const fs = require("node:fs");
      fs.writeFileSync(process.argv[1], String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      const child = spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" });
      child.unref();
      const ready = setInterval(() => {
        if (fs.existsSync(process.argv[2])) {
          clearInterval(ready);
        }
      }, 5);
    `;
    let descendantPid: number | undefined;
    try {
      const result = await defaultMantisCommandRunner(
        process.execPath,
        ["-e", parentScript, childScript, pidFile],
        { cwd, env: process.env, stage: "qa", timeoutMs: 5000 },
      );
      descendantPid = Number(await fs.readFile(pidFile, "utf8"));
      expect(result.code).toBe(0);
      let running = true;
      try {
        const stat = await fs.readFile(`/proc/${descendantPid}/stat`, "utf8");
        running = !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
      } catch (error) {
        if (process.platform !== "linux") {
          try {
            process.kill(descendantPid, 0);
          } catch {
            running = false;
          }
        } else if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          error.code === "ENOENT"
        ) {
          running = false;
        } else {
          throw error;
        }
      }
      expect(running).toBe(false);
    } finally {
      descendantPid ??= Number(await fs.readFile(pidFile, "utf8").catch(() => "0"));
      if (Number.isInteger(descendantPid) && descendantPid > 0) {
        try {
          process.kill(descendantPid, "SIGKILL");
        } catch {
          /* Already retired. */
        }
      }
    }
  },
  10000,
);

it.each(["returned", "thrown", "typed"])(
  "retains the worktree when command cleanup is %s as uncertain",
  async (mode) => {
    const repoRoot = await makeRoot("mantis-uncertain-owner-");
    const removals: string[] = [];
    const result = successfulCommandResult();
    const run = runBeforeAfter({
      repoRoot,
      outputDir: ".artifacts/uncertain",
      commandRunner: async (_command, args, execution) => {
        if (execution.stage === "qa") {
          if (mode === "typed") {
            throw new MantisCommandCleanupError("unsupported ownership", undefined);
          }
          if (mode === "thrown") {
            throw Object.assign(new Error("command output failed"), { cleanup: "uncertain" });
          }
          return { ...result, cleanup: "uncertain" as const };
        }
        if (args[1] === "remove") {
          removals.push(execution.cwd);
          await fs.rm(execution.cwd, { recursive: true, force: true });
        }
        return result;
      },
    });
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(removals).toEqual([]);
    const retained = await fs.readdir(path.join(repoRoot, ".artifacts/uncertain.worktrees"));
    expect(retained).toEqual([expect.stringMatching(/^baseline-/u)]);
    await expect(
      fs.readFile(path.join(repoRoot, ".artifacts/uncertain/error.txt"), "utf8"),
    ).resolves.toContain("Mantis preserved");
  },
);

it("retains uncertain Git removal without starting another verification command", async () => {
  const repoRoot = await makeRoot("mantis-git-owner-");
  const worktreeDir = path.join(repoRoot, "worktree");
  await fs.mkdir(worktreeDir);
  const ownership = await captureMantisDirectoryOwnership({ directoryPath: worktreeDir, repoRoot });
  const commands: string[] = [];
  const removal = removeMantisWorktree({
    commandTimeouts: {
      build: 1000,
      install: 1000,
      qa: 1000,
      "worktree-add": 1000,
      "worktree-cleanup": 1000,
    },
    lane: "baseline",
    ownership,
    repoRoot,
    worktreeDir,
    runner: async (_command, args) => {
      commands.push(args[1] ?? "");
      return {
        ...successfulCommandResult(),
        cleanup: args[1] === "remove" ? "uncertain" : "normal",
      };
    },
  });
  await expect(removal).rejects.toThrow("command process cleanup is uncertain");
  expect(commands).toEqual(["remove"]);
  await expect(fs.stat(worktreeDir)).resolves.toBeDefined();
});

it.each([false, true])(
  "charges interrupt settlement against cleanup budget (exhausted: %s)",
  async (exhausted) => {
    const repoRoot = await makeRoot("mantis-interrupt-budget-");
    const controller = new AbortController();
    const cleanupTimeouts: number[] = [];
    const run = runBeforeAfter({
      repoRoot,
      outputDir: ".artifacts/budget",
      signal: controller.signal,
      commandTimeouts: { "worktree-cleanup": 200 },
      commandRunner: async (_command, args, execution) => {
        if (execution.stage === "qa") {
          controller.abort(new Error("interrupted fixture"));
          await sleep(exhausted ? 240 : 80);
          throw controller.signal.reason;
        }
        if (args[1] === "remove") {
          cleanupTimeouts.push(execution.timeoutMs);
          await fs.rm(execution.cwd, { recursive: true, force: true });
        }
        return successfulCommandResult();
      },
    });
    await expect(run).rejects.toBeInstanceOf(Error);
    if (exhausted) {
      expect(cleanupTimeouts).toEqual([]);
      expect(await fs.readdir(path.join(repoRoot, ".artifacts/budget.worktrees"))).toEqual([
        expect.stringMatching(/^baseline-/u),
      ]);
      await expect(
        fs.readFile(path.join(repoRoot, ".artifacts/budget/error.txt"), "utf8"),
      ).resolves.toContain("interrupt cleanup budget exhausted");
    } else {
      expect(cleanupTimeouts).toHaveLength(1);
      expect(cleanupTimeouts[0]).toBeGreaterThan(0);
      expect(cleanupTimeouts[0]).toBeLessThan(150);
      expect(await fs.readdir(path.join(repoRoot, ".artifacts/budget.worktrees"))).toEqual([]);
    }
  },
);
