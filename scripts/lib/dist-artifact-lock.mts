import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { acquireFileLock, type FileLockHandle } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import { loadDistArtifactIdentity } from "./dist-artifact-identity.mts";
import type { runNativeArtifactOperation } from "./dist-artifact-native.mts";
import { hasUnjoinedWork } from "./managed-child-process.mts";
import { isRecord } from "./record-shared.mjs";
import { findRepoRoot } from "./repo-root.mjs";
import type { WithDistArtifactOwnership } from "./runtime-artifact-contract.js";

const DIST_ARTIFACT_LOCK_PATH = ".artifacts/dist-artifacts.lock";
const LOCK_POLL_MS = 500;

/** A complete ownership verdict; retained causes remain available to diagnostics. */
export class DistArtifactCustodyError extends Error {
  override name = "DistArtifactCustodyError";
}
type ArtifactOwner = {
  directory: string;
  claimsDirectory: string;
  nativeCustodyId?: string;
  unjoinedError?: Error;
};
let inheritedOwner: ArtifactOwner | undefined;
const CUSTODY_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

let processIdentity: Awaited<ReturnType<typeof loadDistArtifactIdentity>>;

function readRecord(file: string): string {
  if (!fs.lstatSync(file).isFile()) {
    throw new Error("Artifact custody is not a regular file");
  }
  return fs.readFileSync(file, "utf8");
}

function custodyDirectory(directory: string, payload: unknown): string | undefined {
  if (
    !isRecord(payload) ||
    payload.artifactCustody !== 1 ||
    typeof payload.custodyId !== "string" ||
    !CUSTODY_ID.test(payload.custodyId)
  ) {
    return undefined;
  }
  const candidate = path.join(directory, payload.custodyId);
  return fs.lstatSync(candidate).isDirectory() ? candidate : undefined;
}

function hasRetainedEntries(directory: string) {
  return fs.readdirSync(directory).some((name) => {
    if (name === "unjoined" || name === "launch" || name.startsWith("child-")) {
      return true;
    }
    if (!CUSTODY_ID.test(name)) {
      return false;
    }
    try {
      const child = path.join(directory, name);
      if (!fs.lstatSync(child).isDirectory()) {
        return true;
      }
      return claimEntries(child).some((entry) => entry !== "settled");
    } catch {
      return true;
    }
  });
}

function claimEntries(custody: string) {
  const names = fs.readdirSync(custody);
  for (const name of names) {
    if (
      (name !== "unjoined" &&
        name !== "settled" &&
        name !== "launch" &&
        !/^child-[1-9][0-9]*$/.test(name)) ||
      !fs.lstatSync(path.join(custody, name)).isFile()
    ) {
      throw new Error("Artifact custody contains unknown entries");
    }
  }
  return names;
}

/** Only the closed native command operation can produce a settlement receipt.
 * Generic callbacks, group disappearance, and cgroup paths cannot prove custody.
 */
function canRecover(
  directory: string,
  raw: string,
  payload: unknown,
  scope: string | null,
): boolean {
  try {
    const custody = custodyDirectory(directory, payload);
    if (
      !custody ||
      !isRecord(payload) ||
      payload.treeOwnership !== "linux-subreaper" ||
      scope === null ||
      payload.processScope !== scope ||
      typeof payload.startIdentity !== "number" ||
      !Number.isSafeInteger(payload.startIdentity) ||
      payload.startIdentity < 0 ||
      typeof payload.pid !== "number" ||
      !Number.isSafeInteger(payload.pid) ||
      payload.pid <= 1 ||
      payload.pid > 0x7fffffff ||
      hasRetainedEntries(directory) ||
      hasRetainedEntries(custody) ||
      readRecord(path.join(custody, "settled")) !== raw
    ) {
      return false;
    }
    const current = processIdentity?.getProcessInstanceStartTime(payload.pid) ?? null;
    if (
      !(current !== null && current !== payload.startIdentity) &&
      processIdentity?.isPidDefinitelyDead(payload.pid) !== true
    ) {
      return false;
    }
    return claimEntries(custody).every((name) => name === "settled");
  } catch {
    return false;
  }
}

function removeRetiredCustody(custody: string) {
  if (!fs.lstatSync(custody).isDirectory()) {
    throw new Error("Artifact custody directory changed");
  }
  for (const name of claimEntries(custody)) {
    fs.unlinkSync(path.join(custody, name));
  }
  fs.rmdirSync(custody);
}

function readArtifactOwner(directory: string): ArtifactOwner {
  const payload: unknown = JSON.parse(readRecord(path.join(directory, "owner.json")));
  const custody = custodyDirectory(directory, payload);
  if (isRecord(payload) && payload.artifactCustody !== undefined && !custody) {
    throw new Error("Artifact custody generation is unavailable; entry was not admitted");
  }
  return {
    directory,
    claimsDirectory: custody ?? directory,
    ...(custody && isRecord(payload) && payload.treeOwnership === "linux-subreaper"
      ? { nativeCustodyId: path.basename(custody) }
      : {}),
  };
}

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
      fs.writeFileSync(
        path.join(owner.claimsDirectory, "unjoined"),
        "Child cleanup was not verified.\n",
      );
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

export async function runOwnedDistArtifactEntry(
  script: string,
  args: string[],
  nativeCustodyId?: string,
) {
  processIdentity ??= await loadDistArtifactIdentity();
  const directory = resolveDistArtifactLockPath(process.cwd());
  const owner = readArtifactOwner(directory);
  // Ordinary entry launchers cannot join a native generation they did not start.
  // The handoff selects the generation; only the retained native relay can later
  // prove extinction. This identifier is never recovery authority by itself.
  if (owner.nativeCustodyId !== nativeCustodyId) {
    throw new Error("Artifact native entry generation mismatch; custody remains with its owner");
  }
  if (nativeCustodyId) {
    // The native adapter withholds this pipe until its actual root identity has
    // been registered by the retained lock owner. A readable UUID is not custody.
    let grant = "";
    for await (const chunk of process.stdin) {
      grant += String(chunk);
      if (grant.length > nativeCustodyId.length + 1) {
        break;
      }
    }
    const launch: unknown = JSON.parse(readRecord(path.join(owner.claimsDirectory, "launch")));
    const startIdentity = processIdentity?.getProcessInstanceStartTime(process.pid) ?? null;
    const scope = processIdentity?.readScope() ?? null;
    if (
      grant !== nativeCustodyId + "\n" ||
      !isRecord(launch) ||
      launch.pid !== process.pid ||
      startIdentity === null ||
      scope === null ||
      launch.startIdentity !== startIdentity ||
      launch.scope !== scope ||
      launch.owner !== readRecord(path.join(directory, "owner.json"))
    ) {
      throw new Error("Artifact native entry is outside its admitted process tree");
    }
  }
  const claim = path.join(owner.claimsDirectory, `child-${process.pid}`);
  // A surviving wrapper claim retains ownership for possibly detached compilers.
  fs.writeFileSync(
    claim,
    JSON.stringify({
      pid: process.pid,
      startIdentity: processIdentity?.getProcessInstanceStartTime(process.pid) ?? null,
    }),
    { flag: "wx" },
  );
  inheritedOwner = owner;
  process.argv = [process.execPath, fileURLToPath(script), ...args];
  try {
    await import(script);
  } catch (error) {
    throw retainUnjoinedDistArtifactWork(owner, error);
  } finally {
    inheritedOwner = undefined;
    // The pre-existing claim is the durable fence if recording uncertainty failed.
    if (
      owner.unjoinedError === undefined ||
      fs.existsSync(path.join(owner.claimsDirectory, "unjoined"))
    ) {
      fs.unlinkSync(claim);
    }
  }
}

async function acquireArtifactOwner(
  rootDir: string,
  wait = false,
  signal?: AbortSignal,
  treeOwnership?: "linux-subreaper",
) {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  const ownerPath = path.join(directory, "owner.json");
  let reportedWait = false;
  let owner: unknown;
  let lock: FileLockHandle;
  signal?.throwIfAborted();
  processIdentity ??= await loadDistArtifactIdentity();
  const startIdentity = processIdentity?.getProcessInstanceStartTime(process.pid) ?? null;
  const scope = startIdentity === null ? null : (processIdentity?.readScope() ?? null);
  const custodyId = randomUUID();
  const custody = path.join(directory, custodyId);
  let recovered: string | undefined;
  const unownedClaims = new Error("Artifact claims remain without an owner record");
  try {
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(ownerPath) && hasRetainedEntries(directory)) {
      throw unownedClaims;
    }
    const lockRoot = await openLockRoot(directory);
    while (true) {
      signal?.throwIfAborted();
      try {
        lock = await acquireFileLock(ownerPath, {
          lockPath: ownerPath,
          // Explicit release owns cleanup; detached children can outlive their parent.
          retainOnExit: true,
          lockRoot,
          payload: () => ({
            pid: process.pid,
            startedAt: new Date().toISOString(),
            startIdentity,
            artifactCustody: 1,
            processScope: scope,
            treeOwnership,
            custodyId,
          }),
          // Published updaters call without a signal; retain fs-safe's original wait.
          timeoutMs: wait ? (signal ? LOCK_POLL_MS : Number.POSITIVE_INFINITY) : 0,
          retry: { minTimeout: LOCK_POLL_MS, maxTimeout: LOCK_POLL_MS, factor: 1 },
          staleRecovery: "remove-if-unchanged",
          shouldRemoveStaleLock: ({ raw, payload }) => {
            if (!canRecover(directory, raw, payload, scope)) {
              return false;
            }
            recovered = custodyDirectory(directory, payload);
            return true;
          },
          shouldReclaim: ({ payload }) => {
            owner = payload;
            // fs-safe rechecks exact bytes and complete settlement under its
            // exclusive reclaim guard; this observation alone cannot release.
            try {
              if (canRecover(directory, readRecord(ownerPath), payload, scope)) {
                return true;
              }
            } catch {
              return true;
            }
            const pid =
              payload && typeof payload === "object" && "pid" in payload ? payload.pid : null;
            if (
              typeof pid !== "number" ||
              !Number.isSafeInteger(pid) ||
              pid <= 1 ||
              pid > 0x7fffffff
            ) {
              return true;
            }
            try {
              process.kill(pid, 0);
            } catch {
              return true;
            }
            if (
              isRecord(payload) &&
              typeof payload.startIdentity === "number" &&
              processIdentity?.getProcessInstanceStartTime(pid) !== payload.startIdentity
            ) {
              return true;
            }
            try {
              const existingCustody = custodyDirectory(directory, payload);
              if (
                fs.existsSync(path.join(directory, "unjoined")) ||
                (existingCustody && fs.existsSync(path.join(existingCustody, "unjoined")))
              ) {
                return true;
              }
            } catch {
              // A malformed generation cannot become an indefinitely waiting owner.
              return true;
            }
            if (!reportedWait) {
              console.error(`[dist artifacts] waiting for checkout ownership: ${directory}`);
              reportedWait = true;
            }
            return false;
          },
        });
        break;
      } catch (error) {
        if (
          !wait ||
          !signal ||
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "file_lock_timeout"
        ) {
          throw error;
        }
      }
    }
  } catch (error) {
    if (signal?.aborted && error === signal.reason) {
      throw error;
    }
    if (
      error !== unownedClaims &&
      (!fs.existsSync(ownerPath) ||
        !isRecord(error) ||
        (error.code !== "file_lock_stale" && error.code !== "file_lock_timeout"))
    ) {
      throw new Error(
        `Could not acquire ${directory}: ${String(error)}. Resolve this filesystem error and retry before stopping the Gateway.`,
        { cause: error },
      );
    }
    try {
      owner = JSON.parse(readRecord(ownerPath));
    } catch {
      owner = undefined;
      // Unreadable or replaced owner fields remain unknown; custody stays closed.
    }
    const record = isRecord(owner) ? owner : {};
    const pid = record.pid ?? "unknown";
    const started = record.startedAt ?? "unknown";
    const identity = record.startIdentity ?? record.starttime;
    const heartbeat = record.heartbeatAt ?? record.heartbeat;
    const inspect =
      process.platform === "win32"
        ? "Get-Process -Id <PID>"
        : "ps -o pid,ppid,pgid,lstart,stat,command -p <PID>";
    // This ownership verdict replaces fs-safe's internal stale/timeout fragments.
    throw new DistArtifactCustodyError(
      "Could not acquire " +
        directory +
        ": retained by PID " +
        JSON.stringify(pid) +
        ", started " +
        JSON.stringify(started) +
        ", " +
        (identity == null ? "identity unavailable" : "identity " + JSON.stringify(identity)) +
        ", " +
        (heartbeat == null
          ? "heartbeat unavailable (not recorded)"
          : "heartbeat " + JSON.stringify(heartbeat)) +
        "; custody unresolved. Inspect " +
        ownerPath +
        " and its child/custody records, then inspect the recorded PIDs and process groups with " +
        inspect +
        ". Let the original build/check owner finish and retry. Missing identity or settlement evidence requires independent inspection of detached descendants; PID death alone cannot authorize release.",
      { cause: error },
    );
  }
  if (signal?.aborted) {
    await lock.release();
    signal.throwIfAborted();
  }
  // A crash before this directory exists remains unresolved: no workload was
  // admitted, but a missing custody inventory cannot certify a later recovery.
  fs.mkdirSync(custody);
  const raw = readRecord(ownerPath);
  let nativeRoot: { pid: number; startIdentity: number; scope: string; owner: string } | undefined;
  let launchRecord: string | undefined;
  let released = false;
  let releaseRequested = false;
  let releasing: Promise<void> | undefined;
  const release = (): Promise<void> => {
    releaseRequested = true;
    if (released) {
      return Promise.resolve();
    }
    return (releasing ??= (async () => {
      try {
        if (!(await lock.verifyStillHeld())) {
          throw new Error("Artifact ownership changed before release");
        }
        if (
          hasRetainedEntries(directory) ||
          claimEntries(custody).some((name) => name !== "settled")
        ) {
          throw new Error("Artifact child custody unresolved; ownership retained");
        }
        await lock.release();
        released = true;
        removeRetiredCustody(custody);
      } finally {
        releasing = undefined;
      }
    })());
  };
  if (recovered) {
    try {
      removeRetiredCustody(recovered);
    } catch (error) {
      console.error("[dist artifacts] retired custody cleanup deferred: " + String(error));
    }
  }

  // Acquisition can finish after cancellation; direct callers must never inherit that lock.
  if (signal?.aborted) {
    await release();
    signal.throwIfAborted();
  }
  return {
    custodyId,
    lock: {
      ...lock,
      verifyStillHeld: async () =>
        !releaseRequested && (await lock.verifyStillHeld()) && !releaseRequested,
      release,
      [Symbol.asyncDispose]: release,
    },
    admitNativeRoot: async (pid: number, rootStartIdentity: number) => {
      if (
        !treeOwnership ||
        nativeRoot ||
        releaseRequested ||
        !(await lock.verifyStillHeld()) ||
        releaseRequested
      ) {
        throw new Error("Artifact ownership changed before native root admission");
      }
      if (
        scope === null ||
        processIdentity?.getProcessInstanceStartTime(pid) !== rootStartIdentity
      ) {
        throw new Error("Artifact native root identity changed or is unavailable");
      }
      nativeRoot = { pid, startIdentity: rootStartIdentity, scope, owner: raw };
      launchRecord = JSON.stringify(nativeRoot);
      fs.writeFileSync(path.join(custody, "launch"), launchRecord, { flag: "wx" });
      return custodyId;
    },
    // Private to the native command operation, never a caller-provided assertion.
    async recordNativeSettlement() {
      if (
        !treeOwnership ||
        releaseRequested ||
        !(await lock.verifyStillHeld()) ||
        releaseRequested
      ) {
        throw new Error("Artifact ownership changed before native settlement");
      }
      if (!nativeRoot || readRecord(path.join(custody, "launch")) !== launchRecord) {
        throw new Error("Artifact native root admission changed before settlement");
      }
      const names = claimEntries(custody);
      for (const name of names) {
        if (name === "launch" || name === "unjoined") {
          continue;
        }
        if (
          name !== "child-" + nativeRoot.pid ||
          readRecord(path.join(custody, name)) !==
            JSON.stringify({ pid: nativeRoot.pid, startIdentity: nativeRoot.startIdentity })
        ) {
          throw new Error("Foreign artifact claim remains outside native custody");
        }
      }
      // Only this registered root may create claims in the native generation.
      // Never erase a foreign claimant on the strength of another tree's receipt.
      for (const name of names) {
        fs.unlinkSync(path.join(custody, name));
      }
      fs.writeFileSync(path.join(custody, "settled"), raw);
    },
  };
}

export async function acquireDistArtifactOwnership(
  rootDir: string,
  wait = false,
  signal?: AbortSignal,
): Promise<FileLockHandle> {
  return (await acquireArtifactOwner(rootDir, wait, signal)).lock;
}

/** The callback must join every writer/reader before returning, including on failure. */
export const withDistArtifactOwnership: WithDistArtifactOwnership = async (
  rootDir,
  run,
  signal,
) => {
  const directory = resolveDistArtifactLockPath(fs.realpathSync(rootDir));
  if (directory === inheritedOwner?.directory) {
    if (inheritedOwner.unjoinedError !== undefined) {
      throw inheritedOwner.unjoinedError;
    }
    signal?.throwIfAborted();
    try {
      return await run();
    } catch (error) {
      // A CLI can turn this error into an exit status before the entry launcher sees it.
      // Record uncertain cleanup at the ownership boundary so the parent retains the lock.
      throw retainUnjoinedDistArtifactWork(inheritedOwner, error);
    }
  }
  const lock = await acquireDistArtifactOwnership(rootDir, true, signal);
  const owner = readArtifactOwner(directory);
  try {
    signal?.throwIfAborted();
    return await run();
  } catch (error) {
    throw retainUnjoinedDistArtifactWork(owner, error);
  } finally {
    if (owner.unjoinedError !== undefined || hasRetainedEntries(owner.claimsDirectory)) {
      console.error(`[dist artifacts] child cleanup unverified; retained ${directory}`);
    } else {
      await lock.release();
    }
  }
};

/** Run the audited one-shot compiler entry as one native-owned tree. Generic callbacks
 * and source-update entries that delegate services do not receive this contract.
 */
export async function runNativeTsgoArtifactEntry(
  rootDir: string,
  args: string[],
  compilerPath: string,
): Promise<number | undefined> {
  const root = fs.realpathSync(rootDir);
  if (
    process.platform !== "linux" ||
    process.versions.bun ||
    process.stdin.isTTY ||
    process.stdout.isTTY ||
    process.stderr.isTTY ||
    process.env.OPENCLAW_TSGO_METRICS_DIR?.trim() ||
    args.some((arg) => /^(?:--?(?:api|lsp|watch)|-w)(?:=|$)/i.test(arg)) ||
    inheritedOwner?.directory === resolveDistArtifactLockPath(root) ||
    !import.meta.url.endsWith("/scripts/lib/dist-artifact-lock.mts")
  ) {
    return undefined;
  }
  const require = createRequire(import.meta.url);
  try {
    require.resolve("tsdown");
    require.resolve("koffi");
  } catch {
    // Partial/sparse compiler checkouts still support the original group owner.
    return undefined;
  }
  const { hasUntrackedRuntimeInputs } = await import("./vitest-worker-cache-policy.mts");
  // A caller's injected loader/preload can launch outside the audited entry.
  // Preserve ordinary explicit release rather than certify that unknown closure.
  if (hasUntrackedRuntimeInputs(process.env, process.execArgv)) {
    return undefined;
  }
  processIdentity ??= await loadDistArtifactIdentity();
  if (!processIdentity || (processIdentity?.readScope() ?? null) === null) {
    return undefined;
  }
  // Declaration and generic callback writers never enter this source-only branch.
  // Its native compiler profile owns and verifies the complete execution closure.
  const nativeRuntimeHref = new URL("./dist-artifact-native.mts", import.meta.url).href;
  const native: { runNativeArtifactOperation: typeof runNativeArtifactOperation } = await import(
    nativeRuntimeHref
  );
  return await native.runNativeArtifactOperation(root, args, compilerPath, () =>
    acquireArtifactOwner(root, true, undefined, "linux-subreaper"),
  );
}
