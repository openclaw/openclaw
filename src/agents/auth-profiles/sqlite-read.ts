import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { withSqliteWorkerCleanupFailure } from "../../infra/sqlite-worker-broker-reply.js";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  openSqliteWorkerStore,
  runSqliteWorkerStoreOperation,
} from "../../infra/sqlite-worker-store.js";
import { isArtifactPreservingStateRead } from "../../state/openclaw-state-db-readonly.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import type { PersistedAuthProfileStoreInspection } from "./sqlite.js";

export type AuthProfileRowRead = {
  store: PersistedAuthProfileStoreInspection;
  state: PersistedAuthProfileStoreInspection;
};

export type AuthProfileReadWorkerOperations = {
  read: { input: undefined; output: AuthProfileRowRead };
};

const missing: AuthProfileRowRead = {
  store: { status: "missing", reason: "database" },
  state: { status: "missing", reason: "database" },
};

/** Agent readers retain their original file while the shared broker owns dispatch and close. */
export function prepareAgentAuthProfileRowsRead(databasePath: string): {
  read: () => Promise<AuthProfileRowRead>;
  assertCurrent: () => void;
} {
  let identity: ReturnType<typeof inspectDatabasePathIdentitySync>;
  try {
    identity = inspectDatabasePathIdentitySync(databasePath);
  } catch {
    identity = undefined;
  }
  const assertCurrent = () => {
    if (identity && inspectDatabasePathIdentitySync(databasePath)?.key !== identity.key) {
      throw new Error("Auth profile database file identity changed during its read");
    }
  };
  const read = async (): Promise<AuthProfileRowRead> => {
    assertCurrent();
    if (!identity) {
      return { store: { status: "unreadable" }, state: { status: "unreadable" } };
    }
    if (!identity.key.startsWith("file:")) {
      return missing;
    }
    const worker = await openSqliteWorkerStore<AuthProfileReadWorkerOperations>({
      moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.authProfileRead),
      databasePath,
      input: undefined,
      existingOnly: true,
    });
    if (!worker) {
      assertCurrent();
      return missing;
    }
    let result: Result<AuthProfileRowRead, unknown>;
    try {
      assertCurrent();
      const rows = await runSqliteWorkerStoreOperation(
        worker,
        async (scope) => {
          const value = await scope.execute({ type: "read", input: undefined });
          assertCurrent();
          return value;
        },
        undefined,
        assertCurrent,
      );
      result = { ok: true, value: rows };
    } catch (error) {
      result = { ok: false, error };
    }
    try {
      await worker.close();
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
    assertCurrent();
    return result.value;
  };
  return { read, assertCurrent };
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
