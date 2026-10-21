#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { booleanFlag, parseFlagArgs, stringFlag } from "./lib/arg-utils.mts";
import { runManagedCommand } from "./lib/managed-child-process.mts";

type ReleasePrepushCommand = {
  name: string;
  bin: "node" | "pnpm";
  args: string[];
  cwd: string;
  env?: NodeJS.ProcessEnv;
};

type ReleasePrepushDependencies = {
  assertCleanWorktree: () => void;
  assertAuditBounds: (baseSha: string, headSha: string) => string;
  createValidationCheckout: (headSha: string) => string;
  currentBranch: () => string;
  pushValidatedHead: (headSha: string, branch: string) => void;
  refreshMain: () => void;
  refreshReleaseBranch: (branch: string) => string | undefined;
  removeValidationCheckout: (checkout: string) => void;
  resolveCommit: (ref: string) => string;
  runCommand: (command: ReleasePrepushCommand) => Promise<number>;
};

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
}

export function resolveCommit(ref: string): string {
  const sha = git(["rev-parse", "--verify", `${ref}^{commit}`]);
  if (!/^[a-f0-9]{40}$/u.test(sha)) {
    throw new Error(`${ref} did not resolve to an exact commit`);
  }
  return sha;
}

export function assertCleanWorktree(): void {
  if (git(["status", "--porcelain=v1", "--untracked-files=all"])) {
    throw new Error("release:prepush requires a clean worktree so every gate proves exact HEAD");
  }
}

export function assertAuditBounds(baseSha: string, headSha: string): string {
  if (baseSha === headSha) {
    return baseSha;
  }
  const mergeBase = git(["merge-base", baseSha, headSha]);
  if (!/^[a-f0-9]{40}$/u.test(mergeBase)) {
    throw new Error("release:prepush base and HEAD do not share an auditable merge base");
  }
  return mergeBase;
}

export function selectChangedGateBase(
  authoritativeMainSha: string,
  headSha: string,
  canonicalReleaseSha: string | undefined,
  resolveMergeBase: (baseSha: string, candidateSha: string) => string = assertAuditBounds,
): string {
  const auditMergeBase = resolveMergeBase(authoritativeMainSha, headSha);
  if (canonicalReleaseSha === undefined) {
    return auditMergeBase;
  }
  if (resolveMergeBase(canonicalReleaseSha, headSha) !== canonicalReleaseSha) {
    throw new Error(
      "release:push refuses a candidate that is not a fast-forward of the canonical release branch",
    );
  }
  return canonicalReleaseSha;
}

export function currentBranch(): string {
  const branch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return canonicalReleaseBranch(branch);
}

export function canonicalReleaseBranch(branch: string): string {
  if (!/^release\/\d{4}\.\d{1,2}\.\d+$/u.test(branch)) {
    throw new Error("release:push requires a canonical release/YYYY.M.PATCH branch");
  }
  return branch;
}

export function refreshMain(): void {
  execFileSync(
    "git",
    ["fetch", "--no-tags", "origin", "refs/heads/main:refs/remotes/origin/main"],
    { stdio: "inherit" },
  );
}

export function refreshReleaseBranch(branch: string): string | undefined {
  const remoteRef = `refs/heads/${canonicalReleaseBranch(branch)}`;
  const probe = spawnSync("git", ["ls-remote", "--exit-code", "--heads", "origin", remoteRef], {
    encoding: "utf8",
  });
  if (probe.status === 2) {
    return undefined;
  }
  if (probe.status !== 0) {
    throw new Error(`failed to inspect canonical release branch: ${probe.stderr.trim()}`);
  }
  execFileSync(
    "git",
    ["fetch", "--no-tags", "origin", `${remoteRef}:refs/remotes/origin/${branch}`],
    { stdio: "inherit" },
  );
  return resolveCommit(`refs/remotes/origin/${branch}`);
}

export function pushValidatedHead(headSha: string, branch: string): void {
  execFileSync("git", ["push", "origin", `${headSha}:refs/heads/${branch}`], {
    stdio: "inherit",
  });
}

export function createValidationCheckout(headSha: string): string {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-prepush-"));
  const checkout = join(root, "checkout");
  try {
    execFileSync("git", ["worktree", "add", "--detach", checkout, headSha], {
      stdio: "inherit",
    });
    return checkout;
  } catch (error) {
    rmSync(root, { force: true, recursive: true });
    throw error;
  }
}

export function removeValidationCheckout(checkout: string): void {
  try {
    execFileSync("git", ["worktree", "remove", "--force", checkout], {
      stdio: "inherit",
    });
  } finally {
    rmSync(dirname(checkout), { force: true, recursive: true });
  }
}

export function buildReleasePrepushPlan(
  baseSha: string,
  headSha: string,
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): ReleasePrepushCommand[] {
  return [
    {
      name: "frozen dependency install",
      bin: "pnpm",
      args: ["install", "--frozen-lockfile"],
      cwd,
      env,
    },
    {
      name: "changed static and type gates",
      bin: "pnpm",
      args: ["check:changed", "--base", baseSha, "--head", headSha],
      cwd,
      env: { ...env, CI: "1", OPENCLAW_LOCAL_CHECK: "0" },
    },
    {
      name: "production dead-code gate",
      bin: "pnpm",
      args: ["deadcode:knip"],
      cwd,
      env,
    },
    {
      name: "changed tests",
      bin: "node",
      args: ["scripts/test-projects.mts", "--changed", baseSha],
      cwd,
      env,
    },
  ];
}

async function defaultRunCommand(command: ReleasePrepushCommand): Promise<number> {
  console.error(`\n[release:prepush] ${command.name}`);
  return runManagedCommand({
    bin: command.bin,
    args: command.args,
    cwd: command.cwd,
    env: command.env,
  });
}

const defaultDependencies: ReleasePrepushDependencies = {
  assertCleanWorktree,
  assertAuditBounds,
  createValidationCheckout,
  currentBranch,
  pushValidatedHead,
  refreshMain,
  refreshReleaseBranch,
  removeValidationCheckout,
  resolveCommit,
  runCommand: defaultRunCommand,
};

export async function runReleasePrepush(
  options: { base: string; branch?: string; dryRun: boolean; head?: string; push: boolean },
  dependencies: ReleasePrepushDependencies = defaultDependencies,
): Promise<number> {
  dependencies.assertCleanWorktree();
  if (!options.push && (options.branch !== undefined || options.head !== undefined)) {
    throw new Error("release:prepush --branch and --head require --push");
  }
  const branch = options.push
    ? options.branch === undefined
      ? dependencies.currentBranch()
      : canonicalReleaseBranch(options.branch)
    : undefined;
  const headRef = options.head ?? "HEAD";
  if (options.push) {
    if (options.base !== "origin/main") {
      throw new Error("release:push requires the authoritative origin/main comparison base");
    }
    dependencies.refreshMain();
  }
  const baseSha = dependencies.resolveCommit(options.base);
  const headSha = dependencies.resolveCommit(headRef);
  const canonicalReleaseSha = branch ? dependencies.refreshReleaseBranch(branch) : undefined;
  const comparisonBaseSha = selectChangedGateBase(
    baseSha,
    headSha,
    canonicalReleaseSha,
    dependencies.assertAuditBounds,
  );

  if (comparisonBaseSha !== baseSha) {
    console.error(
      `[release:prepush] authoritative main ${baseSha}; changed-gate baseline ${comparisonBaseSha}`,
    );
  }

  if (options.dryRun) {
    for (const command of buildReleasePrepushPlan(
      comparisonBaseSha,
      headSha,
      "<detached-checkout>",
    )) {
      console.log([command.bin, ...command.args].join(" "));
    }
    return 0;
  }

  const validationCheckout = dependencies.createValidationCheckout(headSha);
  try {
    for (const command of buildReleasePrepushPlan(comparisonBaseSha, headSha, validationCheckout)) {
      const status = await dependencies.runCommand(command);
      if (status !== 0) {
        console.error(`[release:prepush] failed: ${command.name}`);
        return status;
      }
    }
  } finally {
    dependencies.removeValidationCheckout(validationCheckout);
  }

  dependencies.assertCleanWorktree();
  if (dependencies.resolveCommit(headRef) !== headSha) {
    throw new Error(
      `${headRef} changed while release:prepush was running; rerun against the new exact SHA`,
    );
  }
  if (branch && options.branch === undefined && dependencies.currentBranch() !== branch) {
    throw new Error("release branch changed while release:prepush was running");
  }
  console.error(`\n[release:prepush] passed for ${headSha}`);
  if (branch) {
    dependencies.pushValidatedHead(headSha, branch);
    console.error(`[release:push] pushed validated ${headSha} to ${branch}`);
  }
  return 0;
}

export function parseReleasePrepushArgs(argv: string[]) {
  const separator = argv.indexOf("--");
  const normalizedArgv =
    separator === -1 ? argv : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
  return parseFlagArgs(
    normalizedArgv,
    {
      base: "origin/main",
      branch: undefined,
      dryRun: false,
      head: undefined,
      help: false,
      push: false,
    },
    [
      stringFlag("--base", "base", { rejectShortOptions: true }),
      stringFlag("--branch", "branch", { rejectShortOptions: true }),
      stringFlag("--head", "head", { rejectShortOptions: true }),
      booleanFlag("--dry-run", "dryRun", true, { repeatable: true }),
      booleanFlag("--push", "push", true, { repeatable: true }),
      booleanFlag("--help", "help", true, { repeatable: true }),
      booleanFlag("-h", "help", true, { repeatable: true }),
    ],
    {
      ignoreDoubleDash: false,
      onUnhandledArg(arg: string) {
        throw new Error(`unknown argument: ${arg}`);
      },
    },
  );
}

function usage(): string {
  return [
    "Usage: pnpm release:prepush -- [--base <ref>] [--dry-run]",
    "       pnpm release:push [-- --head <sha> --branch <release/YYYY.M.PATCH>]",
    "",
    "Runs exact-HEAD changed static/type gates, production dead-code analysis, and changed tests.",
    "The default comparison base is origin/main.",
    "release:push refreshes origin/main, validates, and pushes the captured exact SHA to its canonical release branch.",
  ].join("\n");
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  try {
    const args = parseReleasePrepushArgs(argv);
    if (args.help) {
      console.log(usage());
      return;
    }
    process.exitCode = await runReleasePrepush({
      base: args.base,
      branch: args.branch,
      dryRun: args.dryRun,
      head: args.head,
      push: args.push,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
