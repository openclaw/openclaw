import type { OpenClawPluginService } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { BeamStoredSession, BeamUpload } from "./types.js";
import { BEAM_MAX_SESSIONS, BEAM_RETENTION_MS } from "./types.js";

export type BeamSessionSummary = Readonly<
  Pick<BeamStoredSession, "beamId" | "title" | "source" | "completed" | "createdAt" | "receivedAt">
>;

export type BeamStore = {
  catalogService: OpenClawPluginService;
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
  list: () => Promise<BeamSessionSummary[]>;
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
  let revision = 0;
  let inventory: Array<{ value: BeamSessionSummary; expiresAt?: number }> | undefined;
  let refreshing: Promise<void> | undefined;
  let interval: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  const invalidate = () => {
    revision++;
    inventory = undefined;
  };
  const refresh = (): Promise<void> => {
    if (stopped) {
      return Promise.reject(new Error("Beam catalog inventory is stopped"));
    }
    refreshing ??= (async () => {
      for (;;) {
        const observedRevision = revision;
        const entries = await store.entries();
        if (stopped) {
          return;
        }
        if (observedRevision !== revision) {
          continue;
        }
        inventory = entries.map(({ value, expiresAt }) => ({
          value: {
            beamId: value.beamId,
            title: value.title,
            source: value.source,
            completed: value.completed,
            createdAt: value.createdAt,
            receivedAt: value.receivedAt,
          },
          expiresAt,
        }));
        return;
      }
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  return {
    catalogService: {
      id: "beam-catalog",
      async start(ctx) {
        stopped = false;
        const update = () =>
          refresh().catch((error: unknown) => {
            invalidate();
            ctx.logger.warn(`beam catalog inventory refresh failed: ${String(error)}`);
          });
        // Other processes can update SQLite without this instance's mutation revision.
        interval = setInterval(() => void update(), 30_000);
        interval.unref?.();
        await update();
      },
      async stop() {
        stopped = true;
        if (interval) {
          clearInterval(interval);
          interval = undefined;
        }
        invalidate();
        await refreshing?.catch(() => {});
      },
    },
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
      try {
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
      } finally {
        // Also invalidate uncertain writes and conflicts that observed another writer.
        invalidate();
      }
    },
    get: (beamId) => store.lookup(beamId),
    async delete(beamId) {
      try {
        return await store.delete(beamId);
      } finally {
        invalidate();
      }
    },
    async list() {
      for (;;) {
        if (inventory) {
          const now = Date.now();
          return inventory
            .filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now)
            .map(({ value }) => value);
        }
        await refresh();
      }
    },
  };
}
