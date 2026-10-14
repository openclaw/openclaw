import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import { ensureManagedCrabboxBinary, type CrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";

export function createCrabboxWorkerBinaryResolver(dependencies: {
  isExecutable?: (candidate: string) => boolean;
  openclawRoot: string;
  pathEnv?: string;
  platform?: NodeJS.Platform;
  runCommand: CrabboxCommandRunner;
  signal: AbortSignal;
}) {
  const binaries = new Map<string, Promise<CrabboxBinary>>();
  let defaultCandidate: string | undefined;
  return {
    async resolve(this: void, explicit?: string, signal?: AbortSignal): Promise<CrabboxBinary> {
      signal?.throwIfAborted();
      const candidate = explicit ?? (defaultCandidate ??= resolveCrabboxBinary(dependencies));
      // Completed acquisition remains usable by cleanup after provider disposal.
      let resolution = binaries.get(candidate);
      if (!resolution) {
        dependencies.signal.throwIfAborted();
        resolution = ensureManagedCrabboxBinary({
          binary: candidate,
          runCommand: dependencies.runCommand,
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
      return resolved;
    },
    async settle() {
      await Promise.allSettled(binaries.values());
    },
  };
}
