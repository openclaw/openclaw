import path from "node:path";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import type { PreparedSqliteReadOnlyLocation } from "../../infra/sqlite-readonly-location.types.js";
import { runSqliteReadOnlyWorker } from "../../infra/sqlite-readonly-worker.js";
import { prepareSqliteReadOnlyLocation } from "../../infra/sqlite-snapshot-source.js";
import { withSqliteSourceHandleAsync } from "../../infra/sqlite-source-handle.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  prepareStateDatabaseCanonicalMutation,
  prepareStateDatabaseSourceExclusion,
  withStateDatabaseCoordinatorRuntimeDirectory,
} from "../../infra/state-database-coordinator.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { isArtifactPreservingStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { mergePersistedAuthProfileState } from "./persisted.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import type {
  AuthProfileStore,
  AuthProfileRowRead,
  PersistedAuthProfileStoreInspection,
} from "./types.js";

/** Decode worker-read facts with the same store/state coercion as synchronous reads. */
export function loadPersistedAuthProfileStoreFromRows(
  rows: AuthProfileRowRead,
  databasePath: string,
): AuthProfileStore | null {
  const store = mergePersistedAuthProfileState(
    rows.store.status === "readable" ? rows.store.raw : null,
    () => (rows.state.status === "readable" ? rows.state.raw : null),
  );
  if (!store && rows.store.status !== "missing") {
    throw new AuthProfileStoreUnreadableError(databasePath);
  }
  return store;
}

const missing: AuthProfileRowRead = {
  store: { status: "missing", reason: "database" },
  state: { status: "missing", reason: "database" },
  cacheable: false,
};

function isInspection(value: unknown): value is PersistedAuthProfileStoreInspection {
  return (
    isRecord(value) &&
    (value.status === "unreadable" ||
      (value.status === "readable" && Object.hasOwn(value, "raw")) ||
      (value.status === "missing" &&
        (value.reason === "database" || value.reason === "table" || value.reason === "row")))
  );
}

/** Captured read authority survives all awaits until the runtime composition releases it. */
export function prepareAgentAuthProfileRowsRead(options: {
  databasePath: string;
  agentId: string;
  env: NodeJS.ProcessEnv;
}): {
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
  dispose: () => Promise<void>;
} {
  const databasePath = path.resolve(options.databasePath);
  const agentId = options.agentId;
  const env = cloneEnvWithPlatformSemantics(options.env);
  let identity: ReturnType<typeof inspectDatabasePathIdentitySync>;
  try {
    identity = inspectDatabasePathIdentitySync(databasePath);
  } catch {
    identity = undefined;
  }
  const captured: Result<
    {
      root: ReturnType<typeof captureOpenClawStateWorkerContext>;
      mutation?: () => void;
      exclusion?: () => void;
    },
    unknown
  > = (() => {
    try {
      return {
        ok: true,
        value: {
          root: captureOpenClawStateWorkerContext({ env }),
          mutation: prepareStateDatabaseCanonicalMutation(databasePath),
          exclusion: prepareStateDatabaseSourceExclusion(databasePath),
        },
      };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  const controller = new AbortController();
  const pending = new Set<Promise<AuthProfileRowRead>>();
  const snapshots = new Set<PreparedSqliteReadOnlyLocation>();
  let closed = false;
  let revoked = false;
  let closing: Promise<void> | undefined;
  let unregisterAgent: (() => void) | undefined;
  let unregisterRoot: (() => void) | undefined;
  const revoke = () => {
    revoked = true;
    controller.abort(new Error("Auth profile read owner was revoked"));
  };
  const assertCurrent = () => {
    if (revoked) {
      throw new Error("Auth profile read owner was revoked");
    }
    if (!captured.ok) {
      throw captured.error;
    }
    captured.value.root.admission.assertCurrent();
    captured.value.root.maintenanceScope?.assertAdmission();
    captured.value.mutation?.();
    captured.value.exclusion?.();
    if (identity && inspectDatabasePathIdentitySync(databasePath)?.key !== identity.key) {
      throw new Error("Auth profile database file identity changed during its read");
    }
    // Cached rows still borrow this read's revocable authority through host composition.
    if (!closed) {
      register();
    }
  };
  const cleanSnapshot = async (snapshot: PreparedSqliteReadOnlyLocation) => {
    if (!(await snapshot.cleanupAsync())) {
      throw new Error(
        `SQLite read-only worker snapshot cleanup failed: ${snapshot.cleanupRoot ?? path.dirname(snapshot.location)}`,
      );
    }
    snapshots.delete(snapshot);
  };
  const dispose = (): Promise<void> => {
    closed = true;
    controller.abort(new Error("Auth profile read owner closed"));
    closing ??= (async () => {
      await Promise.allSettled(pending);
      const cleanup = await Promise.allSettled([...snapshots].map(cleanSnapshot));
      const errors = cleanup.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (errors.length > 0) {
        throw new AggregateError(errors, "Auth profile snapshot cleanup failed", {
          cause: errors[0],
        });
      }
      unregisterRoot?.();
      unregisterAgent?.();
    })().catch((error: unknown) => {
      closing = undefined;
      throw error;
    });
    return closing;
  };
  const register = () => {
    if (unregisterAgent || !captured.ok) {
      return;
    }
    const root = captured.value.root;
    const registerOwners = () => {
      unregisterAgent = registerOpenClawAgentDatabaseAsyncResource({
        agentId,
        path: databasePath,
        revoke,
        close: dispose,
      });
      try {
        unregisterRoot = registerOpenClawStateDatabaseAsyncResource({
          close: async (closedIdentity) => {
            if (!closedIdentity || closedIdentity.key === root.admission.identity.key) {
              revoke();
              await dispose();
            }
          },
        });
      } catch (error) {
        unregisterAgent();
        unregisterAgent = undefined;
        throw error;
      }
    };
    if (root.maintenanceScope) {
      root.maintenanceScope.run(registerOwners);
    } else {
      registerOwners();
    }
  };
  const read = (): Promise<AuthProfileRowRead> => {
    if (closed) {
      return Promise.reject(new Error("Auth profile read owner closed"));
    }
    const operation = (async () => {
      assertCurrent();
      if (!identity) {
        return {
          store: { status: "unreadable" },
          state: { status: "unreadable" },
          cacheable: false,
        } satisfies AuthProfileRowRead;
      }
      if (!identity.key.startsWith("file:")) {
        return missing;
      }
      if (!captured.ok) {
        throw captured.error;
      }
      const { root, mutation, exclusion } = captured.value;
      return withStateDatabaseCoordinatorRuntimeDirectory(root.coordinatorRuntime, async () => {
        let snapshot: PreparedSqliteReadOnlyLocation | undefined;
        let result: Result<AuthProfileRowRead, unknown>;
        try {
          if (mutation || exclusion) {
            assertCurrent();
            snapshot = await prepareSqliteReadOnlyLocation(databasePath, {
              preserveSourceArtifacts: true,
              signal: controller.signal,
            });
            snapshots.add(snapshot);
          }
          controller.signal.throwIfAborted();
          assertCurrent();
          const sourcePath = snapshot?.location ?? databasePath;
          const sourceIdentity = snapshot ? inspectDatabasePathIdentitySync(sourcePath) : identity;
          if (!sourceIdentity?.key.startsWith("file:")) {
            throw new Error("Auth profile read source no longer identifies its file");
          }
          const rows = await withSqliteSourceHandleAsync(sourcePath, () =>
            runSqliteReadOnlyWorker(sourcePath, {
              mode: "auth-profile-rows",
              source: snapshot ? "snapshot" : "canonical",
              expectedIdentity: sourceIdentity.key,
              env,
              coordinatorRuntime: root.coordinatorRuntime,
              signal: controller.signal,
            }),
          );
          controller.signal.throwIfAborted();
          assertCurrent();
          if (!isInspection(rows.store) || !isInspection(rows.state)) {
            throw new Error("Auth profile reader returned invalid inspection rows");
          }
          result = {
            ok: true,
            value: { store: rows.store, state: rows.state, cacheable: rows.cacheable },
          };
        } catch (error) {
          result = { ok: false, error };
        }
        try {
          if (snapshot) {
            await cleanSnapshot(snapshot);
          }
        } catch (cleanupError) {
          throw result.ok
            ? cleanupError
            : withSqliteWorkerCleanupFailure(
                toErrorObject(result.error, "Auth profile read failed"),
                cleanupError,
              );
        }
        if (!result.ok) {
          throw result.error;
        }
        controller.signal.throwIfAborted();
        assertCurrent();
        return result.value;
      });
    })();
    pending.add(operation);
    void operation.finally(() => pending.delete(operation)).catch(() => undefined);
    return operation;
  };
  return { read, assertCurrent, dispose };
}

/** Shared auth reads reuse the canonical actor and never request a writable open. */
export async function readSharedAuthProfileRows(
  context: OpenClawStateWorkerContext,
): Promise<AuthProfileRowRead> {
  const result = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "authProfiles.read",
        input: { artifactPreserving: isArtifactPreservingStateRead() },
      }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  return result ?? missing;
}
