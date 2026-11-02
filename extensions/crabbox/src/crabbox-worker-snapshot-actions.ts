import { coerceErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseCrabboxProfile } from "./crabbox-worker-profile.js";
import type { createCrabboxWarmImageManager } from "./crabbox-worker-warm-image.js";

type WarmImageManager = ReturnType<typeof createCrabboxWarmImageManager>;
type Profiles = readonly Parameters<typeof parseCrabboxProfile>[0][];

export type CrabboxSnapshotActions = {
  pin: WarmImageManager["pin"];
  rollback: WarmImageManager["rollback"];
  delete: (checkpointId: string, profiles: Profiles) => Promise<{ status: "deleted" | "retiring" }>;
};

export async function resolveCrabboxCheckpointBinaries(params: {
  profiles: Profiles;
  signal: AbortSignal;
  resolveBinary: (explicit: string | undefined, signal: AbortSignal) => Promise<string>;
  warn: (message: string) => void;
}): Promise<string[]> {
  const { profiles, signal, resolveBinary, warn } = params;
  signal.throwIfAborted();
  const resolutions = await Promise.allSettled(
    profiles.map((profile) => resolveBinary(parseCrabboxProfile(profile).binary, signal)),
  );
  signal.throwIfAborted();
  const binaries: string[] = [];
  const failures: unknown[] = [];
  for (const resolution of resolutions) {
    if (resolution.status === "fulfilled") {
      binaries.push(resolution.value);
    } else {
      failures.push(resolution.reason);
      warn(`Crabbox maintenance binary unavailable: ${coerceErrorMessage(resolution.reason)}`);
    }
  }
  if (failures.length > 0 && binaries.length === 0) {
    throw new AggregateError(failures, "Crabbox maintenance has no supported executable");
  }
  return [...new Set(binaries)].toSorted();
}

export function createCrabboxSnapshotActions(dependencies: {
  manager: WarmImageManager;
  signal: AbortSignal;
  resolveBinaries: (profiles: Profiles, signal: AbortSignal) => Promise<string[]>;
}): { images: CrabboxSnapshotActions; settle: () => Promise<void> } {
  const { manager, signal, resolveBinaries } = dependencies;
  const operations = new Set<Promise<unknown>>();
  const track = async <T>(run: () => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    const operation = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return run();
    });
    operations.add(operation);
    try {
      return await operation;
    } finally {
      operations.delete(operation);
    }
  };
  return {
    images: {
      pin: (checkpointId, pinned) =>
        track(() => manager.pin(checkpointId, pinned, () => signal.throwIfAborted())),
      rollback: (checkpointId) =>
        track(() => manager.rollback(checkpointId, () => signal.throwIfAborted())),
      delete: (checkpointId, profiles) =>
        track(async () => {
          const binaries = await resolveBinaries(profiles, signal);
          signal.throwIfAborted();
          return manager.delete(
            { binaries, signal, assertCurrent: () => signal.throwIfAborted() },
            checkpointId,
          );
        }),
    },
    async settle() {
      await Promise.allSettled(operations);
    },
  };
}
