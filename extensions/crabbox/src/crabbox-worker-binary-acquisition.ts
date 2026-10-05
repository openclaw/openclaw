import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { racePromiseWithAbortSignal } from "openclaw/plugin-sdk/time-runtime";
import { resolveCrabboxBinary } from "./crabbox-binary.js";
import { ensureManagedCrabboxBinary } from "./crabbox-managed-binary.js";
import type { CrabboxCommandRunner } from "./crabbox-worker-command.js";
import type { CrabboxWorkerProviderDependencies } from "./crabbox-worker-provider.types.js";

export function createCrabboxBinaryAcquisition(
  options: Pick<CrabboxWorkerProviderDependencies, "isExecutable" | "pathEnv" | "platform"> & {
    openclawRoot: string;
    runCommand: CrabboxCommandRunner;
    providerSignal: AbortSignal;
  },
) {
  const { runCommand } = options;
  const binaries = new Map<string, Promise<string>>();
  let defaultCandidate: string | undefined;
  const resolveBinary = async (explicit?: string, signal?: AbortSignal): Promise<string> => {
    signal?.throwIfAborted();
    const candidate =
      explicit ??
      (defaultCandidate ??= resolveCrabboxBinary({
        isExecutable: options.isExecutable,
        openclawRoot: options.openclawRoot,
        pathEnv: options.pathEnv ?? process.env.PATH,
        platform: options.platform,
      }));
    // Completed acquisition remains usable by lease cleanup after provider disposal.
    let resolution = binaries.get(candidate);
    if (!resolution) {
      options.providerSignal.throwIfAborted();
      // Acquisition belongs to the provider; cancelling one waiter cannot cancel discovery.
      resolution = ensureManagedCrabboxBinary({
        binary: candidate,
        runCommand,
        signal: options.providerSignal,
      })
        .then(({ binary }) => {
          options.providerSignal.throwIfAborted();
          return binary;
        })
        .catch((error: unknown) => {
          binaries.delete(candidate);
          throw error;
        });
      binaries.set(candidate, resolution);
    }
    const binary = await racePromiseWithAbortSignal(resolution, signal, ({ reason }) =>
      toErrorObject(reason, "Crabbox acquisition aborted"),
    );
    signal?.throwIfAborted();
    return binary;
  };
  return { resolveBinary, settle: () => Promise.allSettled(binaries.values()) };
}
