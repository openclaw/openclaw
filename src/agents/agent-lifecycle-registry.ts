import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PersistedClawInstall } from "../claws/provenance-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureActiveCronJobAgentDeletion } from "../cron/active-jobs.js";
import {
  withCronReceiptAuthorityMutation,
  type CronReceiptAuthorityMutation,
} from "../cron/store/receipt-authority-owner.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  captureAgentDatabasePreparationDeletionForIdentity,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { createAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import {
  assertAgentDeletionFinalInDatabase,
  assertAgentDeletionLeaseFinal,
} from "../state/agent-deletion-final-guard.js";
import type {
  AgentDeletionInput,
  AgentDeletionJournalTransport,
} from "../state/agent-deletion-journal-transport.js";
import {
  readAgentDeletionJournal,
  readAgentDeletionJournalInDatabase,
  type AgentDeletionJournalCleanupPath,
  type AgentDeletionJournalEntry,
} from "../state/agent-deletion-journal.js";
import type { AgentDeletionWorkerPredicate } from "../state/agent-deletion-worker-contract.js";
import type { AgentDeletionWorkerAuthority } from "../state/agent-deletion-worker.types.js";
import {
  readAgentLifecycleStoreFacts,
  type AgentLifecycleStoreFacts,
} from "../state/agent-lifecycle-read.kernel.js";
import type { AgentProvenance } from "../state/agent-provenance.js";
import { prepareOpenClawAgentDatabaseRegistryRemoval } from "../state/openclaw-agent-db-registry-listing.js";
import { invalidateOpenClawAgentDatabaseValidationsForAgent } from "../state/openclaw-agent-db-validation-cache.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import {
  executeExistingOpenClawStateRead,
  withExistingOpenClawStateDatabaseCurrentReadOnly,
} from "../state/openclaw-state-db-readonly.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
import { verifyOpenClawStateLeaseOwnership } from "../state/openclaw-state-lease-storage.js";
import {
  withOpenClawStateLeaseWorkerAdmission,
  withOpenClawStateLeasesWorkerAdmission,
} from "../state/openclaw-state-lease-worker-owner.js";
import { withOpenClawStateLeaseAsync } from "../state/openclaw-state-lease.js";
import type { OpenClawStateLeaseIdentity } from "../state/openclaw-state-lease.types.js";
import {
  captureOpenClawStateReadWorkerContext,
  captureOpenClawStateWorkerContext,
} from "../state/openclaw-state-worker-context.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  beginRemoteAgentDeletionJournal,
  rollbackRemoteAgentDeletionJournal,
} from "./agent-deletion-journal-remote.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
export {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "./agent-deletion-errors.js";

export { claimCompletedAgentDeletion } from "./agent-deletion-claim.js";

const log = createSubsystemLogger("agents/lifecycle");

export type AgentLifecycleBinding = Readonly<{
  agentId: string;
  provenance: AgentProvenance | null;
}>;

type AgentDeletionBeginOptions = {
  expectedClawInstall?: PersistedClawInstall | null;
  preserveDeleteFiles?: boolean;
};

export type AgentDeletionOperation = AgentDeletionWorkerAuthority & {
  entry: AgentDeletionJournalEntry;
  previousEntry?: AgentDeletionJournalEntry;
  assertCurrentAsync(this: void): Promise<void>;
  assertCurrentFinal(this: void): void;
  runDatabaseCleanup: ReturnType<typeof createAgentDeletionDatabaseCleanup>;
  fenceDatabasePaths(paths: readonly string[]): Promise<void>;
  fenceCleanupPaths(paths: readonly AgentDeletionJournalCleanupPath[]): Promise<void>;
  finish(options?: { unregisterDatabases?: boolean }): Promise<void>;
  releaseClawRows(input: {
    files: Array<{ path: string; action: string }>;
    complete: boolean;
  }): Promise<boolean>;
  handoffClawRetry(): Promise<void>;
  rollback(): Promise<void>;
};

/** Acquire before the config lock and retain ownership through cleanup and recovery. */
export function withAgentDeletion<T>(
  agentId: string,
  run: (
    begin: (
      entry: AgentDeletionInput,
      options?: AgentDeletionBeginOptions,
    ) => Promise<AgentDeletionOperation>,
  ) => Promise<T>,
  options: OpenClawStateDatabaseOptions & { journalTransport?: AgentDeletionJournalTransport } = {},
): Promise<T> {
  const id = normalizeAgentId(agentId);
  const journalTransport = options.journalTransport;
  if (isReservedSystemAgentId(id)) {
    throw new Error(
      `System agent ${id} cannot be deleted; run openclaw doctor --fix to quarantine invalid deletion history.`,
    );
  }
  const statePath = path.resolve(
    options.database?.path ??
      options.path ??
      resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const context = captureOpenClawStateWorkerContext({
    ...options,
    path: statePath,
    env: { ...(options.env ?? process.env) },
  });
  return withOpenClawStateLeaseAsync(
    {
      scope: "core:agent-deletion",
      key: id,
      leaseMs: 60_000,
      waitMs: 5_000,
      heartbeat: "worker",
      leaseLabel: "agent deletion",
      operationLabel: "agent.deletion.lease",
    },
    context,
    async (lease) =>
      withOpenClawStateLeaseWorkerAdmission(lease, statePath, async (lifetime) => {
        let publishRegistryRemoval: () => void;
        let begun = false;
        let closed = false;
        let currentOperationId: string | undefined;
        const assertCurrentHost = () => {
          if (closed) {
            throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
          }
          lifetime.assertCurrent();
        };
        const execute = <Result>(
          apply: (
            scope: DomainScope,
            identity: typeof lifetime.identity,
            additionalIdentities: readonly OpenClawStateLeaseIdentity[],
          ) => Promise<Result>,
          publication?: {
            mutation?: CronReceiptAuthorityMutation;
            assertCurrent?: () => void;
            onCommitted?: (facts: unknown) => void;
            onAdmission?: (request: SqliteWorkerAdmissionRequest, stateIdentityKey: string) => void;
            additionalLeases?: readonly OpenClawStateWorkerLeaseContext[];
          },
        ): Promise<Result> => {
          assertCurrentHost();
          const invoke = (
            admission: Pick<typeof lifetime, "assertCurrent" | "createAdmission">,
            identities: readonly OpenClawStateLeaseIdentity[],
          ) => {
            const identity = identities[0];
            if (!identity) {
              throw new Error("Agent deletion requires a retained lease");
            }
            return runOpenClawStateWorkerOperation(
              publication?.mutation?.context ?? context,
              (scope) => apply(scope, identity, identities.slice(1)),
              {
                assertCurrent: admission.assertCurrent,
                createAdmission: (retained) => {
                  const created = admission.createAdmission(retained);
                  if (publication?.onAdmission) {
                    created.admission.observeRequests((request) =>
                      publication.onAdmission?.(request, context.admission.identity.key),
                    );
                  }
                  const onCommitted = (facts: unknown) => {
                    if (
                      !isRecord(facts) ||
                      (facts.kind !== "agent-deletion-mutated" &&
                        facts.kind !== "agent-deletion-began")
                    ) {
                      publication?.onCommitted?.(facts);
                      return;
                    }
                    if (facts.agentId !== id || facts.operationId !== currentOperationId) {
                      throw new Error("Agent deletion commit receipt does not match its owner");
                    }
                    publication?.onCommitted?.(facts);
                    try {
                      (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
                    } catch (error) {
                      if (isStateDatabaseReadAdmissionInvalidatedError(error)) {
                        return;
                      }
                      throw error;
                    }
                    if (facts.unregisterDatabases === true) {
                      invalidateOpenClawAgentDatabaseValidationsForAgent(id, []);
                    }
                    publishRegistryRemoval();
                  };
                  if (publication?.mutation) {
                    publication.mutation.observe(created.admission, retained, onCommitted);
                  } else {
                    observeSqliteWorkerCommittedFacts(created.admission, ({ facts }) =>
                      onCommitted(facts),
                    );
                  }
                  return created;
                },
              },
            );
          };
          const authority = {
            assertCurrent: () => {
              assertCurrentHost();
              publication?.mutation?.assertCurrent();
              publication?.assertCurrent?.();
            },
          };
          return publication?.additionalLeases?.length
            ? withOpenClawStateLeasesWorkerAdmission(
                [lease, ...publication.additionalLeases],
                context,
                (admission) => invoke(admission, admission.identities),
                authority,
              )
            : withOpenClawStateLeaseWorkerAdmission(
                lease,
                statePath,
                (admission) => invoke(admission, [admission.identity]),
                authority,
              );
        };
        try {
          return await run(async (entry, beginOptions = {}) => {
            assertCurrentHost();
            if (begun || normalizeAgentId(entry.agentId) !== id) {
              throw new Error(`Agent ${id} deletion already began or has a different target.`);
            }
            begun = true;
            const capturedEntry = structuredClone(entry);
            publishRegistryRemoval = await prepareOpenClawAgentDatabaseRegistryRemoval(id, {
              path: statePath,
              env: context.environment,
            });
            assertCurrentHost();
            const preserveDeleteFiles = beginOptions.preserveDeleteFiles;
            const operationId = crypto.randomUUID();
            currentOperationId = operationId;
            const predicate: AgentDeletionWorkerPredicate = {
              agentId: id,
              operationId,
              expectedClawInstall: structuredClone(beginOptions.expectedClawInstall),
            };
            const cancelCronRuns = captureActiveCronJobAgentDeletion(
              id,
              context.admission.identity.key,
            );
            const invalidatePreparation = captureAgentDatabasePreparationDeletionForIdentity(id, {
              databasePath: statePath,
              identityKey: context.admission.identity.key,
            });
            const remoteOwner = journalTransport
              ? { lease, context, transport: journalTransport, assertCurrent: assertCurrentHost }
              : undefined;
            const { entry: journal, previousEntry } = remoteOwner
              ? await beginRemoteAgentDeletionJournal(
                  remoteOwner,
                  { ...capturedEntry, agentId: id },
                  operationId,
                )
              : await withCronReceiptAuthorityMutation(context, async (mutation) =>
                  execute(
                    (scope, identity) =>
                      scope.execute({
                        type: "agentDeletion.begin",
                        input: {
                          entry: {
                            ...capturedEntry,
                            agentId: id,
                            operationId,
                            deleteFiles: capturedEntry.deleteFiles !== false,
                          },
                          lease: identity,
                          expectedClawInstall: predicate.expectedClawInstall,
                          preserveDeleteFiles,
                          nonce: mutation.attachment.nonce,
                        },
                      }),
                    {
                      mutation,
                      onCommitted: () => {
                        invalidatePreparation();
                        cancelCronRuns();
                      },
                    },
                  ),
                );
            if (remoteOwner) {
              invalidatePreparation();
              cancelCronRuns();
              publishRegistryRemoval();
            }
            assertCurrentHost();
            const authority: AgentDeletionWorkerAuthority = {
              assertCurrentHost,
              withStateLease: (leaseOptions, apply) =>
                withOpenClawStateLeaseAsync(leaseOptions, context, (additionalLease) =>
                  withOpenClawStateLeaseWorkerAdmission(
                    additionalLease,
                    statePath,
                    (admission) => {
                      const assertLeaseCurrentHost = () => {
                        assertCurrentHost();
                        admission.assertCurrent();
                      };
                      return apply(additionalLease, assertLeaseCurrentHost, () =>
                        assertAgentDeletionLeaseFinal(
                          {
                            ...admission.identity,
                            leaseLabel: leaseOptions.leaseLabel ?? "state lease",
                          },
                          { path: statePath, env: context.environment },
                          assertLeaseCurrentHost,
                        ),
                      );
                    },
                    { assertCurrent: assertCurrentHost },
                  ),
                ),
              runWithLeaseAdmission: (operation) =>
                withOpenClawStateLeaseWorkerAdmission(
                  lease,
                  statePath,
                  (scope) => operation(scope, { lease: scope.identity, predicate }),
                  { assertCurrent: assertCurrentHost },
                ),
              runWithWorker: (operation, publication) =>
                execute(
                  (scope, identity, additionalIdentities) =>
                    operation(scope, { lease: identity, predicate }, additionalIdentities),
                  publication,
                ),
            };
            const assertCurrentAsync = async () => {
              await authority.runWithWorker((scope, guard) =>
                scope.execute({ type: "agentDeletion.assertCurrent", input: { guard } }),
              );
              assertCurrentHost();
            };
            const assertCurrentFinal = () => {
              assertCurrentHost();
              const found = withExistingOpenClawStateDatabaseCurrentReadOnly(
                ({ db }) => {
                  assertAgentDeletionFinalInDatabase(db, { lease: lifetime.identity, predicate });
                  return true;
                },
                { path: statePath, env: context.environment },
              );
              if (!found) {
                throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
              }
              assertCurrentHost();
            };
            const assertNativeCurrent = (database?: OpenClawStateDatabase) => {
              assertCurrentHost();
              const current = database
                ? readAgentDeletionJournalInDatabase(database, id)
                : readAgentDeletionJournal(id, { path: statePath, env: context.environment });
              if (!current || current.operationId !== operationId || current.cleanupCompleted) {
                throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
              }
              verifyOpenClawStateLeaseOwnership({
                ...lifetime.identity,
                leaseLabel: "agent deletion",
                ...(database
                  ? { transaction: database.db }
                  : {
                      database: {
                        scope: "shared" as const,
                        options: { path: statePath, env: context.environment },
                      },
                    }),
              });
              assertCurrentHost();
            };
            const operation: AgentDeletionOperation = {
              ...authority,
              entry: journal,
              previousEntry,
              assertCurrentAsync,
              assertCurrentFinal,
              runDatabaseCleanup: createAgentDeletionDatabaseCleanup({
                statePath,
                workerAuthority: authority,
                assertCurrent: assertNativeCurrent,
                assertCurrentAsync,
                assertAdmission: () =>
                  authority.runWithWorker((scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.assertNoDatabaseLeases",
                      input: { guard },
                    }),
                  ),
                assertJournal: (currentStatePath, entries) => {
                  assertCurrentHost();
                  if (
                    path.resolve(currentStatePath) !== statePath ||
                    !entries.some(
                      (current) =>
                        current.agentId === id &&
                        current.operationId === operationId &&
                        !current.cleanupCompleted,
                    )
                  ) {
                    throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
                  }
                  return id;
                },
                withCommit: (commit) => {
                  let committed = false;
                  try {
                    runOpenClawStateWriteTransaction(
                      (database) => {
                        assertNativeCurrent(database);
                        commit();
                        committed = true;
                      },
                      { path: statePath, env: context.environment },
                    );
                  } catch (error) {
                    if (!committed) {
                      throw error;
                    }
                    // A guard-release failure cannot roll back the already-durable agent COMMIT.
                    try {
                      log.warn("Agent deletion committed, but releasing its state guard failed", {
                        agentId: id,
                        error,
                      });
                    } catch {
                      // Postcommit diagnostics cannot change the durable outcome.
                    }
                  }
                },
              }),
              fenceDatabasePaths: async (paths) => {
                const normalized = [...new Set(paths.map((pathname) => path.resolve(pathname)))];
                await authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.fencePaths",
                      input: { guard, paths: { kind: "database", paths: normalized } },
                    }),
                  {
                    onCommitted: () => {
                      journal.databasePaths = normalized;
                    },
                  },
                );
              },
              fenceCleanupPaths: async (paths) => {
                const captured = structuredClone([...paths]);
                await authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.fencePaths",
                      input: { guard, paths: { kind: "cleanup", paths: captured } },
                    }),
                  {
                    onCommitted: () => {
                      journal.cleanupPaths = captured;
                    },
                  },
                );
              },
              finish: async (finishOptions) => {
                await authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.finish",
                      input: { guard, ...finishOptions },
                    }),
                  {
                    onCommitted: () => {
                      closed = true;
                    },
                  },
                );
              },
              releaseClawRows: async (input) => {
                const completed = await authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.releaseClawRows",
                      input: { guard, ...input },
                    }),
                  {
                    onCommitted: () => {
                      if (input.complete) {
                        closed = true;
                      }
                    },
                  },
                );
                if (completed) {
                  closed = true;
                }
                return completed;
              },
              handoffClawRetry: async () => {
                if (closed || !predicate.expectedClawInstall) {
                  return;
                }
                const handedOff = await authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.handoffClawRetry",
                      input: { guard, retryOperationId: crypto.randomUUID(), nowMs: Date.now() },
                    }),
                  {
                    onCommitted: () => {
                      closed = true;
                    },
                  },
                );
                if (handedOff) {
                  closed = true;
                }
              },
              rollback: async () => {
                if (remoteOwner) {
                  await rollbackRemoteAgentDeletionJournal(remoteOwner, id, operationId);
                  closed = true;
                  publishRegistryRemoval();
                  return;
                }
                await withCronReceiptAuthorityMutation(
                  context,
                  (mutation) =>
                    execute(
                      (scope, identity) =>
                        scope.execute({
                          type: "agentDeletion.rollback",
                          input: {
                            guard: { lease: identity, predicate },
                            nonce: mutation.attachment.nonce,
                          },
                        }),
                      {
                        mutation,
                        onCommitted: () => {
                          closed = true;
                        },
                      },
                    ),
                  { settlement: true },
                );
              },
            };
            return operation;
          });
        } finally {
          closed = true;
        }
      }),
  );
}

/** Return whether this process must refuse new authority for an agent id. */
export function isAgentDeletionBlocked(
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
  database?: DatabaseSync,
): boolean {
  return Boolean(
    database
      ? readAgentDeletionJournalInDatabase({ db: database }, agentId, "runtime")
      : readAgentDeletionJournal(agentId, options, "runtime"),
  );
}

/** Keep persisted identity stable until the winning deletion completes or rolls back. */
export function assertAgentDeletionAllowsMutation(
  database: OpenClawStateDatabase,
  agentId: string,
): void {
  const id = normalizeAgentId(agentId);
  const journal = readAgentDeletionJournalInDatabase(database, id);
  if (journal && !journal.cleanupCompleted) {
    throw new Error(`Agent ${id} has pending deletion; retry after removal completes.`);
  }
}

async function readLifecycleFactsInWorker(
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): Promise<AgentLifecycleStoreFacts> {
  const context = captureOpenClawStateReadWorkerContext({
    path: options.database?.path ?? options.path,
    env: options.env,
  });
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "agentLifecycle.read", input: agentId },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (!reply) {
    return { deletionBlocked: false, provenance: null };
  }
  if (!reply.ok) {
    throw new Error(reply.message);
  }
  if (reply.type !== "agentLifecycle.read") {
    throw new Error("Unexpected agent lifecycle result");
  }
  return reply.facts;
}

function admitsLifecycleBinding(
  config: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): boolean {
  return (
    Boolean(resolveAgentConfig(config, agentId)) &&
    !readAgentDatabaseAdmissionRefusal(agentId, options)
  );
}

/** Prepare an incarnation comparison; final consumers still recheck current authority. */
export async function captureAgentLifecycleBinding(
  getConfig: () => OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): Promise<AgentLifecycleBinding | undefined> {
  const capturedOptions = {
    path: options.database?.path ?? options.path,
    env: { ...(options.env ?? process.env) },
  };
  const id = normalizeAgentId(agentId);
  if (!admitsLifecycleBinding(getConfig(), id, capturedOptions)) {
    return undefined;
  }
  const facts = await readLifecycleFactsInWorker(id, capturedOptions);
  if (facts.deletionBlocked || !admitsLifecycleBinding(getConfig(), id, capturedOptions)) {
    return undefined;
  }
  return Object.freeze({ agentId: id, provenance: facts.provenance });
}

/** Preparatory checks may yield; the final effect guard below remains synchronous. */
export async function matchesAgentLifecycleBindingAsync(
  getConfig: () => OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): Promise<boolean> {
  const capturedBinding = structuredClone(binding);
  const capturedOptions = {
    path: options.database?.path ?? options.path,
    env: { ...(options.env ?? process.env) },
  };
  const id = normalizeAgentId(capturedBinding.agentId);
  if (id !== capturedBinding.agentId || !admitsLifecycleBinding(getConfig(), id, capturedOptions)) {
    return false;
  }
  const facts = await readLifecycleFactsInWorker(id, capturedOptions);
  return (
    !facts.deletionBlocked &&
    admitsLifecycleBinding(getConfig(), id, capturedOptions) &&
    isDeepStrictEqual(facts.provenance, capturedBinding.provenance)
  );
}

/** Native/SDK and foreign writers require a current point read at the final effect boundary. */
export function matchesAgentLifecycleBinding(
  config: OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(binding.agentId);
  if (id !== binding.agentId || !admitsLifecycleBinding(config, id, options)) {
    return false;
  }
  const facts = withExistingOpenClawStateDatabaseCurrentReadOnly(
    ({ db }) => readAgentLifecycleStoreFacts(db, id),
    options,
  );
  return (
    !facts?.deletionBlocked && isDeepStrictEqual(facts?.provenance ?? null, binding.provenance)
  );
}
