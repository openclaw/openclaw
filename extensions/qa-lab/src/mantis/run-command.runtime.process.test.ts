import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { useAutoCleanupTempDirTracker } from "openclaw/plugin-sdk/test-env";
import { afterEach, beforeEach, expect, it } from "vitest";
import { removeMantisWorktree } from "./run-cleanup.runtime.js";
import {
  defaultMantisCommandRunner,
  MantisCommandCleanupError,
  type MantisCommandRunner,
} from "./run-command.runtime.js";
import { captureMantisDirectoryOwnership } from "./run-directory.runtime.js";
import { runMantisBeforeAfter, type MantisBeforeAfterOptions } from "./run.runtime.js";
import { successfulCommandResult } from "./run.test-support.js";

const roots = useAutoCleanupTempDirTracker(afterEach);
let repoRoot: string;
let removals: number[];
const outputDir = ".artifacts/run";
const worktrees = () => fs.readdir(path.join(repoRoot, `${outputDir}.worktrees`));
const readError = () => fs.readFile(path.join(repoRoot, outputDir, "error.txt"), "utf8");
beforeEach(async () => {
  repoRoot = await fs.realpath(roots.make("mantis-command-owner-"));
  removals = [];
});
function runFixture(
  qa: () => ReturnType<MantisCommandRunner>,
  options: MantisBeforeAfterOptions = {},
) {
  return runMantisBeforeAfter({
    repoRoot,
    outputDir,
    skipBuild: true,
    skipInstall: true,
    ...options,
    commandRunner: async (_command, args, execution) => {
      if (execution.stage === "qa") {
        return qa();
      }
      if (args[1] === "remove") {
        removals.push(execution.timeoutMs);
        await fs.rm(execution.cwd, { recursive: true, force: true });
      }
      return successfulCommandResult();
    },
  });
}

it.skipIf(process.platform === "win32")(
  "settles successful command descendants before returning ownership to worktree cleanup",
  async () => {
    const pidFile = path.join(repoRoot, "descendant.pid");
    const childScript = `
      require("node:fs").writeFileSync(process.argv[1], String(process.pid));
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);
    `;
    const parentScript = `
      const fs = require("node:fs");
      const { spawn } = require("node:child_process");
      spawn(process.execPath, ["-e", process.argv[1], process.argv[2]], { stdio: "ignore" }).unref();
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
        { cwd: repoRoot, env: process.env, stage: "qa", timeoutMs: 5000 },
      );
      descendantPid = Number(await fs.readFile(pidFile, "utf8"));
      expect(result.code).toBe(0);
      if (process.platform === "linux") {
        const state = await fs.readFile(`/proc/${descendantPid}/stat`, "utf8").then(
          (stat) => stat.slice(stat.lastIndexOf(")") + 2),
          (error: unknown) => {
            if (!hasNodeErrorCode(error, "ENOENT")) {
              throw error;
            }
            return "Z";
          },
        );
        expect(state).toMatch(/^Z/u);
      } else {
        expect(() => process.kill(Number(descendantPid), 0)).toThrow();
      }
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
    const run = runFixture(async () => {
      if (mode === "typed") {
        throw new MantisCommandCleanupError("unsupported ownership", undefined);
      }
      if (mode === "thrown") {
        throw Object.assign(new Error("command output failed"), { cleanup: "uncertain" });
      }
      return { ...successfulCommandResult(), cleanup: "uncertain" };
    });
    await expect(run).rejects.toBeInstanceOf(Error);
    expect(removals).toEqual([]);
    expect(await worktrees()).toEqual([expect.stringMatching(/^baseline-/u)]);
    await expect(readError()).resolves.toContain("Mantis preserved");
  },
);

it("retains uncertain Git removal without starting another verification command", async () => {
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
    const controller = new AbortController();
    const run = runFixture(
      async () => {
        controller.abort(new Error("interrupted fixture"));
        await sleep(exhausted ? 240 : 80);
        throw controller.signal.reason;
      },
      {
        signal: controller.signal,
        commandTimeouts: { "worktree-cleanup": 200 },
      },
    );
    await expect(run).rejects.toBeInstanceOf(Error);
    if (exhausted) {
      expect(removals).toEqual([]);
      expect(await worktrees()).toEqual([expect.stringMatching(/^baseline-/u)]);
      await expect(readError()).resolves.toContain("interrupt cleanup budget exhausted");
    } else {
      expect(removals).toHaveLength(1);
      expect(removals[0]).toBeGreaterThan(0);
      expect(removals[0]).toBeLessThan(150);
      expect(await worktrees()).toEqual([]);
    }
  },
);
