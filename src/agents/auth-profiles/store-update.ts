import { randomUUID } from "node:crypto";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { isSqliteLockError } from "../../infra/sqlite-error-diagnostics.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { getOpenClawDatabaseMaintenanceScope } from "../../state/openclaw-state-db-async-lifecycle.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import {
  AUTH_STORE_VERSION,
  authProfilesLog,
  reportCommittedInlineAuthFailure,
} from "./constants.js";
import { observeCanonicalAuthProfileCredentials } from "./credential-observation.js";
import type { createExternalAuthRuntime } from "./external-auth.js";
import type { InlineAuthFailureOperations } from "./inline-usage-kernel.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import { resolveLegacyAuthProfileSourceCandidates } from "./legacy-source-files.js";
import { getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath } from "./mutation-lineage.js";
import {
  getPreparedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import {
  buildPersistedAuthProfileSecretsStore,
  loadPersistedAuthProfileStoreAtDatabasePath,
} from "./persisted.js";
import { withPersonalAuthProfileStore } from "./personal-store.js";
import type { LoadAuthProfileStoreOptions } from "./runtime-read.js";
import { assertPersonalAuthProfileRuntime, getWorkerAuthProfileWrites } from "./runtime-scope.js";
import {
  getRuntimeAuthProfileStoreSnapshotAtDatabasePath,
  invalidateRuntimeAuthProfileStoreSnapshotsForOwner,
} from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { isSharedAuthProfileWrite } from "./shared-store-bootstrap.js";
import {
  prepareAuthProfileWriteTransaction,
  prepareAuthProfileWriteTransactionAsync,
  prepareAuthProfileWriteEnvironment,
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseOwnerId,
  runAuthProfileWriteTransaction,
  type AuthProfileDatabase,
} from "./sqlite.js";
import type { SaveAuthProfileStoreOptions } from "./store-save.js";
import { watchAuthProfileNativeCommits } from "./store-update-commit.js";
import type {
  AuthStoreUpdatePrepared,
  AuthStoreUpdateCommitted,
  AuthStoreUpdateCommittedWire,
  AuthStoreUpdateResponse,
} from "./store-update-kernel.js";
import { publishAuthProfileStoreUpdate } from "./store-update-publication.js";
import {
  sendAuthProfileUpdateValue,
  receiveAuthProfileUpdateValue,
} from "./store-update-transfer.js";
import type { AuthStoreUpdateInput } from "./store.worker-contract.js";
import type { AuthProfileStore, PreparedAuthProfileStoreOwner } from "./types.js";
import { reserveAuthProfileUsagePreparation, runAuthProfileUsage } from "./usage-lifecycle.js";
import { captureAuthProfileWriteExecution } from "./write-execution.js";

class AuthProfileSharedSourceChangedError extends Error {}

/** The existing SQLite worker owns BEGIN/read/save/COMMIT; host callbacks keep their scope. */
type AuthProfileStoreUpdate = {
  existingDatabaseTarget?: { kind: "agent"; agentId: string; path: string; env: NodeJS.ProcessEnv };
  agentDir?: string;
  envOnly: boolean;
  peerGeneration?: AuthStoreUpdateInput["peerGeneration"];
  options: Parameters<typeof prepareAuthProfileWriteTransaction>[1];
  assertCurrent?: () => void;
  update: (
    prepared: AuthStoreUpdatePrepared,
    owner: PreparedAuthProfileStoreOwner,
  ) => AuthStoreUpdateResponse;
  publish: (
    committed: AuthStoreUpdateCommitted | undefined,
    owner: PreparedAuthProfileStoreOwner,
    assertCurrent: () => void,
    nativeCommits: ReturnType<typeof watchAuthProfileNativeCommits>,
    committedIsCurrent: () => boolean,
  ) => Promise<void>;
};

export function runAuthProfileStoreUpdate(params: AuthProfileStoreUpdate): Promise<void> {
  const env = prepareAuthProfileWriteEnvironment(params.options);
  return runAuthProfileUsage(async () => {
    const context = captureOpenClawStateWorkerContext({ env });
    const sharedWrite = isSharedAuthProfileWrite({
      agentDir: params.agentDir,
      allowExplicitMain: params.options.sharedStoreWrite === true,
      env,
    });
    const capturedAgentDir = sharedWrite
      ? getPreparedSharedAuthStoreOwnership(env)?.location === "state-db"
        ? undefined
        : resolveSharedMainAuthAgentDir(env)
      : params.agentDir;
    const target =
      params.existingDatabaseTarget ??
      (capturedAgentDir
        ? {
            kind: "agent" as const,
            agentId: resolveAuthProfileDatabaseOwnerId(capturedAgentDir),
            path: resolveAuthProfileDatabasePath(capturedAgentDir),
            env,
          }
        : undefined);
    const execution = target ? captureAuthProfileWriteExecution({ ...target, env }) : undefined;
    let transferred = false;
    let followsCapturedAgent = true;
    const assertCurrent = () => {
      context.admission.assertCurrent();
      context.maintenanceScope?.assertAdmission();
      if (followsCapturedAgent) {
        execution?.assertCurrent();
      }
      params.assertCurrent?.();
    };
    const reservation = reserveAuthProfileUsagePreparation([
      resolveOpenClawStateSqlitePath(env),
      ...(params.agentDir
        ? [params.existingDatabaseTarget?.path ?? resolveAuthProfileDatabasePath(params.agentDir)]
        : []),
    ]);
    try {
      await reservation.ready;
      const prepared = await prepareAuthProfileWriteTransactionAsync(
        params.agentDir,
        { ...params.options, env },
        assertCurrent,
      );
      assertCurrent();
      const databaseTarget = params.existingDatabaseTarget ?? prepared.databaseTarget;
      transferred = databaseTarget.kind === "agent" && databaseTarget.path === target?.path;
      // Bootstrap's acknowledged handoff selects the already-captured shared-state owner.
      followsCapturedAgent = transferred;
      return await runPreparedAuthProfileStoreUpdate(
        {
          ...params,
          assertCurrent,
          publish: (...args) => {
            // The selected writer still owns publication; release discovery before cross-owner work.
            reservation.release();
            return params.publish(...args);
          },
        },
        {
          ...prepared,
          databaseTarget,
        },
        transferred ? execution : undefined,
      );
    } finally {
      if (!transferred) {
        await execution?.release();
      }
      reservation.release();
    }
  });
}

async function runPreparedAuthProfileStoreUpdate(
  params: AuthProfileStoreUpdate,
  { databaseTarget, sharedOwner }: ReturnType<typeof prepareAuthProfileWriteTransaction>,
  capturedExecution?: ReturnType<typeof captureOpenClawAgentDatabaseExecution>,
): Promise<void> {
  const owner = { ...sharedOwner, databasePath: databaseTarget.path };
  let acknowledged = false;
  let exchangePort: MessagePort | undefined;
  let nativeCommits: ReturnType<typeof watchAuthProfileNativeCommits> | undefined;
  let sharedSource:
    | {
        commits: ReturnType<typeof watchAuthProfileNativeCommits>;
        unchanged: () => boolean;
        revision: number;
      }
    | undefined;
  let committedIsCurrent = () => false;
  let invalidationAttempted = false;
  let commitGranted = false;
  const invalidateUnknown = (error: unknown) => {
    if (!commitGranted || invalidationAttempted) {
      return;
    }
    try {
      if (hasSqliteWorkerOutcomeUnknown(error)) {
        invalidationAttempted = true;
        invalidateRuntimeAuthProfileStoreSnapshotsForOwner(owner);
      }
    } catch (invalidationError) {
      reportCommittedInlineAuthFailure("Auth outcome invalidation failed", invalidationError);
    }
  };
  return (async () => {
    let committed: AuthStoreUpdateCommitted | undefined;
    const captureSharedSource = () => {
      if (sharedSource || owner.databasePath === owner.sharedDatabasePath) {
        return;
      }
      // Fence native commits and published mutations before the worker reads inherited rows.
      const commits = watchAuthProfileNativeCommits(owner.sharedDatabasePath);
      sharedSource = {
        commits,
        unchanged: commits.capture(),
        revision: getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(
          owner.sharedDatabasePath,
        ),
      };
    };
    const assertOwner = () => {
      if (
        resolveSharedAuthStorePath(owner.env) !== owner.sharedDatabasePath ||
        resolveSharedAuthStoreOwnership(owner.env).location !== owner.location
      ) {
        throw new Error("Auth profile shared owner changed before write admission");
      }
      if (!params.envOnly) {
        assertAuthProfileMigrationStateAtDatabasePath(owner.databasePath);
      }
    };
    let assertAuthority = assertOwner;
    const assertRequest = () => {
      params.assertCurrent?.();
      assertAuthority();
      if (
        sharedSource &&
        (!sharedSource.unchanged() ||
          getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath(owner.sharedDatabasePath) !==
            sharedSource.revision)
      ) {
        throw new AuthProfileSharedSourceChangedError(
          "Auth profile shared store changed before write admission",
        );
      }
    };
    const receive = (request: SqliteWorkerAdmissionRequest): boolean => {
      const facts = request.facts;
      if (
        !isRecord(facts) ||
        facts.kind !== "auth-store-update" ||
        !(facts.port instanceof MessagePort)
      ) {
        return false;
      }
      if (exchangePort) {
        throw new Error("Auth profile updater was already invoked");
      }
      exchangePort = facts.port;
      // SAFETY: The paired worker queues all prepared fields before requesting the callback grant.
      const prepared = receiveAuthProfileUpdateValue(exchangePort) as AuthStoreUpdatePrepared;
      const response = params.update(prepared, owner);
      if (params.envOnly && response.save) {
        captureSharedSource();
      }
      sendAuthProfileUpdateValue(exchangePort, response);
      return true;
    };
    const collectCommitted = () => {
      nativeCommits ??= watchAuthProfileNativeCommits(owner.databasePath);
      committedIsCurrent = nativeCommits.capture();
      if (exchangePort) {
        // SAFETY: The paired worker queues canonical fields before requesting its commit grant.
        const received = receiveAuthProfileUpdateValue(exchangePort) as
          | AuthStoreUpdateCommittedWire
          | undefined;
        committed = received && {
          ...received,
          publication: {
            ...received.publication,
            oauthRefreshClaimIds: new Map(
              received.publication.oauthRefreshClaimIds.map(([profileId, claimId]) => [
                profileId,
                claimId ?? undefined,
              ]),
            ),
          },
        };
      }
    };
    const input = {
      owner: {
        databasePath: owner.databasePath,
        sharedDatabasePath: owner.sharedDatabasePath,
        location: owner.location,
      },
      agentDir: params.agentDir,
      envOnly: params.envOnly,
      peerGeneration: params.peerGeneration,
    };
    const publish = () => {
      acknowledged = true;
      return params.publish(committed, owner, assertAuthority, nativeCommits!, committedIsCurrent);
    };
    if (databaseTarget.kind === "shared-state") {
      const context = captureOpenClawStateWorkerContext({ env: owner.env });
      if (context.admission.databasePath !== owner.databasePath) {
        throw new Error("Auth profile worker differs from its captured owner");
      }
      assertAuthority = () => {
        context.admission.assertCurrent();
        context.maintenanceScope?.assertAdmission();
        assertOwner();
      };
      return runOpenClawStateWorkerOperation(
        context,
        async (scope) => {
          await scope.execute({ type: "authProfiles.update", input });
          return publish();
        },
        {
          assertCurrent: assertOwner,
          createAdmission: () => {
            let phase: "waiting" | "transaction" | "commit" = "waiting";
            return {
              nativeLocations: [owner.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                assertRequest();
                if (phase === "waiting" && request.stage === "transaction" && receive(request)) {
                  assertRequest();
                  phase = "transaction";
                } else if (phase === "transaction" && request.stage === "commit") {
                  collectCommitted();
                  assertRequest();
                  phase = "commit";
                } else {
                  throw new Error("Auth profile worker requested authority out of order");
                }
                if (!grant()) {
                  throw new Error("Auth profile worker authority expired");
                }
                commitGranted ||= request.stage === "commit";
              }),
            };
          },
        },
      );
    }
    const execution = capturedExecution ?? captureAuthProfileWriteExecution(databaseTarget);
    const assertCurrent = () => {
      execution.assertCurrent();
      assertOwner();
    };
    assertAuthority = assertCurrent;
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent,
      createAdmission(binding) {
        return () => {
          let transactionFacts: unknown;
          return {
            nativeLocations: binding.nativeLocations,
            admission: createSqliteWorkerOperationAdmission((request, grant) => {
              assertRequest();
              if (request.stage === "transaction") {
                transactionFacts = request.facts;
                if (!params.envOnly) {
                  captureSharedSource();
                }
              }
              if (
                request.stage === "prepare" &&
                isRecord(request.facts) &&
                request.facts.kind === "auth-store-update"
              ) {
                if (!transactionFacts) {
                  throw new Error("Auth profile callback requires transaction admission");
                }
                binding.authorize({ stage: "prepare", facts: transactionFacts });
                receive(request);
              } else {
                binding.authorize(request);
              }
              if (request.stage === "commit") {
                collectCommitted();
              }
              assertRequest();
              if (!grant()) {
                throw new Error("Auth profile worker authority expired");
              }
              commitGranted ||= request.stage === "commit";
            }, binding.attachment),
          };
        };
      },
    };
    let outcome: Result<void, unknown>;
    try {
      const value = await runOpenClawAgentWriteAdmission(
        databaseTarget,
        async () => {
          // Captured peers use existing-only admission; ordinary saves retain first-use creation.
          if (!params.existingDatabaseTarget) {
            await execution.prepare(source);
          }
          const result = await execution.runExisting(source, async (scope) => {
            const invoked = await executeOpenClawAgentWorkerPublication<
              InlineAuthFailureOperations,
              "authProfiles.update"
            >(scope, {
              id: randomUUID(),
              moduleUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.authProfileInlineUsage)
                .href,
              input: {},
              command: { type: "authProfiles.update", input },
            });
            if (invoked) {
              await publish();
            }
            return { value: undefined };
          });
          if (!result) {
            throw new Error("Auth profile database disappeared before mutation");
          }
          return result.value;
        },
        true,
      );
      outcome = { ok: true, value };
    } catch (error) {
      outcome = { ok: false, error };
      invalidateUnknown(error);
    }
    try {
      await execution.release();
    } catch (error) {
      if (!acknowledged) {
        if (!outcome.ok) {
          throw createSqliteLifecycleAggregateError(
            [outcome.error, error],
            "Auth update and executor cleanup failed",
            outcome.error,
          );
        }
        throw error;
      }
      reportCommittedInlineAuthFailure("Auth update settled before executor cleanup failed", error);
    }
    if (!outcome.ok) {
      throw outcome.error;
    }
    return outcome.value;
  })()
    .catch((error: unknown) => {
      invalidateUnknown(error);
      throw error;
    })
    .finally(() => {
      exchangePort?.close();
      nativeCommits?.dispose();
      sharedSource?.commits.dispose();
    });
}

export function createAuthProfileStoreUpdater(
  listRuntimeExternalAuthProfiles: ReturnType<
    typeof createExternalAuthRuntime
  >["listRuntimeExternalAuthProfiles"],
  host: {
    applyScopedAuthReadThrough: (store: AuthProfileStore) => AuthProfileStore;
    getScopedAuthProfileEnv: () => NodeJS.ProcessEnv | undefined;
    getScopedSharedAuthStore: () => AuthProfileStore | undefined;
    resolveRuntimeAuthProfileAgentDir: (agentDir?: string) => string | undefined;
    isEnvOnlyAuthProfileRuntime: () => boolean;
    load: (
      agentDir: string | undefined,
      options: LoadAuthProfileStoreOptions,
      env: NodeJS.ProcessEnv,
    ) => AuthProfileStore;
    save: (
      store: AuthProfileStore,
      agentDir: string | undefined,
      options: SaveAuthProfileStoreOptions | undefined,
      database: AuthProfileDatabase,
      owner: PreparedAuthProfileStoreOwner,
    ) => void;
  },
) {
  const {
    applyScopedAuthReadThrough,
    getScopedAuthProfileEnv,
    getScopedSharedAuthStore,
    resolveRuntimeAuthProfileAgentDir,
  } = host;
  /** Update under the write lock; null on contention or changed inherited read facts. */
  return async function updateAuthProfileStoreWithLock(params: {
    agentDir?: string;
    profileId?: string;
    sharedStoreWrite?: boolean;
    stateDir?: string;
    saveOptions?: SaveAuthProfileStoreOptions;
    assertCurrent?: () => void;
    updater: (
      store: AuthProfileStore,
      owner?: PreparedAuthProfileStoreOwner,
      sharedStore?: AuthProfileStore | null,
    ) => boolean;
  }): Promise<AuthProfileStore | null> {
    const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
    const envOnly = host.isEnvOnlyAuthProfileRuntime();
    try {
      if (params.profileId && isUserModelAuthProfileId(params.profileId)) {
        assertPersonalAuthProfileRuntime();
        params.assertCurrent?.();
        return (
          (await withPersonalAuthProfileStore(
            params.profileId,
            (owner) =>
              owner.update((store) => {
                params.assertCurrent?.();
                const changed = params.updater(store);
                params.assertCurrent?.();
                return changed;
              }, params.assertCurrent),
            params.stateDir,
          )) ?? { version: AUTH_STORE_VERSION, profiles: {} }
        );
      }
      const workerWrites = getWorkerAuthProfileWrites();
      const writeOptions = {
        sharedStoreWrite: params.sharedStoreWrite,
        stateDir: params.stateDir,
        env: params.stateDir ? undefined : (getScopedAuthProfileEnv() ?? workerWrites?.env),
        assertEnvironment: workerWrites?.assertOwner,
      };
      // Doctor keeps maintenance custody; catalog writes stay in their admitted worker request.
      if (workerWrites || getOpenClawDatabaseMaintenanceScope()?.ownsSchemaMaintenance) {
        const updateNative = () =>
          runAuthProfileWriteTransaction(
            agentDir,
            (database, owner) => {
              workerWrites?.assertOwner(owner.env);
              params.assertCurrent?.();
              const store = host.load(
                agentDir,
                { database, readOnly: true, syncExternalCli: false },
                owner.env,
              );
              const sharedStore =
                envOnly || owner.databasePath === owner.sharedDatabasePath
                  ? null
                  : loadPersistedAuthProfileStoreAtDatabasePath(
                      owner.sharedDatabasePath,
                      owner.location === "state-db" ? "shared-state" : "agent",
                    );
              const changed = params.updater(store, owner, sharedStore);
              workerWrites?.assertOwner(owner.env);
              params.assertCurrent?.();
              if (changed) {
                host.save(store, agentDir, params.saveOptions, database, owner);
              }
              return store;
            },
            writeOptions,
          );
        return await runAuthProfileUsage(async () =>
          workerWrites ? workerWrites.run(updateNative) : updateNative(),
        );
      }
      let loadedStore: AuthProfileStore;
      await runAuthProfileStoreUpdate({
        agentDir,
        envOnly,
        assertCurrent: params.assertCurrent,
        options: writeOptions,
        update(prepared, owner) {
          if (!envOnly) {
            assertAuthProfileMigrationCandidates({
              databasePath: owner.databasePath,
              candidates: resolveLegacyAuthProfileSourceCandidates({ agentDir, env: owner.env }),
              hasCredentials: () => Object.keys(prepared.store.profiles).length > 0,
            });
            observeCanonicalAuthProfileCredentials(owner.databasePath, prepared.store.profiles);
          }
          loadedStore = applyScopedAuthReadThrough(prepared.store);
          const save = params.updater(loadedStore, owner, prepared.mainStore);
          if (!save) {
            return { save: false };
          }
          const sanitize = (store: AuthProfileStore | undefined) =>
            store && {
              ...store,
              profiles: buildPersistedAuthProfileSecretsStore(store).profiles,
            };
          const options = params.saveOptions;
          const copyIds = (ids: Iterable<string> | undefined) => ids && [...ids];
          return {
            save: true,
            store: sanitize(loadedStore)!,
            scopedSharedStore: sanitize(getScopedSharedAuthStore()),
            externalProfiles:
              options?.filterExternalAuthProfiles !== false
                ? listRuntimeExternalAuthProfiles({ store: loadedStore, agentDir })
                : [],
            runtimeStore:
              options?.filterExternalAuthProfiles !== false
                ? sanitize(getRuntimeAuthProfileStoreSnapshotAtDatabasePath(owner.databasePath))
                : undefined,
            options: options && {
              ...options,
              preserveOrderProfileIds: copyIds(options.preserveOrderProfileIds),
              preserveStateProfileIds: copyIds(options.preserveStateProfileIds),
              pruneOrderProfileIds: copyIds(options.pruneOrderProfileIds),
            },
          };
        },
        async publish(committed, owner, assertCurrent, nativeCommits, committedIsCurrent) {
          if (committed) {
            try {
              await publishAuthProfileStoreUpdate(
                owner,
                committed,
                assertCurrent,
                nativeCommits,
                committedIsCurrent,
              );
            } catch (error) {
              invalidateRuntimeAuthProfileStoreSnapshotsForOwner(owner);
              reportCommittedInlineAuthFailure(
                "Auth store committed before publication failed",
                error,
              );
            }
          }
        },
      });
      return loadedStore!;
    } catch (error) {
      if (error instanceof AuthProfileSharedSourceChangedError) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      authProfilesLog.warn(`auth profile store update failed: ${message}`, {
        agentDir,
        error: message,
      });
      if (!isSqliteLockError(error)) {
        throw error;
      }
      return null;
    }
  };
}
