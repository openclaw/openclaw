import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { BeamStoredSession, BeamUpload } from "./types.js";
import { BEAM_MAX_SESSIONS, BEAM_RETENTION_MS } from "./types.js";

export type BeamStore = {
  upload: (
    upload: BeamUpload,
    receipt: {
      receivedAt: number;
      uploaderProfileId?: string;
      revalidatePublisher?: () => Promise<void>;
    },
  ) => Promise<boolean>;
  get: (beamId: string) => Promise<BeamStoredSession | undefined>;
  delete: (beamId: string) => Promise<boolean>;
  list: () => Promise<BeamStoredSession[]>;
};

function beamTimestampEpochNanoseconds(value: string): bigint {
  const match = /\.(\d{1,9})(?=Z|[+-]\d{2}:\d{2}$)/.exec(value);
  const fraction = (match?.[1] ?? "").padEnd(9, "0");
  // Date.parse drops accepted fractional precision after milliseconds.
  const millisecondTimestamp = match
    ? `${value.slice(0, match.index)}.${fraction.slice(0, 3)}${value.slice(match.index + match[0].length)}`
    : value;
  return BigInt(Date.parse(millisecondTimestamp)) * 1_000_000n + BigInt(fraction.slice(3));
}

function compareBeamTimestamps(left: string, right: string): number {
  const leftNanoseconds = beamTimestampEpochNanoseconds(left);
  const rightNanoseconds = beamTimestampEpochNanoseconds(right);
  return leftNanoseconds < rightNanoseconds ? -1 : leftNanoseconds > rightNanoseconds ? 1 : 0;
}

function decideBeamUpload(
  existing: BeamStoredSession | undefined,
  snapshot: Omit<BeamStoredSession, "createdAt">,
): BeamStoredSession | undefined {
  const revisionOrder = existing
    ? compareBeamTimestamps(snapshot.updatedAt, existing.updatedAt)
    : 1;
  // Completion is monotonic within one source revision; a newer revision may reopen it.
  if (revisionOrder < 0 || (revisionOrder === 0 && existing?.completed && !snapshot.completed)) {
    return undefined;
  }
  return { ...snapshot, createdAt: existing?.createdAt ?? snapshot.receivedAt };
}

export function createBeamStore(runtime: PluginRuntime): BeamStore {
  const store = runtime.state.openKeyedStore<BeamStoredSession>({
    namespace: "sessions",
    maxEntries: BEAM_MAX_SESSIONS,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: BEAM_RETENTION_MS,
  });
  return {
    async upload(upload, { receivedAt, uploaderProfileId, revalidatePublisher }) {
      if (!store.observe || !store.compareAndApply) {
        throw new Error("Beam uploads require plugin-state observe and compareAndApply support");
      }
      const snapshot = {
        ...structuredClone(upload),
        // An anonymous replacement must not inherit a previous publisher's identity.
        ...(uploaderProfileId ? { uploaderProfileId } : {}),
        receivedAt,
      };
      let observation = await store.observe(snapshot.beamId);
      for (;;) {
        const value = decideBeamUpload(observation.value, snapshot);
        await revalidatePublisher?.();
        const result = await store.compareAndApply(
          snapshot.beamId,
          observation.comparison,
          value
            ? { operation: "update", action: "set", value }
            : { operation: "update", action: "keep" },
        );
        if (result.status !== "conflict") {
          return result.status === "applied";
        }
        observation = result.current;
      }
    },
    get: (beamId) => store.lookup(beamId),
    delete: (beamId) => store.delete(beamId),
    list: async () => (await store.entries()).map((entry) => entry.value),
  };
}
