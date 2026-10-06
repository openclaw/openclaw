import path from "node:path";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { cloneEnvWithPlatformSemantics } from "../../config/config-env-vars.js";
import { runSqliteReadOnlyWorker } from "../../infra/sqlite-readonly-worker.js";
import { inspectDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { createSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { registerOpenClawAgentDatabaseAsyncResource } from "../../state/openclaw-agent-db-resources.js";
import { registerOpenClawStateDatabaseAsyncResource } from "../../state/openclaw-state-db-cache.js";
import { isArtifactPreservingStateRead } from "../../state/openclaw-state-db-readonly.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { registerUserModelAuthProfileSecrets } from "../../state/user-model-accounts.js";
import { mergePersistedAuthProfileState } from "./persisted.js";
import { AuthProfileStoreUnreadableError } from "./store-unreadable-error.js";
import { receiveAuthProfileUpdateValue } from "./store-update-transfer.js";
import type {
  AuthProfileStore,
  AuthProfileRowRead,
  PersistedAuthProfileStoreInspection,
  UserModelAuthProfile,
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
  const captured: Result<OpenClawStateWorkerContext, unknown> = (() => {
    try {
      return {
        ok: true,
        value: captureOpenClawStateWorkerContext({ env }),
      };
    } catch (error) {
      return { ok: false, error };
    }
  })();
  const controller = new AbortController();
  const pending = new Set<Promise<AuthProfileRowRead>>();
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
    captured.value.admission.assertCurrent();
    captured.value.maintenanceScope?.assertAdmission();
    if (identity && inspectDatabasePathIdentitySync(databasePath)?.key !== identity.key) {
      throw new Error("Auth profile database file identity changed during its read");
    }
    // Cached rows still borrow this read's revocable authority through host composition.
    if (!closed) {
      register();
    }
  };
  const dispose = (): Promise<void> => {
    closed = true;
    controller.abort(new Error("Auth profile read owner closed"));
    closing ??= (async () => {
      await Promise.allSettled(pending);
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
    const root = captured.value;
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
      const rows = await runSqliteReadOnlyWorker(databasePath, {
        mode: "auth-profile-rows",
        source: "canonical",
        expectedIdentity: identity.key,
        env,
        signal: controller.signal,
      });
      controller.signal.throwIfAborted();
      assertCurrent();
      if (!isInspection(rows.store) || !isInspection(rows.state)) {
        throw new Error("Auth profile reader returned invalid inspection rows");
      }
      return { store: rows.store, state: rows.state, cacheable: rows.cacheable };
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
  artifactPreserving = isArtifactPreservingStateRead(),
): Promise<AuthProfileRowRead> {
  let rows: AuthProfileRowRead | undefined;
  const assertCurrent = () => {
    context.admission.assertCurrent();
    context.maintenanceScope?.assertAdmission();
  };
  const result = await runOpenClawStateWorkerOperation(
    context,
    async (scope) => {
      await scope.execute({
        type: "authProfiles.read",
        input: { artifactPreserving },
      });
      return true;
    },
    {
      existingOnly: true,
      createAdmission: () => ({
        nativeLocations: [context.admission.databasePath],
        admission: createSqliteWorkerOperationAdmission((request, grant) => {
          const facts = request.facts;
          if (!isRecord(facts) || !(facts.port instanceof MessagePort)) {
            throw new Error("Auth profile read returned no field transport");
          }
          try {
            assertCurrent();
            if (request.stage !== "prepare" || facts.kind !== "auth-store-read" || rows) {
              throw new Error("Auth profile read requested an invalid field transfer");
            }
            const value = receiveAuthProfileUpdateValue(facts.port);
            if (
              !isRecord(value) ||
              !isInspection(value.store) ||
              !isInspection(value.state) ||
              typeof value.cacheable !== "boolean"
            ) {
              throw new Error("Auth profile reader returned invalid inspection rows");
            }
            rows = { store: value.store, state: value.state, cacheable: value.cacheable };
            assertCurrent();
            if (!grant()) {
              throw new Error("Auth profile read authority expired");
            }
          } finally {
            facts.port.close();
          }
        }),
      }),
    },
  );
  assertCurrent();
  if (result && !rows) {
    throw new Error("Auth profile read completed without its rows");
  }
  return rows ?? missing;
}

/** Read one selected account on the canonical actor; redaction remains caller-owned. */
export async function readUserModelAuthProfileAsync(
  authProfileId: string,
  context: OpenClawStateWorkerContext,
): Promise<UserModelAuthProfile | undefined> {
  const profile = await runOpenClawStateWorkerOperation(
    context,
    (scope) =>
      scope.execute({
        type: "authProfiles.personal",
        input: { profileId: authProfileId, artifactPreserving: isArtifactPreservingStateRead() },
      }),
    { existingOnly: true },
  );
  context.admission.assertCurrent();
  if (profile) {
    registerUserModelAuthProfileSecrets(profile.credential);
  }
  return profile;
}
