import { randomUUID } from "node:crypto";
import type { OpenClawPluginServiceV2 } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { preparePluginStateGuard } from "openclaw/plugin-sdk/plugin-state-runtime";
import type {
  BeamPublisher,
  BeamUploadOperations,
  BeamUploadResult,
} from "../upload-operation-api.js";
import type { BeamStoredSession, BeamUpload, BeamHandoff } from "./types.js";
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
    | "handoffId"
  >
>;

export class BeamSourceOwnershipError extends Error {
  constructor() {
    super(
      "The source still owns this Beam. Use the updated Beam client's handoff command before continuing.",
    );
  }
}

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
  list: (handoffPrefix?: string) => Promise<BeamSessionSummary[]>;
};

export function createBeamStore(runtime: PluginRuntime): BeamStore {
  const store = runtime.state.openKeyedStoreV2<BeamStoredSession>({
    namespace: "sessions",
    maxEntries: BEAM_MAX_SESSIONS,
    overflowPolicy: "evict-oldest",
    defaultTtlMs: BEAM_RETENTION_MS,
  });
  // Logical ownership is durable. Retention or archive must never turn a retired
  // source identity writable again; this namespace contains no transcript bytes.
  const handoffs = runtime.state.openKeyedStoreV2<BeamHandoff>({
    namespace: "handoffs",
    retention: "retained",
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
          handoffId: value.handoffId,
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
        [store, handoffs],
        { moduleName: "upload-operation-api.js", exportName: "executeBeamUpload" },
        { assertCurrent },
      );
      try {
        const result = await operation.execute(
          { type: "upload", input: { upload, receivedAt, publisher } },
          { writeStores: [0, 1] },
        );
        return result.value;
      } finally {
        // Also invalidate uncertain writes; never retry a failed operation.
        invalidate();
      }
    },
    async get(beamId) {
      const snapshot = await store.lookup(beamId);
      if (snapshot) {
        return snapshot;
      }
      const handoff = await handoffs.lookup(beamId);
      return handoff?.continuation ? { ...handoff, items: [] } : undefined;
    },
    async reserveContinuation(session, agentId, assertCurrent) {
      if (!session.handoffId) {
        throw new BeamSourceOwnershipError();
      }
      const execute = async (
        completeId?: string,
        action?: "begin" | "complete" | "rollback",
        assertEffectCurrent?: () => void,
        creationId?: string,
      ) => {
        if (!store.createOperation) {
          throw new Error("Beam requires worker-owned plugin state operations");
        }
        const operation = store.createOperation<BeamUploadOperations>(
          [store, handoffs],
          { moduleName: "upload-operation-api.js", exportName: "executeBeamUpload" },
          {
            assertCurrent: () => {
              // Successful destination rollback owns cleanup after caller revocation.
              // The retained binding and worker claim token fence it to this attempt.
              if (action !== "rollback") {
                assertCurrent();
              }
              assertEffectCurrent?.();
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
              handoffId: session.handoffId!,
              ...(completeId ? { completeId, action, creationId } : {}),
            },
          },
          { writeStores: [0, 1] },
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
      // The source release is immutable; retries cannot restore source ownership.
      const guard = await preparePluginStateGuard(handoffs, session.beamId, (current) => {
        if (
          !current ||
          current.publisherProfileId !== session.publisherProfileId ||
          current.createdAt !== session.createdAt ||
          current.handoffId !== session.handoffId ||
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
      let attempted = false;
      let ownedCreationId: string | undefined;
      return {
        ...result,
        reservedNow: !binding.creating && !binding.ready,
        assertCurrent: () => {
          assertCurrent();
          guard.assertCurrent();
        },
        release: guard.release,
        beginCreate: async (assertDestinationCurrent) => {
          if (attempted) {
            return false;
          }
          attempted = true;
          const creationId = randomUUID();
          const started = (await execute(binding.id, "begin", assertDestinationCurrent, creationId))
            .reservedNow;
          if (started) {
            ownedCreationId = creationId;
          }
          return started;
        },
        rollback: async () => {
          if (!ownedCreationId) {
            throw new Error("This lease did not create the destination");
          }
          // Validate before opening the write: a prepared read guard would reject
          // this operation's own pending publication. The worker rechecks the token.
          guard.assertCurrent();
          await execute(binding.id, "rollback", undefined, ownedCreationId);
        },
        complete: async (assertDestinationCurrent) => {
          if (!binding.ready) {
            // A new lease may reconcile a committed destination after a lost ack.
            // Only rollback requires this lease's own successful creation claim.
            await execute(
              binding.id,
              "complete",
              assertDestinationCurrent,
              ownedCreationId ?? binding.creating,
            );
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
    async list(handoffPrefix) {
      for (;;) {
        if (inventory) {
          const now = Date.now();
          const snapshots = inventory
            .filter((entry) => entry.expiresAt === undefined || entry.expiresAt > now)
            .map(({ value }) => value);
          if (!handoffPrefix) {
            return snapshots;
          }
          // Pretty-link discovery stays bounded and can find a durable destination
          // after its imported snapshot expires. Ordinary archived rows stay hidden.
          const retained = await handoffs.entriesInKeyRange({
            keyStartInclusive: handoffPrefix,
            keyEndExclusive: `${handoffPrefix}g`,
            limit: 101,
          });
          const visible = new Set(snapshots.map((row) => row.beamId));
          return [
            ...snapshots,
            ...retained
              .filter(({ value }) => value.continuation && !visible.has(value.beamId))
              .map(({ value }) => value),
          ];
        }
        await refresh();
      }
    },
  };
}
