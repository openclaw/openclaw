import fs from "node:fs/promises";
import path from "node:path";
import { hasNodeErrorCode, pathEntryExists } from "openclaw/plugin-sdk/path-existence-runtime";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";
import {
  MantisCommandCleanupError,
  runMantisCommand,
  type MantisCommandExecution,
  type MantisCommandResult,
  type MantisCommandRunner,
  type MantisCommandTimeouts,
} from "./run-command.runtime.js";
import {
  captureMantisDirectoryOwnership,
  type MantisDirectoryOwnership,
} from "./run-directory.runtime.js";

type MantisCleanupDeadline = {
  expiresAtMs: number;
  lane: "baseline" | "candidate";
  timeoutMs: number;
};

class MantisCleanupDeadlineError extends Error {
  constructor(deadline: MantisCleanupDeadline, operation: string) {
    super(
      `${deadline.lane} worktree cleanup exceeded its total ${deadline.timeoutMs}ms deadline while ${operation}`,
    );
    this.name = "MantisCleanupDeadlineError";
  }
}

function createMantisCleanupDeadline(params: {
  lane: "baseline" | "candidate";
  timeoutMs: number;
}): MantisCleanupDeadline {
  return {
    expiresAtMs: Date.now() + params.timeoutMs,
    lane: params.lane,
    timeoutMs: params.timeoutMs,
  };
}

function resolveMantisCleanupRemainingMs(
  deadline: MantisCleanupDeadline,
  operation: string,
): number {
  // Bound Git commands; local filesystem operations are not cancellable.
  const remainingMs = deadline.expiresAtMs - Date.now();
  if (remainingMs <= 0) {
    throw new MantisCleanupDeadlineError(deadline, operation);
  }
  return Math.max(1, Math.ceil(remainingMs));
}

function rethrowMantisCleanupBoundaryError(error: unknown): void {
  if (error instanceof MantisCleanupDeadlineError || error instanceof MantisCommandCleanupError) {
    throw error;
  }
}

function isPathWithinOrEqual(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function verifyMantisDirectoryOwnership(params: {
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
  worktreeDir: string;
}): Promise<boolean> {
  await assertNoSymlinkParents({
    rootDir: path.resolve(params.repoRoot),
    targetPath: path.resolve(params.worktreeDir),
  });
  let matches = true;
  for (const [directory, dev, ino] of [
    [path.dirname(params.worktreeDir), params.ownership.parentDevice, params.ownership.parentInode],
    [params.worktreeDir, params.ownership.targetDevice, params.ownership.targetInode],
  ] as const) {
    let stat;
    try {
      stat = await fs.lstat(directory, { bigint: true });
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
    matches &&= stat.dev === dev && stat.ino === ino;
  }
  if (!matches) {
    throw new Error(`Mantis worktree path was replaced before cleanup: ${params.worktreeDir}`);
  }
  return true;
}

async function normalizeWorktreePath(filePath: string, repoRoot: string): Promise<string> {
  const resolvedPath = path.resolve(repoRoot, filePath);
  try {
    return await fs.realpath(resolvedPath);
  } catch (error) {
    if (!hasNodeErrorCode(error, "ENOENT")) {
      throw error;
    }
  }

  const resolvedRepoRoot = path.resolve(repoRoot);
  const canonicalRepoRoot = await fs.realpath(resolvedRepoRoot);
  if (!isPathWithinOrEqual(resolvedRepoRoot, resolvedPath)) {
    return resolvedPath;
  }
  return path.join(canonicalRepoRoot, path.relative(resolvedRepoRoot, resolvedPath));
}

async function listRegisteredWorktreePaths(params: {
  createExecution: () => MantisCommandExecution;
  lane: "baseline" | "candidate";
  repoRoot: string;
  runner: MantisCommandRunner;
  worktreeDir: string;
}): Promise<string[]> {
  const list = (nulDelimited: boolean) =>
    runMantisCommand({
      command: "git",
      args: ["worktree", "list", "--porcelain", ...(nulDelimited ? ["-z"] : [])],
      execution: params.createExecution(),
      lane: params.lane,
      runner: params.runner,
    });
  let listResult: MantisCommandResult;
  let nulTerminated = true;
  try {
    listResult = await list(true);
  } catch (nulListError) {
    rethrowMantisCleanupBoundaryError(nulListError);
    // Git gained `worktree list -z` in 2.36. Older porcelain is safe for the
    // generated path unless an ancestor contains a newline.
    if (params.worktreeDir.includes("\n")) {
      throw new Error(
        `${params.lane} worktree cleanup cannot verify a newline-containing path with legacy Git`,
        { cause: nulListError },
      );
    }
    listResult = await list(false);
    nulTerminated = false;
  }

  if (listResult.stdoutTruncatedBytes) {
    throw new Error(
      `${params.lane} worktree cleanup truncated registration output for ${params.worktreeDir}`,
    );
  }
  const fields = nulTerminated
    ? listResult.stdout.split("\0")
    : listResult.stdout
        .split("\n")
        .map((field) => (field.endsWith("\r") ? field.slice(0, -1) : field));
  return Promise.all(
    fields
      .filter((entry) => entry.startsWith("worktree "))
      .map((entry) => normalizeWorktreePath(entry.slice("worktree ".length), params.repoRoot)),
  );
}

function createCleanupVerificationAggregate(params: {
  errors: [unknown, unknown];
  lane: "baseline" | "candidate";
  worktreeDir: string;
}): AggregateError {
  return new AggregateError(
    params.errors,
    `${params.lane} worktree cleanup could not verify complete registration state for ${params.worktreeDir}`,
    { cause: params.errors[0] },
  );
}

type RemoveMantisWorktreeParams = {
  commandTimeouts: MantisCommandTimeouts;
  lane: "baseline" | "candidate";
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
  runner: MantisCommandRunner;
  worktreeDir: string;
};

async function removeMantisWorktreeBeforeDeadline(
  params: RemoveMantisWorktreeParams,
  deadline: MantisCleanupDeadline,
): Promise<void> {
  const retainedDirectoryError = (cause: unknown) =>
    new Error(
      `${params.lane} worktree cleanup left ${params.worktreeDir}; Mantis preserved the path because Git no longer owns it`,
      { cause },
    );
  const createCleanupExecution = (): MantisCommandExecution => ({
    cwd: params.repoRoot,
    env: process.env,
    stage: "worktree-cleanup",
    timeoutMs: resolveMantisCleanupRemainingMs(deadline, "starting a Git cleanup command"),
  });
  const normalizedWorktreeDir = await normalizeWorktreePath(params.worktreeDir, params.repoRoot);
  const ownership = params.ownership;
  const listRegisteredPaths = () =>
    listRegisteredWorktreePaths({ ...params, createExecution: createCleanupExecution });

  const verifyOwnership = () =>
    verifyMantisDirectoryOwnership({
      ownership,
      repoRoot: params.repoRoot,
      worktreeDir: params.worktreeDir,
    });
  if (!(await verifyOwnership())) {
    const registeredWorktreePaths = await listRegisteredPaths();
    if (!registeredWorktreePaths.includes(normalizedWorktreeDir)) {
      return;
    }
    throw new Error(`${params.lane} worktree cleanup left registered path ${params.worktreeDir}`, {
      cause: new Error("the owned worktree path disappeared before Git could remove it"),
    });
  }

  let removeError: unknown;
  try {
    // The helper binds cwd before checking the receipt, then Git resolves `.`
    // through that pinned cwd. A pathname replacement is preserved or makes
    // Git fail; it is never selected as the removal target.
    await runMantisCommand({
      command: "git",
      args: ["worktree", "remove", "--force", "--", "."],
      execution: {
        ...createCleanupExecution(),
        cwd: params.worktreeDir,
        expectedCwdIdentity: {
          dev: ownership.targetDevice,
          ino: ownership.targetInode,
        },
      },
      lane: params.lane,
      runner: params.runner,
    });
  } catch (error) {
    rethrowMantisCleanupBoundaryError(error);
    removeError = error;
  }

  let registeredWorktreePaths: string[];
  try {
    registeredWorktreePaths = await listRegisteredPaths();
  } catch (listError) {
    rethrowMantisCleanupBoundaryError(listError);
    throw createCleanupVerificationAggregate({
      errors: [removeError ?? new Error("Git worktree removal completed"), listError],
      lane: params.lane,
      worktreeDir: params.worktreeDir,
    });
  }
  if (registeredWorktreePaths.includes(normalizedWorktreeDir)) {
    throw new Error(`${params.lane} worktree cleanup left registered path ${params.worktreeDir}`, {
      cause: removeError,
    });
  }

  if (await pathEntryExists(params.worktreeDir)) {
    try {
      const stillOwned = await verifyOwnership();
      const entries = stillOwned ? await fs.readdir(params.worktreeDir) : undefined;
      if (entries?.length === 0) {
        // Git no longer owns this unique prepared directory. Keep the empty
        // inode rather than deleting through a pathname race.
        return;
      }
    } catch {
      // The retained-path error below reports the safe fail-closed outcome.
    }
    throw retainedDirectoryError(
      removeError ?? new Error("Git reported success but left the directory"),
    );
  }
}

export async function removeMantisWorktree(params: RemoveMantisWorktreeParams): Promise<void> {
  const deadline = createMantisCleanupDeadline({
    lane: params.lane,
    timeoutMs: params.commandTimeouts["worktree-cleanup"],
  });
  await removeMantisWorktreeBeforeDeadline(params, deadline);
}

export async function removeLegacyMantisWorktrees(params: {
  commandTimeouts: MantisCommandTimeouts;
  outputDir: string;
  repoRoot: string;
  runner: MantisCommandRunner;
}): Promise<void> {
  const legacyRoot = path.join(params.outputDir, "worktrees");
  const deadline = createMantisCleanupDeadline({
    lane: "baseline",
    timeoutMs: params.commandTimeouts["worktree-cleanup"],
  });
  const createExecution = (): MantisCommandExecution => ({
    cwd: params.repoRoot,
    env: process.env,
    stage: "worktree-cleanup",
    timeoutMs: resolveMantisCleanupRemainingMs(deadline, "listing legacy worktrees"),
  });
  if (!(await pathEntryExists(legacyRoot))) {
    return;
  }
  const normalizedLegacyRoot = await normalizeWorktreePath(legacyRoot, params.repoRoot);
  const registeredPaths = await listRegisteredWorktreePaths({
    createExecution,
    lane: "baseline",
    repoRoot: params.repoRoot,
    runner: params.runner,
    worktreeDir: legacyRoot,
  });
  for (const lane of ["baseline", "candidate"] as const) {
    // Share the absolute expiry while attributing any timeout to the lane that
    // was active when the remaining budget ran out.
    const laneDeadline = { ...deadline, lane };
    const worktreeDir = path.join(legacyRoot, lane);
    if (!registeredPaths.includes(path.join(normalizedLegacyRoot, lane))) {
      continue;
    }
    if (!(await pathEntryExists(worktreeDir))) {
      throw new Error(`${lane} legacy worktree cleanup left registered path ${worktreeDir}`, {
        cause: new Error("the historical Mantis worktree path is missing"),
      });
    }
    const ownership = await captureMantisDirectoryOwnership({
      directoryPath: worktreeDir,
      repoRoot: params.repoRoot,
    });
    await removeMantisWorktreeBeforeDeadline(
      {
        commandTimeouts: params.commandTimeouts,
        lane,
        ownership,
        repoRoot: params.repoRoot,
        runner: params.runner,
        worktreeDir,
      },
      laneDeadline,
    );
  }
}
