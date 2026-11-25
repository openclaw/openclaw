import { sleepWithAbort } from "openclaw/plugin-sdk/retry-runtime";

const SETTLE_DELAY_MS = 1_000;

export type CodexDesktopGeneration = Readonly<{ epoch: number; fingerprint: string }>;

/** Coalesces filesystem invalidations into one stable desktop generation. */
export function createCodexDesktopGenerationOwner(params: {
  signal: AbortSignal;
  readFingerprint: () => Promise<string>;
  onGenerationChange?: (generation: CodexDesktopGeneration) => void;
  initialGeneration?: CodexDesktopGeneration;
}) {
  let generation = params.initialGeneration;
  let dirty = false;
  let refresh: Promise<CodexDesktopGeneration> | undefined;

  const markDirty = () => {
    dirty = true;
  };
  const reconcile = () => {
    if (refresh) {
      return refresh;
    }
    refresh = (async () => {
      // Coalesce update bursts once. An update overlapping the read is picked up
      // by its next filesystem notification rather than a convergence loop.
      await sleepWithAbort(SETTLE_DELAY_MS, params.signal, { ref: false });
      dirty = false;
      const fingerprint = await params.readFingerprint();
      params.signal.throwIfAborted();
      const previous = generation;
      generation =
        previous?.fingerprint === fingerprint
          ? previous
          : { epoch: (previous?.epoch ?? 0) + 1, fingerprint };
      if (previous && generation !== previous) {
        params.onGenerationChange?.(generation);
      }
      return generation;
    })()
      .catch((error: unknown) => {
        dirty = true;
        throw error;
      })
      .finally(() => {
        refresh = undefined;
      });
    return refresh;
  };
  return {
    read: () => generation,
    markDirty,
    wait: () => (dirty ? reconcile() : (refresh ?? Promise.resolve(generation))),
    refresh: () => {
      markDirty();
      return reconcile();
    },
    waitForIdle: async () => {
      await refresh?.catch(() => {});
    },
  };
}
