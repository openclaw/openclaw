import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import { hasUnjoinedWork } from "./managed-child-process.mts";
import { isRecord } from "./record-shared.mjs";
import { findRepoRoot } from "./repo-root.mjs";
import type { WithDistArtifactOwnership } from "./runtime-artifact-contract.js";

const DIST_ARTIFACT_LOCK_PATH = ".artifacts/dist-artifacts.lock";
const LOCK_POLL_MS = 500;
let inheritedOwnershipPath: string | undefined;

export function resolveDistArtifactLockPath(rootDir: string) {
  // Subdirectories share checkout ownership; standalone work owns its directory.
  return path.join(findRepoRoot(rootDir) ?? rootDir, DIST_ARTIFACT_LOCK_PATH);
}

function retainUnjoinedDistArtifactWork(directory: string, error: unknown) {
  if (hasUnjoinedWork(error)) {
    fs.writeFileSync(path.join(directory, "unjoined"), "Child cleanup was not verified.\n");
  }
}

export async function runOwnedDistArtifactEntry(script: string, args: string[]) {
  const directory = resolveDistArtifactLockPath(process.cwd());
  const claim = path.join(directory, `child-${process.pid}`);
  // A surviving wrapper claim retains ownership for possibly detached compilers.
  fs.writeFileSync(claim, "Awaiting child completion.\n", { flag: "wx" });
  inheritedOwnershipPath = directory;
  process.argv = [process.execPath, fileURLToPath(script), ...args];
  try {
    await import(script);
  } catch (error) {
    retainUnjoinedDistArtifactWork(directory, error);
    throw error;
  } finally {
    inheritedOwnershipPath = undefined;
    fs.unlinkSync(claim);
  }
}

export async function acquireDistArtifactOwnership(
  rootDir: string,
  wait = false,
): Promise<FileLockHandle> {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const ownerPath = path.join(directory, "owner.json");
  let reportedWait = false;
  let owner: unknown;
  let lock: FileLockHandle;
  try {
    fs.mkdirSync(directory, { recursive: true });
    lock = await acquireFileLock(ownerPath, {
      lockPath: ownerPath,
      // Explicit release owns cleanup; detached children can outlive their parent.
      retainOnExit: true,
      lockRoot: await openLockRoot(directory),
      payload: () => ({ pid: process.pid, startedAt: new Date().toISOString() }),
      timeoutMs: wait ? Number.POSITIVE_INFINITY : 0,
      retry: { minTimeout: LOCK_POLL_MS, maxTimeout: LOCK_POLL_MS, factor: 1 },
      staleRecovery: "fail-closed",
      shouldReclaim: ({ payload }) => {
        owner = payload;
        // fs-safe rechecks the observed owner before failing closed, never reclaiming it.
        const pid = payload && typeof payload === "object" && "pid" in payload ? payload.pid : null;
        if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid <= 1 || pid > 0x7fffffff) {
          return true;
        }
        try {
          process.kill(pid, 0);
        } catch {
          return true;
        }
        if (fs.existsSync(path.join(directory, "unjoined"))) {
          return true;
        }
        if (!reportedWait) {
          console.error(`[dist artifacts] waiting for checkout ownership: ${directory}`);
          reportedWait = true;
        }
        return false;
      },
    });
  } catch (error) {
    if (!fs.existsSync(ownerPath)) {
      throw new Error(
        `Could not acquire ${directory}: ${String(error)}. Resolve this filesystem error and retry before stopping the Gateway.`,
        { cause: error },
      );
    }
    try {
      owner ??= JSON.parse(fs.readFileSync(ownerPath, "utf8"));
    } catch {
      // Unreadable owner fields remain unknown; ownership still fails closed.
    }
    const record = isRecord(owner) ? owner : {};
    const pid = record.pid ?? "unknown";
    const started = record.startedAt ?? "unknown";
    const identity = record.startIdentity ?? record.starttime ?? "unknown";
    const lastSeen = record.heartbeatAt ?? record.heartbeat ?? started;
    const release =
      process.platform === "win32"
        ? `Remove-Item -LiteralPath '${directory.replaceAll("'", "''")}' -Recurse -Force`
        : `rm -rf -- '${directory.replaceAll("'", "'\\''")}'`;
    throw new Error(
      `Could not acquire ${directory}: retained by PID ${JSON.stringify(pid)}, started ${JSON.stringify(started)}, identity ${JSON.stringify(identity)}, last seen ${JSON.stringify(lastSeen)}. Inspect owner.json and verify all associated build/check processes, including detached descendants, have stopped; then run \`${release}\` to release and retry. PID death alone is not sufficient.`,
      { cause: error },
    );
  }
  return lock;
}

/** The callback must join every writer/reader before returning, including on failure. */
export const withDistArtifactOwnership: WithDistArtifactOwnership = async (rootDir, run) => {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  if (directory === inheritedOwnershipPath) {
    return await run();
  }
  const lock = await acquireDistArtifactOwnership(rootDir, true);
  try {
    return await run();
  } catch (error) {
    retainUnjoinedDistArtifactWork(directory, error);
    throw error;
  } finally {
    if (
      fs.readdirSync(directory).some((name) => name === "unjoined" || name.startsWith("child-"))
    ) {
      console.error(`[dist artifacts] child cleanup unverified; retained ${directory}`);
    } else {
      await lock.release();
    }
  }
};
