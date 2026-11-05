import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
/**
 * Per-file mutation queue.
 *
 * Serializes reads and mutations targeting the same real file while allowing independent files to run in parallel.
 */
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { enqueueKeyedTask } from "../../../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../../shared/global-singleton.js";

const fileMutationTails = resolveGlobalMap<string, Promise<void>>(
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
): Promise<T> {
  return await withFileMutationQueueKeysResolution(
    keyResolution.then((key) => [key]),
    fn,
  );
}

export async function withFileMutationQueueKeysResolution<T>(
  keysResolution: Promise<readonly string[]>,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = getAgentToolExecutionContext()?.assistantMessage ?? keyAdmissions.fallbackScope;
  void keysResolution.catch(() => undefined);
  let operation!: Promise<T>;
  const admission = enqueueKeyedTask({
    tails: keyAdmissions.tails,
    key: scope,
    task: async () => {
      const keys = await keysResolution;
      operation = enqueueKeyedTask({
        tails: fileMutationTails,
        keys: [...new Set(keys)].toSorted(),
        task: fn,
      });
    },
  });
  await admission;
  return await operation;
}
