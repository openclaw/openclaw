import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { preparePluginStateGuard } from "openclaw/plugin-sdk/plugin-state-runtime";
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
    | "beamId"
    | "title"
    | "source"
    | "completed"
    | "createdAt"
    | "receivedAt"
    | "publisherProfileId"
    | "continuation"
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
  reserveContinuation: (
    session: BeamStoredSession,
    agentId: string,
    assertCurrent: () => void,
  ) => Promise<{
    session: BeamStoredSession;
    reservedNow: boolean;
    assertCurrent: () => void;
    release: () => void;
    beginCreate: (assertDestinationCurrent: () => void) => Promise<boolean>;
    rollback: () => Promise<void>;
    complete: (assertDestinationCurrent: () => void) => Promise<void>;
  }>;
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
  const reservations = new Map<
    string,
    Promise<{ session: BeamStoredSession; reservedNow: boolean }>
  >();
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
          continuation: value.continuation,
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
    async reserveContinuation(session, agentId, assertCurrent) {
      const execute = async (
        completeId?: string,
        action?: "begin" | "complete" | "rollback",
        assertDestinationCurrent?: () => void,
      ) => {
        if (!store.createOperation) {
          throw new Error("Beam requires worker-owned plugin state operations");
        }
        const operation = store.createOperation<BeamUploadOperations>(
          [store],
          { moduleName: "upload-operation-api.js", exportName: "executeBeamUpload" },
          {
            assertCurrent: () => {
              assertCurrent();
              assertDestinationCurrent?.();
            },
          },
        );
        const receipt = await operation.execute(
          {
            type: "reserveContinuation",
            input: {
              beamId: session.beamId,
              agentId,
              publisherProfileId: session.publisherProfileId,
              createdAt: session.createdAt,
              ...(completeId ? { completeId, action } : {}),
            },
          },
          { writeStores: [0] },
        );
        invalidate();
        return receipt.value;
      };
      const pending = reservations.get(session.beamId);
      let result: { session: BeamStoredSession; reservedNow: boolean };
      if (pending) {
        result = { ...(await pending), reservedNow: false };
      } else if (session.continuation) {
        result = { session, reservedNow: false };
      } else {
        const operation = execute();
        reservations.set(session.beamId, operation);
        try {
          result = await operation;
        } finally {
          reservations.delete(session.beamId);
        }
      }
      assertCurrent();
      const binding = result.session.continuation!;
      // Pin only this publication and generation, not the namespace's write epoch.
      // Ownership-preserving uploads may refresh its snapshot while Team keeps its own turns.
      const guard = await preparePluginStateGuard(store, session.beamId, (current) => {
        if (
          !current ||
          current.publisherProfileId !== session.publisherProfileId ||
          current.createdAt !== session.createdAt ||
          current.continuation?.id !== binding.id ||
          current.continuation.agentId !== binding.agentId ||
          current.continuation.sessionKey !== binding.sessionKey
        ) {
          throw new Error("Beam handoff publication is no longer available");
        }
      });
      if (!guard) {
        throw new Error("Beam handoff requires a native publication guard");
      }
      return {
        ...result,
        reservedNow: !binding.creating && !binding.ready,
        assertCurrent: () => {
          assertCurrent();
          guard.assertCurrent();
        },
        release: guard.release,
        beginCreate: async (assertDestinationCurrent) =>
          (await execute(binding.id, "begin", assertDestinationCurrent)).reservedNow,
        rollback: async () => {
          await execute(binding.id, "rollback");
        },
        complete: async (assertDestinationCurrent) => {
          if (!binding.ready) {
            await execute(binding.id, "complete", assertDestinationCurrent);
          }
        },
      };
    },
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
