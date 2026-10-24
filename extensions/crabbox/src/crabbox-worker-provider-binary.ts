import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";

export function createCrabboxWorkerBinaryResolver(dependencies: {
  openclawRoot: string;
  signal: AbortSignal;
  warn: (message: string) => void;
}) {
  const pathEnv = process.env.PATH;
  const binaries = new Map<string, Promise<CrabboxBinary>>();
  const reportedFallbacks = new Set<string>();
  let defaultCandidate: string | undefined;
  return {
    async resolve(this: void, explicit?: string, signal?: AbortSignal): Promise<CrabboxBinary> {
      signal?.throwIfAborted();
      const candidate =
        explicit ??
        (defaultCandidate ??= resolveCrabboxBinary({
          openclawRoot: dependencies.openclawRoot,
          pathEnv,
        }));
      // Completed acquisition remains usable by cleanup after provider disposal.
      let resolution = binaries.get(candidate);
      if (!resolution) {
        dependencies.signal.throwIfAborted();
        resolution = ensureManagedCrabboxBinary({
          binary: candidate,
          signal: dependencies.signal,
        })
          .then((resolved) => {
            dependencies.signal.throwIfAborted();
            return resolved;
          })
          .catch((error: unknown) => {
            binaries.delete(candidate);
            throw error;
          });
        binaries.set(candidate, resolution);
      }
      // Cancelling one waiter must not cancel provider-owned acquisition.
      const resolved = await racePromiseWithAbortSignal(resolution, signal, ({ reason }) =>
        toErrorObject(reason, "Crabbox acquisition aborted"),
      );
      signal?.throwIfAborted();
      // Implicit discovery may populate the cache before an explicit profile consumes it.
      if (explicit && resolved.rejected && !reportedFallbacks.has(candidate)) {
        reportedFallbacks.add(candidate);
        dependencies.warn(resolved.rejected);
      }
      return resolved;
    },
    async settle() {
      await Promise.allSettled(binaries.values());
    },
  };
}
