import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
import { racePromiseWithAbortSignal } from "../../../../packages/retry/src/index.js";
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { resolveGlobalSingleton } from "../../../shared/global-singleton.js";
import { createKeyedFifoLeaseRegistry } from "../../../shared/keyed-fifo-lease.js";
import { ToolInputError } from "../../tool-input-error.js";

const fileLeases = createKeyedFifoLeaseRegistry(Symbol.for("openclaw.fileMutationLeases"));
const keyAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.fileMutationKeyAdmissions"),
  () => ({ fallbackScope: {}, tails: new WeakMap<object, Promise<void>>() }),
);
const FILE_QUEUE_WAIT_MS = 3 * 60_000;

export async function resolveFileMutationQueueKey(
  filePath: string,
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  return await (resolveQueueKey?.(filePath, signal) ??
    resolveIdentityPathViaExistingAncestorSync(filePath));
}

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

/** Order physical reservations by source call, even when backend identity resolves out of order. */
export async function withFileMutationQueueKeysResolution<T>(
  keysResolution: Promise<readonly string[]>,
  fn: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const scope = getAgentToolExecutionContext()?.assistantMessage ?? keyAdmissions.fallbackScope;
  const previousAdmission = keyAdmissions.tails.get(scope) ?? Promise.resolve();
  const deadline = new AbortController();
  const timer = setTimeout(
    () =>
      deadline.abort(
        new ToolInputError(
          "The file operation is still waiting for access. Retry later, work on another file, or ask the operator to restart the Gateway if this persists.",
        ),
      ),
    FILE_QUEUE_WAIT_MS,
  );
  timer.unref();
  const waiting = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  void keysResolution.catch(() => undefined);
  const admission = previousAdmission.then(async () => {
    const keys = await racePromiseWithAbortSignal(
      keysResolution,
      waiting,
      (aborted) => aborted.reason,
    );
    waiting.throwIfAborted();
    return fileLeases.reserve(keys);
  });
  const tail = admission.then(
    () => undefined,
    () => undefined,
  );
  keyAdmissions.tails.set(scope, tail);
  void tail.then(() => {
    if (keyAdmissions.tails.get(scope) === tail) {
      keyAdmissions.tails.delete(scope);
    }
  });
  let lease: Awaited<typeof admission>;
  try {
    lease = await racePromiseWithAbortSignal(admission, waiting, (aborted) => aborted.reason);
    await lease?.wait(waiting);
    waiting.throwIfAborted();
  } catch (error) {
    // An abort can race the reservation receipt, but must never release a predecessor.
    void admission.then(
      (reserved) => reserved?.release(),
      () => {},
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
  try {
    return await fn();
  } finally {
    lease?.release();
  }
}
