import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { getOrCreatePromise } from "../shared/lazy-promise.js";
import {
  localAgentAvatarRevision,
  type LocalAgentAvatarRead,
  type LocalAgentAvatarResult,
  type LocalAgentAvatarSnapshot,
} from "./identity-avatar-file.js";

type LoadedAvatar = Extract<LocalAgentAvatarResult, { ok: true }>;
type AvatarRuntime = {
  pool?: WorkerTaskPool<LocalAgentAvatarRead, LocalAgentAvatarSnapshot>;
  closing?: Promise<void>;
  pending: Map<string, Promise<LocalAgentAvatarResult>>;
  cached: Map<string, LoadedAvatar>;
  bytes: number;
};
const MAX_AVATAR_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_AVATAR_CACHE_ENTRIES = 64;

export function prepareLocalAgentAvatar(
  input: LocalAgentAvatarRead,
): Promise<LocalAgentAvatarResult> {
  const runtime = resolveGlobalSingleton<AvatarRuntime>(
    Symbol.for("openclaw.localAgentAvatars"),
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
    return Promise.reject(new WorkerTaskError("Avatar reader is closing", "unavailable"));
  }
  const key = JSON.stringify([input.workspaceDir, input.source, input.readBody]);
  return getOrCreatePromise(
    runtime.pending,
    key,
    async () => {
      const previous = runtime.cached.get(key);
      const pool = (runtime.pool ??= new WorkerTaskPool({
        workerUrl: resolveRuntimeProcessEntrypointUrl("localAgentAvatar"),
        maxWorkers: 2,
        sharedCompute: true,
        maxPendingTasks: 256,
        maxPendingBytes: 1024 * 1024,
      }));
      const knownRevision = previous ? localAgentAvatarRevision(previous.file) : undefined;
      const result = await pool.run(
        { ...input, knownRevision },
        { inputBytes: 2 * (key.length + (knownRevision?.length ?? 0)) },
      );
      let prepared: LocalAgentAvatarResult | undefined = previous;
      if (!("kind" in result)) {
        prepared = result.ok
          ? {
              ok: true,
              file: {
                ...result.file,
                body: result.file.body
                  ? Buffer.from(
                      result.file.body.buffer,
                      result.file.body.byteOffset,
                      result.file.body.byteLength,
                    )
                  : undefined,
              },
            }
          : result;
      }
      if (!prepared) {
        throw new Error("Avatar reader returned an unknown revision");
      }
      const retained = runtime.cached.get(key);
      if (retained) {
        runtime.cached.delete(key);
        runtime.bytes -= retained.file.body?.byteLength ?? 0;
      }
      if (prepared.ok) {
        runtime.cached.set(key, prepared);
        runtime.bytes += prepared.file.body?.byteLength ?? 0;
        while (
          runtime.bytes > MAX_AVATAR_CACHE_BYTES ||
          runtime.cached.size > MAX_AVATAR_CACHE_ENTRIES
        ) {
          const oldest = runtime.cached.entries().next().value;
          if (!oldest) {
            break;
          }
          runtime.cached.delete(oldest[0]);
          runtime.bytes -= oldest[1].file.body?.byteLength ?? 0;
        }
      }
      return prepared;
    },
    { evictOnSettled: true },
  );
}
