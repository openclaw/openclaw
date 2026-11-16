import { randomUUID } from "node:crypto";
import { MessagePort } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { hasSqliteWorkerOutcomeUnknown } from "../../infra/sqlite-worker-contract.js";
import type { DatabasePathIdentity } from "../../infra/sqlite-worker-identity.js";
import {
  createSqliteWorkerOperationAdmission,
  type SqliteWorkerAdmissionRequest,
} from "../../infra/sqlite-worker-operation-admission.js";
import type { AgentDatabaseRequestExecutionSource } from "../../state/openclaw-agent-execution-admission-contract.js";
import type { OpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution-contract.js";
import { toAgentExecutionConstraints } from "../../state/openclaw-agent-execution-scope.js";
import { captureOpenClawAgentDatabaseExecutionAsync } from "../../state/openclaw-agent-execution.js";
import { executeOpenClawAgentWorkerPublication } from "../../state/openclaw-agent-worker-store.js";
import { runOpenClawAgentWriteAdmission } from "../../state/openclaw-agent-write-admission.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../../state/openclaw-state-worker-store.js";
import { takeAuthProfileAuthorizationWriteIntents } from "./authorization-lifetime.js";
import { reportCommittedInlineAuthFailure } from "./constants.js";
import { readAuthProfileDatabaseIdentityAsync } from "./file-state.js";
import type { InlineAuthFailureOperations } from "./inline-usage-kernel.js";
import { assertAuthProfileMigrationStateAtDatabasePath } from "./legacy-source-diagnostic.js";
import { getRuntimeAuthProfileStoreMutationRevisionAtDatabasePath } from "./mutation-lineage.js";
import {
  getPreparedSharedAuthStoreOwnership,
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
} from "./path-resolve.js";
import { invalidateRuntimeAuthProfileStoreSnapshotsForOwner } from "./runtime-snapshots.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { isSharedAuthProfileWrite } from "./shared-store-bootstrap.js";
import {
  prepareAuthProfileWriteTransaction,
  prepareAuthProfileWriteTransactionAsync,
  prepareAuthProfileWriteEnvironment,
  resolveAuthProfileDatabasePath,
  resolveAuthProfileDatabaseOwnerId,
} from "./sqlite.js";
import { watchAuthProfileNativeCommits } from "./store-update-commit.js";
import {
  createAuthProfileStoreUpdatePublication,
  publishAuthProfileStoreUpdate,
} from "./store-update-publication.js";
import {
  sendAuthProfileUpdateValue,
  receiveAuthProfileUpdateValue,
} from "./store-update-transfer.js";
import type {
  AuthStoreUpdatePrepared,
  AuthStoreUpdateCommitted,
  AuthStoreUpdateResponse,
  AuthStoreUpdateResponseWire,
} from "./store-update.worker.js";
import type { AuthStoreUpdateInput } from "./store.worker-contract.js";
import type { PreparedAuthProfileStoreOwner } from "./types.js";
import { reserveAuthProfileUsagePreparation, runAuthProfileUsage } from "./usage-lifecycle.js";

export class AuthProfileSharedSourceChangedError extends Error {}

/** The existing SQLite worker owns BEGIN/read/save/COMMIT; host callbacks keep their scope. */
type AuthProfileStoreUpdate = {
  existingDatabaseTarget?: {
    kind: "agent";
    agentId: string;
    path: string;
    env: NodeJS.ProcessEnv;
    identity: DatabasePathIdentity;
  };
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

export function createAuthProfileStoreUpdatePublisher(
  failureMessage?: string,
): AuthProfileStoreUpdate["publish"] {
  return async (committed, owner, ...publication) => {
    if (!committed) {
      return;
    }
    try {
      await publishAuthProfileStoreUpdate(owner, committed, ...publication);
    } catch (error) {
      if (!failureMessage) {
        throw error;
      }
      invalidateRuntimeAuthProfileStoreSnapshotsForOwner(owner);
      reportCommittedInlineAuthFailure(failureMessage, error);
    }
  };
}

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
    const captured = target
      ? captureOpenClawAgentDatabaseExecutionAsync(
          { ...target, env },
          params.existingDatabaseTarget?.identity.key.startsWith("file:")
            ? toAgentExecutionConstraints(params.existingDatabaseTarget.identity)
            : {},
        ).then(
          (value) => ({ ok: true, value }) as const,
          (error: unknown) => ({ ok: false, error }) as const,
        )
      : undefined;
    let execution: OpenClawAgentDatabaseExecution | undefined;
    let transferred = false;
    const assertCurrent = () => {
      context.admission.assertCurrent();
      context.maintenanceScope?.assertAdmission();
      execution?.assertCurrent();
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
      const result = await captured;
      if (result && !result.ok) {
        throw result.error;
      }
      execution = result?.value;
      const prepared = await prepareAuthProfileWriteTransactionAsync(
        params.agentDir,
        { ...params.options, env },
        assertCurrent,
      );
      const sharedIdentity =
        prepared.sharedOwner.location === "state-db"
          ? context.admission.identity
          : await readAuthProfileDatabaseIdentityAsync(prepared.sharedOwner.sharedDatabasePath);
      assertCurrent();
      const databaseTarget = params.existingDatabaseTarget ?? prepared.databaseTarget;
      transferred = databaseTarget.kind === "agent" && databaseTarget.path === target?.path;
      // Bootstrap's acknowledged handoff selects the already-captured shared-state owner.
      execution = transferred ? execution : undefined;
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
          sharedIdentity,
        },
        execution,
      );
    } finally {
      try {
        const result = await captured;
        if (!transferred && result?.ok) {
          await result.value.release();
        }
      } finally {
        reservation.release();
      }
    }
  });
}

async function runPreparedAuthProfileStoreUpdate(
  params: AuthProfileStoreUpdate,
  {
    databaseTarget,
    sharedOwner,
    sharedIdentity,
  }: ReturnType<typeof prepareAuthProfileWriteTransaction> & {
    sharedIdentity: DatabasePathIdentity | undefined;
  },
  capturedExecution?: OpenClawAgentDatabaseExecution,
): Promise<void> {
  const owner: PreparedAuthProfileStoreOwner = {
    ...sharedOwner,
    databasePath: databaseTarget.path,
  };
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
      const commits = watchAuthProfileNativeCommits(owner.sharedDatabasePath, sharedIdentity);
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
      sendAuthProfileUpdateValue(
        exchangePort,
        response.save
          ? ({
              ...response,
              authorizationIntents:
                "store" in response
                  ? takeAuthProfileAuthorizationWriteIntents(response.store.profiles)
                  : [],
            } satisfies AuthStoreUpdateResponseWire)
          : response,
      );
      return true;
    };
    const collectCommitted = () => {
      nativeCommits ??= watchAuthProfileNativeCommits(owner.databasePath, owner.databaseIdentity);
      committedIsCurrent = nativeCommits.capture();
      if (exchangePort) {
        // SAFETY: The paired worker queues canonical fields before requesting its commit grant.
        const received = receiveAuthProfileUpdateValue(exchangePort) as
          | AuthStoreUpdateCommitted
          | undefined;
        committed = received;
      }
      return committed;
    };
    const withCredentialPublication = createAuthProfileStoreUpdatePublication({
      databasePath: owner.databasePath,
      collectCommitted,
      committedIsCurrent: () => committedIsCurrent(),
      assertCurrent: () => assertAuthority(),
    });
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
        owner.databaseIdentity = context.admission.identity;
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
          createAdmission: withCredentialPublication((collect) => () => {
            let phase: "waiting" | "transaction" | "commit" = "waiting";
            return {
              nativeLocations: [owner.databasePath],
              admission: createSqliteWorkerOperationAdmission((request, grant) => {
                assertRequest();
                if (phase === "waiting" && request.stage === "transaction" && receive(request)) {
                  assertRequest();
                  phase = "transaction";
                } else if (phase === "transaction" && request.stage === "commit") {
                  collect();
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
          }),
        },
      );
    }
    const execution =
      capturedExecution ?? (await captureOpenClawAgentDatabaseExecutionAsync(databaseTarget));
    const assertCurrent = () => {
      execution.assertCurrent();
      owner.databaseIdentity = execution.fileIdentity;
      assertOwner();
    };
    assertAuthority = assertCurrent;
    const source: AgentDatabaseRequestExecutionSource = {
      assertCurrent,
      createAdmission(binding) {
        return withCredentialPublication((collect) => () => {
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
                collect();
              }
              assertRequest();
              if (!grant()) {
                throw new Error("Auth profile worker authority expired");
              }
              commitGranted ||= request.stage === "commit";
            }, binding.attachment),
          };
        });
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
