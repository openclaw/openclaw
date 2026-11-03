import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type {
  BeamPublisher,
  BeamUploadOperations,
  BeamUploadResult,
} from "../upload-operation-api.js";
import type { BeamStoredSession, BeamUpload } from "./types.js";
import { BEAM_MAX_SESSIONS, BEAM_RETENTION_MS } from "./types.js";

type BeamSessionSummary = Readonly<
  Pick<
    BeamStoredSession,
    "beamId" | "title" | "source" | "completed" | "createdAt" | "receivedAt" | "publisherProfileId"
  >
>;

export type BeamStore = {
  catalogService: OpenClawPluginServiceV2;
  upload: (
    upload: BeamUpload,
    receipt: {
      receivedAt: number;
      publisher: BeamPublisher;
      assertCurrent: () => void;
    },
  ) => Promise<BeamUploadResult>;
  get: (beamId: string) => Promise<BeamStoredSession | undefined>;
  delete: (beamId: string) => Promise<boolean>;
  list: () => Promise<BeamSessionSummary[]>;
};

export function createBeamStore(runtime: PluginRuntime): BeamStore {
  const store = runtime.state.openKeyedStoreV2<BeamStoredSession>({
    namespace: "sessions",
    maxEntries: BEAM_MAX_SESSIONS,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: BEAM_RETENTION_MS,
  });
  let inventory: Array<{ value: BeamSessionSummary; expiresAt?: number }> | undefined;
  let refreshing: Promise<void> | undefined;
  let lifetime: AbortSignal | undefined;
  const invalidate = () => {
    inventory = undefined;
  };
  const refresh = (): Promise<void> => {
    if (lifetime?.aborted) {
      return Promise.reject(new Error("Beam catalog inventory is stopped"));
    }
    refreshing ??= (async () => {
      const entries = await store.entries();
      if (lifetime?.aborted) {
        return;
      }
      // A refresh overtaken by an upload may show old metadata until the next poll.
      inventory = entries.map(({ value, expiresAt }) => ({
        value: {
          beamId: value.beamId,
          title: value.title,
          source: value.source,
          completed: value.completed,
          createdAt: value.createdAt,
          receivedAt: value.receivedAt,
          publisherProfileId: value.publisherProfileId,
        },
        expiresAt,
      }));
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };
  return {
    catalogService: {
      id: "beam-catalog",
      apiVersion: 2,
      async start(ctx) {
        lifetime = ctx.scheduler.signal;
        const update = () =>
          refresh().catch((error: unknown) => {
            invalidate();
            ctx.logger.warn(`beam catalog inventory refresh failed: ${String(error)}`);
          });
        // Refresh metadata periodically; local uploads and deletes also invalidate it.
        ctx.scheduler.schedule({ id: "inventory", delayMs: 30_000, everyMs: 30_000, run: update });
        await update();
      },
      async stop() {
        invalidate();
        await refreshing?.catch(() => {});
      },
    },
    async upload(upload, { receivedAt, publisher, assertCurrent }) {
      if (!store.createOperation) {
        throw new Error("Beam requires worker-owned plugin state operations");
      }
      // Capture the original request assertion before module preparation or writer admission awaits.
      const operation = store.createOperation<BeamUploadOperations>(
        [store],
        { moduleName: "upload-operation-api.js", exportName: "executeBeamUpload" },
        { assertCurrent },
      );
      try {
        const result = await operation.execute(
          { type: "upload", input: { upload, receivedAt, publisher } },
          { writeStores: [0] },
        );
        return result.value;
      } finally {
        // Also invalidate uncertain writes; never retry a failed operation.
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
