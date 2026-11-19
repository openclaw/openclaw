import { createHash } from "node:crypto";
import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { racePromiseWithAbortSignal } from "../../../infra/abort-signal.js";
/**
 * Per-file mutation queue.
 *
 * Serializes reads and mutations targeting the same real file while allowing independent files to run in parallel.
 */
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/path-existence.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { enqueueKeyedTask } from "../../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { ToolInputError } from "../../tool-input-error.js";

type FileMutationTail = Promise<void> & { runningSince: () => number | undefined };
const log = createSubsystemLogger("agents/file-queue");
// File operations should take seconds. Surface contention well before the
// 15-minute reply watchdog, without releasing a still-running writer.
const FILE_QUEUE_WAIT_MS = 3 * 60_000;

const fileMutationTails = resolveGlobalMap<string, FileMutationTail>(
  Symbol.for("openclaw.fileMutationTails"),
  "close-only",
);
const keyAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.fileMutationKeyAdmissions"),
  () => ({ fallbackScope: {}, tails: new WeakMap<object, Promise<void>>() }),
);

export async function resolveFileMutationQueueKey(
  filePath: string,
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  return await (resolveQueueKey?.(filePath, signal) ??
    resolveIdentityPathViaExistingAncestorSync(filePath));
}

/**
 * Preserve source-call admission while backend-owned physical identities resolve concurrently.
 * Registration is ordered per assistant message; file operations still use only fileMutationTails.
 */
export async function withFileMutationQueueKeyResolution<T>(
  keyResolution: Promise<string>,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return await withFileMutationQueueKeysResolution(
    keyResolution.then((key) => [key]),
    fn,
    signal,
  );
}

export async function withFileMutationQueueKeysResolution<T>(
  keysResolution: Promise<readonly string[]>,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scope = getAgentToolExecutionContext()?.assistantMessage ?? keyAdmissions.fallbackScope;
  void keysResolution.catch(() => undefined);
  let operation!: Promise<T>;
  const admission = enqueueKeyedTask({
    tails: keyAdmissions.tails,
    key: scope,
    signal,
    task: async () => {
      const keys = [
        ...new Set(await racePromiseWithAbortSignal(keysResolution, signal)),
      ].toSorted();
      let predecessors = keys.flatMap((key) => {
        const tail = fileMutationTails.get(key);
        return tail ? [{ key, tail }] : [];
      });
      const queuedAt = Date.now();
      let startedAt: number | undefined;
      const timeout = new AbortController();
      const waitingSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
      const runningSince = (): number | undefined => {
        const starts = predecessors.flatMap(({ tail }) => {
          const start = tail.runningSince();
          return start === undefined ? [] : [start];
        });
        return startedAt ?? (starts.length ? Math.min(...starts) : undefined);
      };
      const firstPredecessor = predecessors[0];
      const timer = firstPredecessor
        ? setTimeout(() => {
            const now = Date.now();
            const blocker =
              predecessors.find(({ tail }) => tail.runningSince() !== undefined) ??
              firstPredecessor;
            const holderAgeMs = now - (blocker.tail.runningSince() ?? queuedAt);
            log.warn("File queue wait expired", {
              keyHash: createHash("sha256").update(blocker.key).digest("hex").slice(0, 16),
              holderAgeMs,
              waitMs: now - queuedAt,
            });
            timeout.abort(
              new ToolInputError(
                `The file is busy with an earlier operation that has not finished (running for ${Math.floor(holderAgeMs / 1000)} seconds). Retry later, work on another file, or ask the operator to restart the Gateway if this persists.`,
              ),
            );
          }, FILE_QUEUE_WAIT_MS)
        : undefined;
      operation = enqueueKeyedTask({
        tails: {
          get: (key: string) => fileMutationTails.get(key),
          set: (key: string, tail: Promise<void>) => {
            void tail.then(() => {
              predecessors = [];
              startedAt = undefined;
            });
            fileMutationTails.set(key, Object.assign(tail, { runningSince }));
          },
          delete: (key: string) => fileMutationTails.delete(key),
        },
        keys,
        signal: waitingSignal,
        task: async () => {
          clearTimeout(timer);
          predecessors = [];
          startedAt = Date.now();
          return fn();
        },
      })
        .catch((error: unknown) => {
          if (timeout.signal.aborted) {
            throw timeout.signal.reason;
          }
          throw error;
        })
        .finally(() => clearTimeout(timer));
    },
  });
  await admission;
  return await operation;
}
