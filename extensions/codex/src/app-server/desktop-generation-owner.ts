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
  let invalidation = 0;
  let dirty = false;
  let refresh: Promise<CodexDesktopGeneration> | undefined;

  const markDirty = () => {
    invalidation += 1;
    dirty = true;
  };
  const reconcile = () => {
    if (refresh) {
      return refresh;
    }
    refresh = (async () => {
      for (;;) {
        params.signal.throwIfAborted();
        const observedInvalidation = invalidation;
        const first = await params.readFingerprint();
        // This bounded convergence delay belongs to the active fingerprint read.
        await sleepWithAbort(SETTLE_DELAY_MS, params.signal, { ref: false });
        params.signal.throwIfAborted();
        const second = await params.readFingerprint();
        params.signal.throwIfAborted();
        if (observedInvalidation !== invalidation || first !== second) {
          continue;
        }
        const previous = generation;
        generation =
          previous?.fingerprint === second
            ? previous
            : { epoch: (previous?.epoch ?? 0) + 1, fingerprint: second };
        dirty = false;
        if (previous && generation !== previous) {
          params.onGenerationChange?.(generation);
        }
        return generation;
      }
    })().finally(() => {
      refresh = undefined;
    });
    return refresh;
  };
  return {
    read: () => generation,
    markDirty,
    wait: () => (dirty ? reconcile() : Promise.resolve(generation)),
    refresh: () => {
      markDirty();
      return reconcile();
    },
    isCurrent: (candidate: CodexDesktopGeneration | undefined) =>
      Boolean(
        candidate &&
        !params.signal.aborted &&
        !dirty &&
        generation &&
        candidate.epoch === generation.epoch &&
        candidate.fingerprint === generation.fingerprint,
      ),
    waitForIdle: async () => {
      await refresh?.catch(() => {});
    },
  };
}
