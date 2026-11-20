import { spawnSync, type ChildProcess } from "node:child_process";
import {
  finalizeManagedChild,
  hasUnjoinedWork,
  runManagedCommand,
} from "../lib/managed-child-process.mts";
import { claimManagedCleanup, failManagedCleanup } from "../lib/managed-cleanup-handoff.mts";

/** The detached Gateway must finish cleanup before the parent can release build inputs. */
export async function createWarmReloadGatewayOwner(signal: AbortSignal) {
  await claimManagedCleanup();
  signal.throwIfAborted();
  let child: ChildProcess | undefined;
  let closed = false;
  const closedOutputs = new Set<string>();
  let stopping: Promise<void> | undefined;
  let finished = false;
  let joined = true;
  const stop = () => {
    if (!child) {
      return Promise.resolve();
    }
    const owned = child;
    if (!owned.pid) {
      // Failed spawn still owns stdio handles until close, but no process group.
      return (stopping ??= new Promise<void>((resolve) => {
        const finish = () => {
          joined = true;
          resolve();
        };
        if (closed) {
          finish();
        } else {
          owned.once("close", finish);
        }
      }));
    }
    return (stopping ??= finalizeManagedChild(owned, "SIGTERM", {
      platform: process.platform,
      runTaskkill: spawnSync,
      forceKillDelayMs: 10_000,
      drainTimeoutMs: 1_000,
      isChildClosed: () => closed,
      areOutputPipesClosed: () => closedOutputs.size === 2,
    }).then(
      () => {
        joined = true;
      },
      (error: unknown) => {
        failManagedCleanup();
        owned.unref();
        throw error;
      },
    ));
  };
  const interrupt = () => {
    // Finally observes the same rejection; the signal callback must not create
    // an unhandled rejection or a second process-tree finalizer.
    void stop().catch(() => {});
  };
  signal.addEventListener("abort", interrupt, { once: true });
  return {
    start(spawn: () => ChildProcess) {
      signal.throwIfAborted();
      if (child || finished) {
        throw new Error("Warm reload Gateway admission is closed");
      }
      child = spawn();
      joined = false;
      child.once("close", () => {
        closed = true;
      });
      for (const name of ["stdout", "stderr"] as const) {
        const output = child[name];
        if (output) {
          output.once("close", () => closedOutputs.add(name));
        } else {
          closedOutputs.add(name);
        }
      }
      return child;
    },
    joined: () => joined,
    async close() {
      finished = true;
      try {
        await stop();
      } finally {
        signal.removeEventListener("abort", interrupt);
      }
    },
  };
}

/** Capture CLI output only after its process tree and native output handles settle. */
export async function runWarmReloadCli(
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; signal: AbortSignal },
) {
  const overflow = new AbortController();
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const bytes = { stdout: 0, stderr: 0 };
  let status: number;
  try {
    status = await runManagedCommand({
      bin: process.execPath,
      args,
      ...options,
      signal: AbortSignal.any([options.signal, overflow.signal]),
      timeoutMs: 120_000,
      requireProcessTreeExit: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      onReady(child) {
        for (const [name, chunks] of [
          ["stdout", stdout],
          ["stderr", stderr],
        ] as const) {
          child[name]?.on("data", (chunk: Buffer) => {
            bytes[name] += chunk.length;
            if (bytes[name] > 10 * 1024 * 1024) {
              overflow.abort();
            } else {
              chunks.push(chunk);
            }
          });
        }
      },
    });
  } catch (error) {
    if (overflow.signal.aborted && !hasUnjoinedWork(error)) {
      throw new Error("Warm reload CLI output exceeded 10 MiB", { cause: error });
    }
    throw error;
  }
  options.signal.throwIfAborted();
  if (status !== 0) {
    throw new Error(
      `Warm reload CLI failed (${status}): ${Buffer.concat(stderr).toString("utf8")}`,
    );
  }
  return Buffer.concat(stdout).toString("utf8");
}
