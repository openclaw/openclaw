import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireFileLock } from "@openclaw/fs-safe/file-lock";
import { root as openLockRoot } from "@openclaw/fs-safe/root";
import { runCancelableCommand } from "./cancelable-command.mts";
import {
  hasUnjoinedWork,
  runManagedCommand,
  type RunManagedCommandOptions,
} from "./managed-child-process.mts";
import { readProcessMemoryCapacity } from "./process-memory.mts";

/** One semantic leaf per host/account, across clones; artifact owners acquire first. */
export async function runSemanticCheck(
  options: Omit<RunManagedCommandOptions, "memoryLimitBytes" | "platform">,
): Promise<number> {
  if (process.platform !== "linux") {
    console.error(
      "[memory] Semantic checks require verified Linux kernel containment. Use `node scripts/crabbox-wrapper.mjs run -- <command>` or a memory-limited Linux VM. Unbounded native execution was refused.",
    );
    return 75;
  }
  const command = {
    ...options,
    args: options.args?.slice(),
    cwd: path.resolve(options.cwd ?? process.cwd()),
    env: { ...(options.env ?? process.env) },
  };
  // OS account identity prevents per-task HOME/TMPDIR from creating competing slots.
  const directory = path.join(os.userInfo().homedir, ".cache", "openclaw", "semantic-checks");
  const lockPath = path.join(directory, `${os.hostname()}.lock`);
  const scopeReceipt = path.join(directory, `${randomUUID()}.scope-owner`);
  const startedAt = Date.now();
  const timeoutMs = options.timeoutMs ?? 900_000;
  return await runCancelableCommand(async (ownerSignal) => {
    const signal = options.signal ? AbortSignal.any([options.signal, ownerSignal]) : ownerSignal;
    let lock: Awaited<ReturnType<typeof acquireFileLock>> | undefined;
    let joined = true;
    let receiptCreated = false;
    let waitingReported = false;
    const run = async () => {
      try {
        signal.throwIfAborted();
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
        const lockRoot = await openLockRoot(directory);
        // fs-safe has no abort API. Join every bounded attempt: an abandoned
        // acquisition could admit a canceled command after its owner has returned.
        while (!lock) {
          signal.throwIfAborted();
          const remaining = timeoutMs - (Date.now() - startedAt);
          if (remaining <= 0) {
            console.error(
              "[memory] Timed out waiting for the host's semantic check. Use a bounded remote worker.",
            );
            return 75;
          }
          try {
            lock = await acquireFileLock(lockPath, {
              lockPath,
              lockRoot,
              retainOnExit: true,
              staleRecovery: "fail-closed",
              timeoutMs: Math.min(250, remaining),
              retry: { minTimeout: 50, maxTimeout: 50, factor: 1 },
              payload: () => ({
                pid: process.pid,
                startedAt,
                scopeReceipt: path.basename(scopeReceipt),
              }),
              shouldReclaim: ({ payload }) => {
                if (
                  !payload ||
                  typeof payload !== "object" ||
                  !("pid" in payload) ||
                  typeof payload.pid !== "number" ||
                  !Number.isSafeInteger(payload.pid) ||
                  payload.pid <= 1 ||
                  payload.pid > 0x7fffffff
                ) {
                  return true;
                }
                try {
                  process.kill(payload.pid, 0);
                  return false;
                } catch {
                  return true;
                }
              },
            });
          } catch (error) {
            if (
              !error ||
              typeof error !== "object" ||
              !("code" in error) ||
              error.code !== "file_lock_timeout"
            ) {
              throw error;
            }
            if (!waitingReported) {
              console.error("[memory] waiting for the host's active semantic check");
              waitingReported = true;
            }
          }
        }
        signal.throwIfAborted();
        const memory = readProcessMemoryCapacity({});
        // Capacity fallback is not remaining memory. Unknown host/controller
        // usage must refuse admission even when a finite ceiling was observed.
        const memoryLimitBytes =
          memory.availableBytes !== null && memory.usageKnown
            ? Math.floor(
                Math.min(
                  8 * 1024 ** 3,
                  (memory.capacityBytes ?? 0) / 2,
                  (memory.limitBytes ?? 0) / 2,
                ),
              )
            : 0;
        const remainingMs = timeoutMs - (Date.now() - startedAt);
        if (memoryLimitBytes < 512 * 1024 ** 2 || remainingMs <= 0) {
          console.error(
            "[memory] Unknown or insufficient memory headroom, or expired admission time; command was not started. Retry when the current check finishes or use a bounded remote worker.",
          );
          return 75;
        }
        console.error(
          `[memory] semantic process-tree limit ${Math.floor(memoryLimitBytes / 1024 ** 2)} MiB; one host/account slot`,
        );
        return await runManagedCommand({
          ...command,
          signal,
          timeoutMs: remainingMs,
          memoryLimitBytes,
          onMemoryScope(unit) {
            // fs-safe ownership bytes are immutable. Record the kernel owner's
            // generated identity before launch, so a killed supervisor remains recoverable.
            fs.writeFileSync(scopeReceipt, unit + "\n", { flag: "wx", mode: 0o600 });
            receiptCreated = true;
            command.onMemoryScope?.(unit);
          },
        });
      } catch (error) {
        joined = !hasUnjoinedWork(error);
        throw error;
      } finally {
        if (joined) {
          await lock?.release();
          // Release first: a crash may leave a harmless receipt, never a held
          // admission lock with its only scope identity already deleted.
          if (receiptCreated) {
            fs.unlinkSync(scopeReceipt);
          }
        } else {
          console.error(
            `[memory] retained admission after unverified cleanup: ${lockPath}; scope receipt ${scopeReceipt}`,
          );
        }
      }
    };
    const status = await run();
    signal.throwIfAborted();
    return status;
  });
}
