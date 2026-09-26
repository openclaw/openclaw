// Checkout-local ownership for build outputs, declaration preparation and consumers.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import { hasUnjoinedWork } from "./managed-child-process.mts";
import { findRepoRoot } from "./repo-root.mjs";
import type {
  AcquireDistArtifactOwnership,
  DistArtifactEntryArgs,
  DistArtifactParentBinding,
  DistArtifactOwnership,
  WithDistArtifactOwnership,
} from "./runtime-artifact-contract.js";

const DIST_ARTIFACT_LOCK_PATH = ".artifacts/dist-artifacts.lock";
const LOCK_POLL_MS = 500;
const RUNTIME_CHILD_BOOTSTRAP = `import { once } from "node:events";
import { fileURLToPath } from "node:url";
const [script, ...args] = process.argv.slice(2);
process.argv = [process.execPath, fileURLToPath(script), ...args];
const idle = once(process, "beforeExit");
await import(script);
await idle;
`;
type OwnershipContext = { handle: DistArtifactOwnership; record: string };
const ownerships = new Map<string, OwnershipContext>();
let inheritedOwnershipPath: string | undefined;

function readOwner(directory: string) {
  return fs.readFileSync(path.join(directory, "owner.json"), "utf8");
}

function ownerDigest(record: string) {
  return createHash("sha256").update(record).digest("hex");
}

function ownershipError(directory: string, cause?: unknown, observedPayload?: unknown) {
  let payload = observedPayload;
  if (payload === undefined) {
    try {
      payload = JSON.parse(readOwner(directory));
    } catch {
      // Missing and malformed records still require explicit owner investigation.
    }
  }
  if (cause instanceof Error && !fs.existsSync(path.join(directory, "owner.json"))) {
    return new Error(
      `Could not acquire ${directory}: ${cause.message}. Resolve this filesystem error and retry before stopping the Gateway.`,
      { cause },
    );
  }
  const owner = payload && typeof payload === "object" ? payload : {};
  const pid = "pid" in owner ? JSON.stringify(owner.pid) : "unknown";
  const started = "startedAt" in owner ? JSON.stringify(owner.startedAt) : "unknown";
  const identity =
    "startIdentity" in owner
      ? `, identity ${JSON.stringify(owner.startIdentity)}`
      : "starttime" in owner
        ? `, identity ${JSON.stringify(owner.starttime)}`
        : "";
  const lastSeen =
    "heartbeatAt" in owner
      ? JSON.stringify(owner.heartbeatAt)
      : "heartbeat" in owner
        ? JSON.stringify(owner.heartbeat)
        : started;
  const command =
    process.platform === "win32"
      ? `Remove-Item -LiteralPath '${directory.replaceAll("'", "''")}' -Recurse -Force`
      : `rm -rf -- '${directory.replaceAll("'", "'\\''")}'`;
  return new Error(
    `Could not acquire ${directory}: retained by PID ${pid}, started ${started}${identity}, last seen ${lastSeen}. Inspect owner.json and verify all associated build/check processes, including detached descendants, have stopped; then run \`${command}\` to release and retry. PID death alone is not sufficient.`,
    { cause },
  );
}

export function resolveDistArtifactLockPath(rootDir: string) {
  // Compiler inputs can resolve outside cwd. Subdirectories share checkout
  // ownership; standalone non-checkout work owns its directory.
  return path.join(findRepoRoot(rootDir) ?? rootDir, DIST_ARTIFACT_LOCK_PATH);
}

function retainUnjoinedDistArtifactWork(directory: string, error: unknown) {
  if (hasUnjoinedWork(error)) {
    fs.writeFileSync(path.join(directory, "unjoined"), "Child cleanup was not verified.\n");
  }
}

function completeChildClaim(directory: string, pid: number, record: string, legacy: boolean) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) {
    throw ownershipError(directory);
  }
  const claim = path.join(directory, `child-${pid}`);
  let observed: string;
  try {
    observed = fs.readFileSync(claim, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (
    observed !== ownerDigest(record) &&
    !(legacy && observed === "Awaiting child completion.\n")
  ) {
    throw ownershipError(directory);
  }
  fs.unlinkSync(claim);
}

export async function runOwnedDistArtifactEntry(
  parent: string,
  script: string,
  args: string[],
  entryFactory: DistArtifactEntryArgs,
) {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(process.cwd()));
  const binding: unknown = JSON.parse(parent);
  if (
    !binding ||
    typeof binding !== "object" ||
    !("pid" in binding) ||
    typeof binding.pid !== "number" ||
    !Number.isSafeInteger(binding.pid) ||
    binding.pid <= 1
  ) {
    throw ownershipError(directory);
  }
  const parentPid = binding.pid;
  const processLifetime = "lifetime" in binding && binding.lifetime === "process";
  const readWindowsAncestors =
    process.platform === "win32"
      ? (await import("../../src/infra/windows-process-start.ts")).readWindowsProcessAncestorsSync
      : undefined;
  const record = readOwner(directory);
  const digest = ownerDigest(record);
  const owner: unknown = JSON.parse(record);
  const assertParent = () => {
    if (
      // The Windows Job launcher is an intermediate parent. Its canonical
      // ancestry reader verifies creation times instead of trusting reused PIDs.
      (readWindowsAncestors
        ? !readWindowsAncestors(process.pid, 32, 5_000).includes(parentPid)
        : parentPid !== process.ppid) ||
      readOwner(directory) !== record ||
      ("digest" in binding && binding.digest !== digest) ||
      !owner ||
      typeof owner !== "object" ||
      !("pid" in owner) ||
      (owner.pid !== parentPid &&
        fs.readFileSync(path.join(directory, `child-${parentPid}`), "utf8") !== digest) ||
      fs.existsSync(path.join(directory, "unjoined"))
    ) {
      throw ownershipError(directory);
    }
  };
  assertParent();
  const claim = path.join(directory, `child-${process.pid}`);
  // A killed nested wrapper cannot certify its detached compiler has joined.
  // Its surviving claim keeps the outer owner from releasing on leader exit.
  fs.writeFileSync(claim, digest, { flag: "wx" });
  const handle: DistArtifactOwnership = {
    assertOwned: async () => {
      assertParent();
      if (fs.readFileSync(claim, "utf8") !== digest) {
        throw ownershipError(directory);
      }
    },
    release: async () => {},
    retainUnjoined() {
      if (readOwner(directory) !== record) {
        throw ownershipError(directory);
      }
      fs.writeFileSync(path.join(directory, "unjoined"), "Child cleanup was not verified.\n");
    },
    entryArgs: async (entry, entryArgs) => {
      await handle.assertOwned();
      return entryFactory(entry, entryArgs, {
        native: true,
        parent: { pid: process.pid, digest, lifetime: "process" },
      });
    },
    completeChild: async (pid) => {
      await handle.assertOwned();
      completeChildClaim(directory, pid, record, false);
    },
  };
  ownerships.set(directory, { handle, record });
  inheritedOwnershipPath = directory;
  process.argv = [process.execPath, fileURLToPath(script), ...args];
  try {
    assertParent();
    await import(script);
  } catch (error) {
    retainUnjoinedDistArtifactWork(directory, error);
    throw error;
  } finally {
    // Update workers can return from import before async startup, or call exit().
    // Their process owner acknowledges the claim only after joined completion.
    if (!processLifetime) {
      ownerships.delete(directory);
      inheritedOwnershipPath = undefined;
      fs.unlinkSync(claim);
    }
  }
}

/** Retain checkout ownership from admission until every child has joined. */
export const acquireDistArtifactOwnership: AcquireDistArtifactOwnership = async (
  rootDir,
  { wait = false, runtimeChildren = false } = {},
) => {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const inherited = ownerships.get(directory);
  if (inherited && directory === inheritedOwnershipPath) {
    await inherited.handle.assertOwned();
    return { ...inherited.handle, release: async () => {} };
  }
  const ownerPath = path.join(directory, "owner.json");
  let reportedWait = false;
  let lock: FileLockHandle;
  let observedOwner: unknown;
  try {
    fs.mkdirSync(directory, { recursive: true });
    lock = await acquireFileLock(ownerPath, {
      lockPath: ownerPath,
      // This owner record is deliberately fail-closed: it must survive natural
      // process exit, so only the explicit release after our child joins may
      // remove it. Stale recovery stays caller-owned via shouldReclaim.
      retainOnExit: true,
      lockRoot: await openLockRoot(directory),
      payload: () => ({ pid: process.pid, startedAt: new Date().toISOString() }),
      timeoutMs: wait ? Number.POSITIVE_INFINITY : 0,
      retry: { minTimeout: LOCK_POLL_MS, maxTimeout: LOCK_POLL_MS, factor: 1 },
      staleRecovery: "fail-closed",
      shouldReclaim: ({ payload }) => {
        observedOwner = payload;
        // Return stale rather than throwing: fs-safe rechecks the observed owner
        // before failing closed, so normal release/exit cannot reject its successor.
        // PID death is diagnostic only; fail-closed never removes the lock.
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
        if (wait && !reportedWait) {
          console.error(`[dist artifacts] waiting for checkout ownership: ${directory}`);
          reportedWait = true;
        }
        return false;
      },
    });
  } catch (error) {
    throw ownershipError(directory, error, observedOwner);
  }
  const record = readOwner(directory);
  if (!(await lock.verifyStillHeld())) {
    await lock.release();
    throw ownershipError(directory);
  }
  const childBootstrap = runtimeChildren
    ? path.join(directory, `update-child-${randomUUID()}.mjs`)
    : undefined;
  if (childBootstrap) {
    try {
      fs.writeFileSync(childBootstrap, RUNTIME_CHILD_BOOTSTRAP, { flag: "wx", mode: 0o600 });
    } catch (error) {
      await lock.release();
      throw ownershipError(directory, error);
    }
  }
  let released = false;
  let unjoined = false;
  let legacyChildClaims = false;
  // PID death and age cannot prove detached children stopped. Abrupt exits retain
  // ownership; only joined work releases it, never a signal/exit hook or stale timer.
  const handle: DistArtifactOwnership = {
    async assertOwned() {
      if (
        released ||
        unjoined ||
        !(await lock.verifyStillHeld()) ||
        fs.existsSync(path.join(directory, "unjoined"))
      ) {
        throw ownershipError(directory);
      }
    },
    retainUnjoined() {
      if (released) {
        throw ownershipError(directory);
      }
      unjoined = true;
    },
    async release() {
      if (released) {
        return;
      }
      if (
        unjoined ||
        fs.readdirSync(directory).some((name) => name === "unjoined" || name.startsWith("child-"))
      ) {
        console.error(`[dist artifacts] child cleanup unverified; retained ${directory}`);
      } else {
        if (childBootstrap && (await lock.verifyStillHeld())) {
          try {
            if (fs.readFileSync(childBootstrap, "utf8") !== RUNTIME_CHILD_BOOTSTRAP) {
              throw new Error("Runtime child bootstrap changed after admission.");
            }
            fs.unlinkSync(childBootstrap);
          } catch (error) {
            console.error(
              `[dist artifacts] temporary bootstrap cleanup failed: ${childBootstrap}`,
              error,
            );
          }
        }
        await lock.release();
      }
      released = true;
      ownerships.delete(directory);
    },
    async entryArgs(script, args = []) {
      await handle.assertOwned();
      const root = path.dirname(path.dirname(directory));
      const entry = path.join(root, "scripts/lib/dist-artifact-ownership.mts");
      const staging = path.join(root, "scripts/stage-bundled-plugin-runtime.mts");
      try {
        fs.lstatSync(staging);
      } catch (error) {
        // The 2026.4.27 source target predates artifact completion entirely.
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          return [script, ...args];
        }
        throw error;
      }
      let adapterSource: string;
      try {
        adapterSource = fs.readFileSync(entry, "utf8");
      } catch (error) {
        if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
          throw error;
        }
        // Published 2026.9.1-beta.1 has only the legacy stager, without an
        // artifact ownership adapter. It cannot perform prepared completion.
        const legacyTarget = pathToFileURL(staging);
        legacyTarget.searchParams.set("entry", ownerDigest(fs.readFileSync(staging, "utf8")));
        const legacy: unknown = await import(legacyTarget.href);
        await handle.assertOwned();
        if (
          legacy &&
          typeof legacy === "object" &&
          "stageBundledPluginRuntime" in legacy &&
          typeof legacy.stageBundledPluginRuntime === "function" &&
          (!("prepareBundledPluginRuntime" in legacy) ||
            legacy.prepareBundledPluginRuntime === undefined)
        ) {
          return [script, ...args];
        }
        throw error;
      }
      const target = pathToFileURL(entry);
      // Activation can replace this module after admission. Its current adapter
      // owns the private argv contract, including supported downgrade targets.
      target.searchParams.set("entry", ownerDigest(adapterSource));
      const adapter: unknown = await import(target.href);
      await handle.assertOwned();
      if (!isOwnershipAdapter(adapter)) {
        throw new Error(
          `The installed source checkout cannot delegate artifact ownership: ${entry}`,
        );
      }
      const argv = adapter.distArtifactEntryArgs(script, args, {
        native: true,
        rootDir,
        parent: { pid: process.pid, digest: ownerDigest(record), lifetime: "process" },
      });
      // Published 9.4–9.6 adapters use script-first argv and plain-text claims.
      const legacyAdapter =
        argv.at(-args.length - 2) === entry &&
        argv.at(-args.length - 1) === pathToFileURL(path.resolve(script)).href;
      if (legacyAdapter) {
        if (!childBootstrap) {
          throw new Error(
            "Legacy runtime child ownership was not prepared during update validation.",
          );
        }
        legacyChildClaims = true;
        // The shipped 9.5/9.6 migrated worker starts asynchronously without TLA.
        // Keep its old adapter's import pending until the worker reaches process idle.
        return adapter.distArtifactEntryArgs(
          childBootstrap,
          [pathToFileURL(path.resolve(script)).href, ...args],
          { native: true, rootDir },
        );
      }
      return argv;
    },
    async completeChild(pid) {
      await handle.assertOwned();
      completeChildClaim(directory, pid, record, legacyChildClaims);
    },
  };
  ownerships.set(directory, { handle, record });
  return handle;
};

function isOwnershipAdapter(value: unknown): value is {
  distArtifactEntryArgs: DistArtifactEntryArgs;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    "distArtifactEntryArgs" in value &&
    typeof value.distArtifactEntryArgs === "function",
  );
}

/** The callback must join every writer/reader before returning, including on failure. */
export const withDistArtifactOwnership: WithDistArtifactOwnership = async (rootDir, run) => {
  const lock = await acquireDistArtifactOwnership(rootDir, { wait: true });
  try {
    return await run(lock);
  } catch (error) {
    retainUnjoinedDistArtifactWork(resolveDistArtifactLockPath(rootDir), error);
    throw error;
  } finally {
    await lock.release();
  }
};

/** Project the current owner for its source entry adapter; admission revalidates it. */
export function distArtifactParentBinding(rootDir: string): DistArtifactParentBinding {
  const context = ownerships.get(resolveDistArtifactLockPath(fs.realpathSync(rootDir)));
  return {
    pid: process.pid,
    ...(context ? { digest: ownerDigest(context.record) } : {}),
  };
}
