import path from "node:path";
import { LruCache } from "../infra/lru-cache.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import type { LocalAgentAvatarRead, LocalAgentAvatarSnapshot } from "./identity-avatar-file.js";
import type { IdentityFileRead, IdentityFileSnapshot } from "./identity-file.js";

type PreparedIdentityFile = Exclude<IdentityFileSnapshot, { kind: "unchanged" }>;
type LoadedIdentityFile = Extract<IdentityFileSnapshot, { kind: "loaded" }>;
type IdentityReadWorkers = {
  identityFile: { input: IdentityFileRead; snapshot: IdentityFileSnapshot };
  localAgentAvatar: { input: LocalAgentAvatarRead; snapshot: LocalAgentAvatarSnapshot };
};
type IdentityReadRuntime<Worker extends keyof IdentityReadWorkers, Result, Loaded> = {
  pool?: WorkerTaskPool<
    IdentityReadWorkers[Worker]["input"],
    IdentityReadWorkers[Worker]["snapshot"]
  >;
  closing?: Promise<void>;
  pending: Map<string, Promise<Result>>;
  cached: LruCache<Loaded>;
};

/** Identity metadata and avatar bytes share admission and cache settlement, not file policy. */
export function prepareCachedIdentityRead<
  Worker extends keyof IdentityReadWorkers,
  Result,
  Loaded extends Result,
>(params: {
  runtimeKey: symbol;
  worker: Worker;
  readerName: "Identity file reader" | "Avatar reader";
  key: () => string;
  input: (key: string, knownRevision: string | undefined) => IdentityReadWorkers[Worker]["input"];
  revision: (entry: Loaded) => string;
  sizeOf: (entry: Loaded) => number;
  prepare: (
    snapshot: IdentityReadWorkers[Worker]["snapshot"],
    previous: Loaded | undefined,
  ) => Result | undefined;
  isLoaded: (result: Result) => result is Loaded;
}): Promise<Result> {
  const runtime = resolveGlobalSingleton<IdentityReadRuntime<Worker, Result, Loaded>>(
    params.runtimeKey,
    () => ({
      pending: new Map(),
      cached: new LruCache<Loaded>(64, {
        maxBytes: 16 * 1024 * 1024,
        sizeOf: params.sizeOf,
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
    return Promise.reject(new WorkerTaskError(`${params.readerName} is closing`, "unavailable"));
  }
  const key = params.key();
  return getOrCreatePromise(
    runtime.pending,
    key,
    async () => {
      const previous = runtime.cached.peek(key);
      const pool = (runtime.pool ??= new WorkerTaskPool<
        IdentityReadWorkers[Worker]["input"],
        IdentityReadWorkers[Worker]["snapshot"]
      >({
        workerUrl: resolveRuntimeProcessEntrypointUrl(params.worker),
        workerClass: "file-reader",
        sharedCompute: true,
        maxPendingTasks: 256,
        maxPendingBytes: 1024 * 1024,
      }));
      const knownRevision = previous ? params.revision(previous) : undefined;
      const result = await pool.run(params.input(key, knownRevision), {
        inputBytes: 2 * (key.length + (knownRevision?.length ?? 0)),
      });
      const prepared = params.prepare(result, previous);
      if (!prepared) {
        throw new Error(`${params.readerName} returned an unknown revision`);
      }
      if (params.isLoaded(prepared)) {
        runtime.cached.set(key, prepared);
      } else {
        runtime.cached.delete(key);
      }
      return prepared;
    },
    { evictOnSettled: true },
  );
}

export function prepareIdentityFile(identityPath: string): Promise<PreparedIdentityFile> {
  return prepareCachedIdentityRead<"identityFile", PreparedIdentityFile, LoadedIdentityFile>({
    runtimeKey: Symbol.for("openclaw.identityFiles"),
    worker: "identityFile",
    readerName: "Identity file reader",
    key: () => path.resolve(identityPath),
    input: (filePath, knownRevision) => ({ identityPath: filePath, knownRevision }),
    revision: (entry) => entry.revision,
    sizeOf: (entry) => entry.size,
    prepare: (result, previous) => (result.kind === "unchanged" ? previous : result),
    isLoaded: (result): result is LoadedIdentityFile => result.kind === "loaded",
  });
}
