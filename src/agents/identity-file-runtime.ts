import path from "node:path";
import { LruCache } from "../infra/lru-cache.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { IdentityFileRead, IdentityFileSnapshot } from "./identity-file.js";

type PreparedIdentityFile = Exclude<IdentityFileSnapshot, { kind: "unchanged" }>;
type LoadedIdentityFile = Extract<IdentityFileSnapshot, { kind: "loaded" }>;
type IdentityRuntime = {
  pool?: WorkerTaskPool<IdentityFileRead, IdentityFileSnapshot>;
  closing?: Promise<void>;
  pending: Map<string, Promise<PreparedIdentityFile>>;
  cached: LruCache<LoadedIdentityFile>;
};
const MAX_IDENTITY_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_CACHE_ENTRIES = 64;

export function prepareIdentityFile(identityPath: string): Promise<PreparedIdentityFile> {
  const runtime = resolveGlobalSingleton<IdentityRuntime>(
    Symbol.for("openclaw.identityFiles"),
    () => ({
      pending: new Map(),
      cached: new LruCache<LoadedIdentityFile>(MAX_IDENTITY_CACHE_ENTRIES, {
        maxBytes: MAX_IDENTITY_CACHE_BYTES,
        sizeOf: (entry) => entry.size,
      }),
    }),
    (state) => {
      state.closing ??= (async () => {
        await state.pool?.close();
        await Promise.allSettled(state.pending.values());
        state.pool = undefined;
        state.cached.clear();
      })().finally(() => {
        state.closing = undefined;
      });
      return state.closing;
    },
  );
  if (runtime.closing) {
    return Promise.reject(new WorkerTaskError("Identity file reader is closing", "unavailable"));
  }
  const filePath = path.resolve(identityPath);
  return getOrCreatePromise(
    runtime.pending,
    filePath,
    async () => {
      const previous = runtime.cached.peek(filePath);
      const pool = (runtime.pool ??= new WorkerTaskPool({
        workerUrl: resolveRuntimeProcessEntrypointUrl("identityFile"),
        workerClass: "file-reader",
        sharedCompute: true,
        maxPendingTasks: 256,
        maxPendingBytes: 1024 * 1024,
      }));
      const result = await pool.run(
        { identityPath: filePath, knownRevision: previous?.revision },
        { inputBytes: 2 * (filePath.length + (previous?.revision.length ?? 0)) },
      );
      const prepared = result.kind === "unchanged" ? previous : result;
      if (!prepared) {
        throw new Error("Identity file reader returned an unknown revision");
      }
      if (prepared.kind === "loaded") {
        runtime.cached.set(filePath, prepared);
      } else {
        runtime.cached.delete(filePath);
      }
      return prepared;
    },
    { evictOnSettled: true },
  );
}
