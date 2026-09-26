import path from "node:path";
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
  cached: Map<string, LoadedIdentityFile>;
  bytes: number;
};
const MAX_IDENTITY_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_IDENTITY_CACHE_ENTRIES = 64;

export function prepareIdentityFile(identityPath: string): Promise<PreparedIdentityFile> {
  const runtime = resolveGlobalSingleton<IdentityRuntime>(
    Symbol.for("openclaw.identityFiles"),
    () => ({ pending: new Map(), cached: new Map(), bytes: 0 }),
    (state) => {
      state.closing ??= (async () => {
        await state.pool?.close();
        await Promise.allSettled(state.pending.values());
        state.pool = undefined;
        state.cached.clear();
        state.bytes = 0;
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
      const previous = runtime.cached.get(filePath);
      const pool = (runtime.pool ??= new WorkerTaskPool({
        workerUrl: resolveRuntimeProcessEntrypointUrl("identityFile"),
        maxWorkers: 2,
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
      const retained = runtime.cached.get(filePath);
      if (retained) {
        runtime.cached.delete(filePath);
        runtime.bytes -= retained.size;
      }
      if (prepared.kind === "loaded") {
        runtime.cached.set(filePath, prepared);
        runtime.bytes += prepared.size;
        while (
          runtime.bytes > MAX_IDENTITY_CACHE_BYTES ||
          runtime.cached.size > MAX_IDENTITY_CACHE_ENTRIES
        ) {
          const oldest = runtime.cached.entries().next().value;
          if (!oldest) {
            break;
          }
          runtime.cached.delete(oldest[0]);
          runtime.bytes -= oldest[1].size;
        }
      }
      return prepared;
    },
    { evictOnSettled: true },
  );
}
