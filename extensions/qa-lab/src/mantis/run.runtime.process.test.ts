import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { hasNodeErrorCode } from "@openclaw/fs-safe/path";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import {
  fixtureReceiptClientSource,
  openFixtureReceiptChannel,
  type FixtureReceiptChannel,
  withinTest,
} from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { removeLegacyMantisWorktrees, removeMantisWorktree } from "./run-cleanup.runtime.js";
import { defaultMantisCommandRunner } from "./run-command.runtime.js";
import { runMantisBeforeAfter } from "./run.runtime.js";
import { successfulCommandResult, type StubCommandResult } from "./run.test-support.js";

let receipts: FixtureReceiptChannel;
beforeAll(async () => {
  receipts = await openFixtureReceiptChannel();
});
afterAll(async () => {
  await receipts.close();
});

const commandTimeouts = {
  build: 5_000,
  install: 5_000,
  qa: 5_000,
  "worktree-add": 5_000,
  "worktree-cleanup": 5_000,
};

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type SettledRun = { status: "fulfilled" } | { error: unknown; status: "rejected" };

function describeSettledRun(settled: SettledRun) {
  if (settled.status === "fulfilled") {
    return "fulfilled";
  }
  if (settled.error instanceof Error) {
    return `rejected with ${settled.error.name}: ${settled.error.message}`;
  }
  return `rejected with ${String(settled.error)}`;
}

function killKnownProcessPids(pids: ReadonlyArray<number | undefined>) {
  for (const pid of pids) {
    if (pid !== undefined && isProcessRunning(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // process exited between liveness check and SIGKILL
      }
    }
  }
}

async function readPidBeforeSettled(filePath: string, label: string, settled: Promise<SettledRun>) {
  const readPid = async () => {
    const value = await fs.readFile(filePath, "utf8").catch((error: unknown) => {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return "";
      }
      throw error;
    });
    const pid = Number(value);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  };
  // The shell writes its PID before sending; operation settlement can overtake the socket.
  await Promise.race([
    receipts.waitFor(filePath, "ready"),
    settled.then(async (result) => {
      if ((await readPid()) === undefined) {
        throw new Error(
          `Mantis run settled before ${label} pid readiness: ${describeSettledRun(result)}`,
        );
      }
    }),
  ]);
  const pid = await readPid();
  if (pid === undefined) {
    throw new Error(`timeout waiting for pid in ${filePath}`);
  }
  return pid;
}

// Command settlement verifies group death, but its asynchronous adopted-child reaper
// exposes no join for these foreign shell PIDs. Preserve the stronger PID-absence assertion.
async function waitForDead(pid: number, signal: AbortSignal) {
  try {
    while (isProcessRunning(pid)) {
      signal.throwIfAborted();
      await sleep(5, undefined, { signal });
    }
  } catch (error) {
    if (signal.aborted) {
      throw new Error(`process ${pid} still alive`, { cause: error });
    }
    throw error;
  }
}

function shellWord(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function stubbornProcessTreeShellLines(params: {
  descendantPidPath: string;
  outputLine?: string;
  parentPidPath: string;
}) {
  const receipt = (pidPath: string) =>
    `${shellWord(process.execPath)} --input-type=module --eval ${shellWord(
      `${fixtureReceiptClientSource(receipts.endpoint)}\nsendReceipt(${JSON.stringify(pidPath)}, "ready");\nfixtureReceiptSocket.end();`,
    )}`;
  const descendantScript = [
    'printf \'%s\' "$$" > "$1"',
    "trap '' TERM",
    receipt(params.descendantPidPath),
    "while :; do sleep 1; done",
  ].join("\n");
  const outputLoop = params.outputLine
    ? `while :; do printf ${shellWord(`${params.outputLine}\\n`)}; sleep 0.05; done`
    : "while :; do sleep 1; done";
  return [
    `printf '%s' "$$" > ${shellWord(params.parentPidPath)}`,
    `/bin/sh -c ${shellWord(descendantScript)} sh ${shellWord(params.descendantPidPath)} &`,
    "trap '' TERM",
    receipt(params.parentPidPath),
    outputLoop,
  ];
}

async function writeCommandShim(shimPath: string, script: string) {
  // Execute an immutable inode: a concurrent fork can retain a generated script's
  // write descriptor and make direct execution fail with ETXTBSY even after close.
  await fs.writeFile(`${shimPath}.sh`, script, "utf8");
  await fs.symlink(new URL("../../test-fixtures/mantis-command.sh", import.meta.url), shimPath);
}

async function runGit(repoRoot: string, args: readonly string[]) {
  const result = await runCommandWithTimeout(["git", ...args], {
    cwd: repoRoot,
    env: process.env,
    killProcessTree: true,
    timeoutMs: 5_000,
  });
  if (result.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result;
}

async function initializeGitRepo(repoRoot: string) {
  await runGit(repoRoot, ["init"]);
  await fs.writeFile(path.join(repoRoot, "seed.txt"), "seed\n", "utf8");
  await runGit(repoRoot, ["add", "seed.txt"]);
  await runGit(repoRoot, [
    "-c",
    "user.name=Mantis Test",
    "-c",
    "user.email=mantis@example.test",
    "commit",
    "-m",
    "seed",
  ]);
}

async function listGitWorktreePaths(repoRoot: string) {
  const result = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
  return result.stdout
    .split(/\r?\n/u)
    .filter((entry) => entry.startsWith("worktree "))
    .map((entry) => entry.slice("worktree ".length));
}

describe("mantis before/after process runtime", () => {
  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mantis-before-after-process-"));
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { force: true, recursive: true });
  });

  it.skipIf(process.platform === "win32")(
    "leaves only an empty unique directory after Git rejects worktree add",
    async () => {
      await initializeGitRepo(repoRoot);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "invalid-ref");

      await expect(
        runMantisBeforeAfter({
          baseline: "refs/heads/missing-mantis-ref",
          candidate: "HEAD",
          outputDir: ".artifacts/qa-e2e/mantis/invalid-ref",
          repoRoot,
          skipBuild: true,
          skipInstall: true,
        }),
      ).rejects.toThrow("baseline worktree-add failed");

      const preparedEntries = await fs.readdir(`${outputDir}.worktrees`);
      expect(preparedEntries).toEqual([expect.stringMatching(/^baseline-/u)]);
      await expect(
        fs.readdir(path.join(`${outputDir}.worktrees`, preparedEntries[0] as string)),
      ).resolves.toEqual([]);
    },
  );

  it.skipIf(process.platform === "win32")(
    "keeps an owner-bound cwd when its registered path is replaced after identity verification",
    async () => {
      await initializeGitRepo(repoRoot);
      const worktreeDir = path.join(repoRoot, ".artifacts", "owner-bound", "baseline");
      const displacedDir = `${worktreeDir}-displaced`;
      await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
      await runGit(repoRoot, ["worktree", "add", "--detach", "--", worktreeDir, "HEAD"]);
      const ownership = await fs.lstat(worktreeDir, { bigint: true });
      const replaceThenRemoveScript = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const [originalPath, displacedPath] = process.argv.slice(1);
fs.renameSync(originalPath, displacedPath);
fs.mkdirSync(originalPath);
fs.writeFileSync(path.join(originalPath, "replacement.txt"), "replacement");
const result = spawnSync("git", ["worktree", "remove", "--force", "--", "."], { stdio: "inherit" });
process.exit(result.status ?? 1);
`;

      const result = await defaultMantisCommandRunner(
        process.execPath,
        ["--input-type=commonjs", "--eval", replaceThenRemoveScript, worktreeDir, displacedDir],
        {
          cwd: worktreeDir,
          env: process.env,
          expectedCwdIdentity: { dev: ownership.dev, ino: ownership.ino },
          stage: "worktree-cleanup",
          timeoutMs: 5_000,
        },
      );

      expect(result.code).not.toBe(0);
      await expect(fs.readFile(path.join(worktreeDir, "replacement.txt"), "utf8")).resolves.toBe(
        "replacement",
      );
      await expect(fs.lstat(path.join(displacedDir, ".git"))).resolves.toBeDefined();
      expect(await listGitWorktreePaths(repoRoot)).toContain(worktreeDir);
    },
  );

  it.skipIf(process.platform === "win32")(
    "fails closed when a registered worktree checkout path disappears",
    async () => {
      await initializeGitRepo(repoRoot);
      const worktreeDir = path.join(repoRoot, ".artifacts", "missing-worktree", "baseline");
      await fs.mkdir(path.dirname(worktreeDir), { recursive: true });
      await runGit(repoRoot, ["worktree", "add", "--detach", "--", worktreeDir, "HEAD"]);
      await fs.rm(worktreeDir, { force: true, recursive: true });

      await expect(
        removeMantisWorktree({
          commandTimeouts,
          lane: "baseline",
          repoRoot,
          runner: defaultMantisCommandRunner,
          worktreeDir,
        }),
      ).rejects.toThrow("baseline worktree cleanup left registered path");

      expect(await listGitWorktreePaths(repoRoot)).toEqual([repoRoot, worktreeDir]);
      await expect(fs.lstat(worktreeDir)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "migrates only the exact historical worktrees from the legacy output layout",
    async () => {
      await initializeGitRepo(repoRoot);
      const outputDir = path.join(repoRoot, ".artifacts", "legacy-output");
      const legacyRoot = path.join(outputDir, "worktrees");
      const baselineDir = path.join(legacyRoot, "baseline");
      const candidateDir = path.join(legacyRoot, "candidate");
      const unrelatedDir = path.join(legacyRoot, "unrelated-checkout");
      const unrelatedSentinel = path.join(unrelatedDir, "preserve-me.txt");
      await fs.mkdir(legacyRoot, { recursive: true });
      for (const worktreeDir of [baselineDir, candidateDir, unrelatedDir]) {
        await runGit(repoRoot, ["worktree", "add", "--detach", "--", worktreeDir, "HEAD"]);
      }
      await fs.writeFile(unrelatedSentinel, "unrelated", "utf8");

      await expect(
        removeLegacyMantisWorktrees({
          commandTimeouts,
          outputDir,
          repoRoot,
          runner: defaultMantisCommandRunner,
        }),
      ).resolves.toBeUndefined();

      expect(await listGitWorktreePaths(repoRoot)).toEqual([repoRoot, unrelatedDir]);
      await expect(fs.lstat(baselineDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(candidateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.readFile(unrelatedSentinel, "utf8")).resolves.toBe("unrelated");
    },
  );

  it("keeps signal termination ahead of a normalized successful exit", async () => {
    const controller = new AbortController();
    const stages: string[] = [];
    const runner = vi.fn(async (_command: string, _args: readonly string[], execution) => {
      stages.push(execution.stage);
      if (execution.stage === "worktree-cleanup") {
        expect(execution.signal).toBeUndefined();
        if (_args[1] === "remove") {
          await fs.rm(execution.cwd, { force: true, recursive: true });
        }
        return successfulCommandResult();
      }
      expect(execution.stage).toBe("worktree-add");
      expect(execution.signal).toBe(controller.signal);
      controller.abort();
      return {
        code: 0,
        killed: true,
        signal: "SIGTERM",
        stderr: "",
        stdout: "",
        termination: "signal",
      } satisfies StubCommandResult;
    });

    await expect(
      runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        commandRunner: runner,
        outputDir: ".artifacts/qa-e2e/mantis/signal-exit-zero",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      }),
    ).rejects.toThrow("baseline worktree-add aborted");
    expect(stages).toEqual(["worktree-add", "worktree-cleanup", "worktree-cleanup"]);
  });

  it.skipIf(process.platform === "win32")(
    "stops a default-runner lane command process tree when aborted",
    async ({ signal }) => {
      const controller = new AbortController();
      const binDir = path.join(repoRoot, "bin");
      const parentPidPath = path.join(repoRoot, "abort-parent.pid");
      const descendantPidPath = path.join(repoRoot, "abort-descendant.pid");
      const gitShimPath = path.join(binDir, "git");
      await fs.mkdir(binDir, { recursive: true });
      await writeCommandShim(
        gitShimPath,
        [
          "#!/bin/sh",
          'if [ "$1" = worktree ] && [ "$2" = remove ]; then exit 1; fi',
          'if [ "$1" = worktree ] && [ "$2" = list ]; then exit 0; fi',
          'if [ "$1" != worktree ] || [ "$2" != add ]; then',
          "  printf 'unexpected git shim invocation:' >&2",
          "  printf ' %s' \"$@\" >&2",
          "  printf '\\n' >&2",
          "  exit 1",
          "fi",
          ...stubbornProcessTreeShellLines({ descendantPidPath, parentPidPath }),
        ].join("\n"),
      );

      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      const run = runMantisBeforeAfter({
        baseline: "baseline-ref",
        candidate: "candidate-ref",
        outputDir: ".artifacts/qa-e2e/mantis/default-runner-abort",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      });
      const settled = run.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      try {
        [parentPid, descendantPid] = await withinTest(
          Promise.all([
            readPidBeforeSettled(parentPidPath, "parent", settled),
            readPidBeforeSettled(descendantPidPath, "descendant", settled),
          ]),
          signal,
        );
        controller.abort();

        const result = await withinTest(settled, signal);
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain("baseline worktree-add aborted");
        }
        await Promise.all([waitForDead(parentPid, signal), waitForDead(descendantPid, signal)]);
      } finally {
        controller.abort();
        killKnownProcessPids([parentPid, descendantPid]);
        try {
          await settled;
        } finally {
          if (previousPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = previousPath;
          }
          killKnownProcessPids([parentPid, descendantPid]);
        }
      }
    },
    15_000,
  );

  it.skipIf(process.platform === "win32")(
    "cleans up a real git worktree after a noisy QA deadline kills its process tree",
    async ({ signal }) => {
      const qaTimeoutMs = 2_500;
      const binDir = path.join(repoRoot, "bin");
      const parentPidPath = path.join(repoRoot, "qa-parent.pid");
      const descendantPidPath = path.join(repoRoot, "qa-descendant.pid");
      const pnpmShimPath = path.join(binDir, "pnpm");
      await initializeGitRepo(repoRoot);
      await fs.mkdir(binDir, { recursive: true });
      await writeCommandShim(
        pnpmShimPath,
        [
          "#!/bin/sh",
          ...stubbornProcessTreeShellLines({
            descendantPidPath,
            outputLine: "qa still working",
            parentPidPath,
          }),
        ].join("\n"),
      );

      const previousPath = process.env.PATH;
      process.env.PATH = `${binDir}${path.delimiter}${previousPath ?? ""}`;
      const controller = new AbortController();
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "mantis", "real-qa-timeout");
      let parentPid: number | undefined;
      let descendantPid: number | undefined;
      const run = runMantisBeforeAfter({
        baseline: "HEAD",
        candidate: "HEAD",
        // Keep the tested deadline after process-tree readiness under loaded CI while still short.
        commandTimeouts: { qa: qaTimeoutMs, "worktree-cleanup": 5_000 },
        outputDir: ".artifacts/qa-e2e/mantis/real-qa-timeout",
        repoRoot,
        signal: controller.signal,
        skipBuild: true,
        skipInstall: true,
      });
      const settled = run.then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );
      try {
        [parentPid, descendantPid] = await withinTest(
          Promise.all([
            readPidBeforeSettled(parentPidPath, "parent", settled),
            readPidBeforeSettled(descendantPidPath, "descendant", settled),
          ]),
          signal,
        );

        const result = await withinTest(settled, signal);
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect((result.error as Error).message).toContain(
            `baseline qa timed out after ${qaTimeoutMs}ms`,
          );
        }
        await Promise.all([waitForDead(parentPid, signal), waitForDead(descendantPid, signal)]);
        const worktreeList = await runGit(repoRoot, ["worktree", "list", "--porcelain"]);
        const worktreeEntries = worktreeList.stdout
          .split(/\r?\n/u)
          .filter((entry) => entry.startsWith("worktree "))
          .map((entry) => entry.slice("worktree ".length));
        await expect(fs.realpath(worktreeEntries[0] ?? "")).resolves.toBe(
          await fs.realpath(repoRoot),
        );
        expect(worktreeEntries).toHaveLength(1);
        await expect(fs.readdir(`${outputDir}.worktrees`)).resolves.toEqual([]);
        const errorPath = path.join(outputDir, "error.txt");
        await expect(fs.readFile(errorPath, "utf8")).resolves.toContain(
          `baseline qa timed out after ${qaTimeoutMs}ms`,
        );
      } finally {
        controller.abort();
        killKnownProcessPids([parentPid, descendantPid]);
        try {
          await settled;
        } finally {
          if (previousPath === undefined) {
            delete process.env.PATH;
          } else {
            process.env.PATH = previousPath;
          }
          killKnownProcessPids([parentPid, descendantPid]);
        }
      }
    },
    18_000,
  );
});
