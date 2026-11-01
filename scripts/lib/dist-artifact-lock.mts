import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import {
  assessDistArtifactOwner,
  describeDistArtifactOwner,
  exportDistArtifactOwnerToken,
  type DistArtifactOwnerAssessment,
} from "./dist-artifact-owner-census.mts";
import { hasUnjoinedWork } from "./managed-child-process.mts";
import { isRecord } from "./record-shared.mjs";
import { findRepoRoot } from "./repo-root.mjs";
import type { WithDistArtifactOwnership } from "./runtime-artifact-contract.js";

const DIST_ARTIFACT_LOCK_PATH = ".artifacts/dist-artifacts.lock";
const LOCK_POLL_MS = 500;
const CENSUS_REFRESH_MS = 2_000;
const WAIT_PROGRESS_MS = 30_000;
const RECLAIM_GUARD_MAX_AGE_MS = 60_000;
type ArtifactOwner = { directory: string; unjoinedError?: Error };
let inheritedOwner: ArtifactOwner | undefined;
const activeOwner = new AsyncLocalStorage<ArtifactOwner>();

export function resolveDistArtifactLockPath(rootDir: string) {
  // Subdirectories share checkout ownership; standalone work owns its directory.
  return path.join(findRepoRoot(rootDir) ?? rootDir, DIST_ARTIFACT_LOCK_PATH);
}

function retainUnjoinedDistArtifactWork(owner: ArtifactOwner, error: unknown) {
  if (owner.unjoinedError !== undefined) {
    return owner.unjoinedError;
  }
  if (hasUnjoinedWork(error)) {
    // Latch before I/O: a full disk must not turn uncertain cleanup into permission to release.
    owner.unjoinedError =
      error instanceof Error ? error : new Error("Unjoined artifact work", { cause: error });
    try {
      fs.writeFileSync(path.join(owner.directory, "unjoined"), "Child cleanup was not verified.\n");
    } catch (writeError) {
      owner.unjoinedError = new AggregateError(
        [error, writeError],
        "Could not record unjoined artifact work",
      );
    }
    return owner.unjoinedError;
  }
  return error;
}

export async function runOwnedDistArtifactEntry(script: string, args: string[]) {
  const directory = resolveDistArtifactLockPath(process.cwd());
  const claim = path.join(directory, `child-${process.pid}`);
  // A surviving wrapper claim retains ownership for possibly detached compilers.
  fs.writeFileSync(claim, "Awaiting child completion.\n", { flag: "wx" });
  const owner: ArtifactOwner = { directory };
  // This entry process inherits ownership until exit. Native bundler callbacks
  // can lose async context and run after the CLI module's import has settled.
  inheritedOwner = owner;
  process.argv = [process.execPath, fileURLToPath(script), ...args];
  try {
    await activeOwner.run(owner, () => import(script));
  } catch (error) {
    throw retainUnjoinedDistArtifactWork(owner, error);
  } finally {
    // The pre-existing claim is the durable fence if recording uncertainty failed.
    if (owner.unjoinedError === undefined || fs.existsSync(path.join(directory, "unjoined"))) {
      fs.unlinkSync(claim);
    }
  }
}

/** Live or unobservable writers still own this checkout; the record was left untouched. */
export class DistArtifactOwnershipBusyError extends Error {
  override name = "DistArtifactOwnershipBusyError";
}

function isLockContention(error: unknown) {
  const code = isRecord(error) ? error.code : undefined;
  return code === "file_lock_timeout" || code === "file_lock_stale";
}

function readOwnerClaims(directory: string) {
  return fs.readdirSync(directory).flatMap((name) => {
    const pid = /^child-(\d+)$/u.exec(name)?.[1];
    const claimed = pid && fs.statSync(path.join(directory, name), { throwIfNoEntry: false });
    return claimed ? [{ pid: Number(pid), claimedAtMs: claimed.mtimeMs }] : [];
  });
}

/** A reclaimer killed between its guard and removal must not block every later acquirer. */
function clearAbandonedReclaimGuard(ownerPath: string) {
  const guardPath = `${ownerPath}.reclaim`;
  const guard = fs.statSync(guardPath, { throwIfNoEntry: false });
  if (!guard) {
    return;
  }
  let reclaimer: unknown;
  try {
    reclaimer = JSON.parse(fs.readFileSync(guardPath, "utf8"));
  } catch {
    // Unreadable guards age out like live ones; the removal below stays bounded by age.
  }
  const pid = isRecord(reclaimer) ? reclaimer.pid : undefined;
  let dead = Date.now() - guard.mtimeMs > RECLAIM_GUARD_MAX_AGE_MS;
  try {
    if (typeof pid === "number") {
      process.kill(pid, 0);
    }
  } catch (error) {
    dead ||= (error as NodeJS.ErrnoException).code === "ESRCH";
  }
  // A contender may have replaced the guard since the read above. Accepted: a replacement in
  // this last stat-to-unlink gap needs a crashed reclaimer and two more within microseconds.
  const current = fs.statSync(guardPath, { throwIfNoEntry: false });
  if (dead && current?.ino === guard.ino && current.mtimeMs === guard.mtimeMs) {
    fs.rmSync(guardPath, { force: true });
  }
}

export async function acquireDistArtifactOwnership(
  rootDir: string,
  wait: boolean | { timeoutMs: number } = false,
  signal?: AbortSignal,
  onRecovered?: (message: string) => void,
): Promise<FileLockHandle> {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const ownerPath = path.join(directory, "owner.json");
  const checkoutRoot = path.dirname(path.dirname(directory));
  const startedWaitingAt = performance.now();
  const budgetMs = typeof wait === "object" ? wait.timeoutMs : undefined;
  // Bounded and cancellable waits poll; published updaters keep fs-safe's original wait.
  const polled = signal !== undefined || budgetMs !== undefined;
  const token = randomBytes(16).toString("hex");
  let lastReportedWaitAt: number | undefined;
  let held:
    | { assessment: Exclude<DistArtifactOwnerAssessment, { kind: "clear" }>; at: number }
    | undefined;
  let recoverable: string | undefined;
  let recovered: string | undefined;
  let owner: unknown;
  let lock: FileLockHandle;
  try {
    fs.mkdirSync(directory, { recursive: true });
    const lockRoot = await openLockRoot(directory);
    while (true) {
      signal?.throwIfAborted();
      clearAbandonedReclaimGuard(ownerPath);
      try {
        lock = await acquireFileLock(ownerPath, {
          lockPath: ownerPath,
          // Explicit release owns cleanup; detached children can outlive their parent.
          retainOnExit: true,
          lockRoot,
          payload: () => ({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            ...describeDistArtifactOwner(),
            token,
          }),
          timeoutMs: wait ? (polled ? LOCK_POLL_MS : Number.POSITIVE_INFINITY) : 0,
          retry: { minTimeout: LOCK_POLL_MS, maxTimeout: LOCK_POLL_MS, factor: 1 },
          staleRecovery: "remove-if-unchanged",
          shouldReclaim: ({ payload, nowMs, staleMs }) => {
            owner = payload;
            const pending = fs.statSync(ownerPath, { throwIfNoEntry: false });
            // Exclusive creation exposes an empty file before the owner is written.
            // Keep fs-safe's publication grace; abandoned records recover below.
            if (payload === null && pending?.size === 0 && nowMs - pending.mtimeMs < staleMs) {
              return false;
            }
            const now = performance.now();
            if (!held || now - held.at >= CENSUS_REFRESH_MS) {
              const assessment = assessDistArtifactOwner({
                record: isRecord(payload) ? payload : {},
                recordMtimeMs: pending?.mtimeMs ?? nowMs,
                claims: readOwnerClaims(directory),
                checkoutRoot,
                nowMs,
              });
              if (assessment.kind === "clear") {
                const pid = isRecord(payload) ? (payload.pid ?? "unknown") : "unknown";
                recoverable = [
                  `Recovered ${directory} from dead owner PID ${JSON.stringify(pid)} after verifying no surviving writers`,
                  assessment.warning,
                ]
                  .filter(Boolean)
                  .join("; ");
                return true;
              }
              held = { assessment, at: now };
            }
            if (
              wait &&
              (lastReportedWaitAt === undefined || now - lastReportedWaitAt >= WAIT_PROGRESS_MS)
            ) {
              lastReportedWaitAt = now;
              const waited = Math.round((now - startedWaitingAt) / 1000);
              const budget = budgetMs === undefined ? "" : ` of ${Math.round(budgetMs / 1000)}s`;
              console.error(
                `[dist artifacts] waiting for checkout ownership: ${directory} (${held.assessment.detail}; waited ${waited}s${budget})`,
              );
            }
            return false;
          },
          // Stale markers must not outlive the owner they described: the next
          // owner's release treats them as its own unverified cleanup.
          shouldRemoveStaleLock: () => {
            recovered = recoverable;
            for (const name of fs.readdirSync(directory)) {
              if (name === "unjoined" || name.startsWith("child-")) {
                fs.rmSync(path.join(directory, name), { force: true });
              }
            }
            return true;
          },
        });
        break;
      } catch (error) {
        if (
          !wait ||
          !polled ||
          !isLockContention(error) ||
          (budgetMs !== undefined && performance.now() - startedWaitingAt >= budgetMs)
        ) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw error;
    }
    if (!isLockContention(error) || !fs.existsSync(ownerPath)) {
      throw new Error(
        `Could not acquire ${directory}: ${String(error)}. Resolve this filesystem error and retry before stopping the Gateway.`,
        { cause: error },
      );
    }
    try {
      owner ??= JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    } catch {
      // Unreadable owner fields remain unknown.
    }
    const record = isRecord(owner) ? owner : {};
    const pid = record.pid ?? "unknown";
    const started = record.startedAt ?? "unknown";
    const identity = record.startIdentity ?? "unknown";
    const state = held?.assessment.detail ?? "another acquirer is recovering it";
    throw new DistArtifactOwnershipBusyError(
      `Could not acquire ${directory}: retained by PID ${JSON.stringify(pid)}, started ${JSON.stringify(started)}, identity ${JSON.stringify(identity)}: ${state}. Ownership recovers automatically once those processes exit; no manual removal is needed.`,
      { cause: error },
    );
  }
  // Acquisition can finish after cancellation; direct callers must never inherit that lock.
  if (signal?.aborted) {
    await lock.release();
    signal.throwIfAborted();
  }
  if (recovered) {
    console.error(`[dist artifacts] ${recovered}`);
    onRecovered?.(recovered);
  }
  const withdrawToken = exportDistArtifactOwnerToken(token);
  const release = async () => {
    await lock.release();
    withdrawToken();
  };
  return { ...lock, release, [Symbol.asyncDispose]: release };
}

/** The callback must join every writer/reader before returning, including on failure. */
export const withDistArtifactOwnership: WithDistArtifactOwnership = async (
  rootDir,
  run,
  signal,
) => {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const currentOwner = activeOwner.getStore() ?? inheritedOwner;
  if (directory === currentOwner?.directory) {
    if (currentOwner.unjoinedError !== undefined) {
      throw currentOwner.unjoinedError;
    }
    signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      // A CLI can turn this error into an exit status before the entry launcher sees it.
      // Record uncertain cleanup at the ownership boundary so the parent retains the lock.
      throw retainUnjoinedDistArtifactWork(currentOwner, error);
    }
  }
  const lock = await acquireDistArtifactOwnership(rootDir, true, signal);
  const owner: ArtifactOwner = { directory };
  try {
    signal?.throwIfAborted();
    return await activeOwner.run(owner, run);
  } catch (error) {
    throw retainUnjoinedDistArtifactWork(owner, error);
  } finally {
    if (
      owner.unjoinedError !== undefined ||
      fs.readdirSync(directory).some((name) => name === "unjoined" || name.startsWith("child-"))
    ) {
      console.error(`[dist artifacts] child cleanup unverified; retained ${directory}`);
    } else {
      await lock.release();
    }
  }
};
