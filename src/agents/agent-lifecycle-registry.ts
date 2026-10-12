import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { PersistedClawInstall } from "../claws/provenance-types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureActiveCronJobAgentDeletion } from "../cron/active-jobs.js";
import {
  observeSqliteWorkerCommittedFacts,
  type SqliteWorkerAdmissionRequest,
} from "../infra/sqlite-worker-operation-admission.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { publishAgentDeletionWorkAdmission } from "../sessions/session-agent-work-admission.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  captureAgentDatabasePreparationDeletionForIdentity,
  readAgentDatabaseAdmissionRefusal,
} from "../state/agent-database-admission.js";
import { createAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import {
  observeAgentDeletionJournal,
  withAgentDeletionJournalPublication,
} from "../state/agent-deletion-journal-publication.js";
import { agentDeletionJournalPublication } from "../state/agent-deletion-journal-publication.js";
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
import type { AgentLifecycleStoreFacts } from "../state/agent-lifecycle-read.worker.js";
import { agentProvenancePublication } from "../state/agent-provenance-publication.js";
import type { AgentProvenance } from "../state/agent-provenance.js";
import { prepareOpenClawAgentDatabaseRegistryRemoval } from "../state/openclaw-agent-db-registry-listing.js";
import { invalidateOpenClawAgentDatabaseValidationsForAgent } from "../state/openclaw-agent-db-validation-cache.js";
import { isStateDatabaseReadAdmissionInvalidatedError } from "../state/openclaw-state-db-async-lifecycle.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { executeExistingOpenClawStateRead } from "../state/openclaw-state-db-readonly.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import type { OpenClawStateWorkerLeaseContext } from "../state/openclaw-state-lease-context.js";
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
import type { OpenClawStateWorkerContext } from "../state/openclaw-state-worker-context.types.js";
import { runOpenClawStateWorkerOperation } from "../state/openclaw-state-worker-store.js";
import type { DomainScope } from "../state/openclaw-state-worker-store.types.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import {
  beginRemoteAgentDeletionJournal,
  fenceAgentDeletionJournalPaths,
  rollbackRemoteAgentDeletionJournal,
} from "./agent-deletion-journal-mutations.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
export {
  AgentDeletionAuthorityRollbackError,
  AgentDeletionCommitUncertainError,
} from "./agent-deletion-errors.js";

export { claimCompletedAgentDeletion } from "./agent-deletion-claim.js";

export type AgentLifecycleBinding = Readonly<{
  agentId: string;
  provenance: AgentProvenance | null;
}>;

type AgentDeletionBeginOptions = {
  expectedClawInstall?: PersistedClawInstall | null;
  preserveDeleteFiles?: boolean;
  recoveryOperationId?: string;
};

export type AgentDeletionOperation = AgentDeletionWorkerAuthority & {
  entry: AgentDeletionJournalEntry;
  previousEntry?: AgentDeletionJournalEntry;
  assertCurrentAsync(this: void): Promise<void>;
  assertCurrentFinal(this: void): void;
  runDatabaseCleanup: ReturnType<typeof createAgentDeletionDatabaseCleanup>;
  fenceDatabasePaths(paths: readonly string[]): Promise<void>;
  fenceCleanupPaths(paths: readonly AgentDeletionJournalCleanupPath[]): Promise<void>;
  retire(): Promise<void>;
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
        const currentJournal = observeAgentDeletionJournal(id, context);
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
        const execute = async <Result>(
          apply: (
            scope: DomainScope,
            identity: typeof lifetime.identity,
            additionalIdentities: readonly OpenClawStateLeaseIdentity[],
          ) => Promise<Result>,
          publication?: {
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
              context,
              (scope) => apply(scope, identity, identities.slice(1)),
              {
                assertCurrent: admission.assertCurrent,
                createAdmission: (retained) => {
                  const created = withAgentDeletionJournalPublication(
                    admission.createAdmission,
                    context,
                  )(retained);
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
                  observeSqliteWorkerCommittedFacts(created.admission, ({ facts }) =>
                    onCommitted(facts),
                  );
                  return created;
                },
              },
            );
          };
          const authority = {
            assertCurrent: () => {
              assertCurrentHost();
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
            const publishIngress = (pending: boolean) => {
              (context.assertPublicationCurrent ?? context.admission.assertCurrent)();
              publishAgentDeletionWorkAdmission(
                { agentId: id, statePath, env: context.environment },
                operationId,
                pending,
              );
            };
            const completeOperation = () => {
              closed = true;
              publishIngress(false);
            };
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
              : await execute(
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
                        recoveryOperationId: beginOptions.recoveryOperationId,
                      },
                    }),
                  {
                    onCommitted: () => {
                      publishIngress(true);
                      invalidatePreparation();
                      cancelCronRuns();
                    },
                  },
                );
            currentJournal.seed(journal);
            if (remoteOwner) {
              publishIngress(true);
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
                      return apply(additionalLease, assertLeaseCurrentHost, assertLeaseCurrentHost);
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
              // Begin validates the install, whose writers refuse the pending journal.
              currentJournal.assertCurrent(operationId);
            };
            const operation: AgentDeletionOperation = {
              ...authority,
              entry: journal,
              previousEntry,
              assertCurrentAsync,
              assertCurrentFinal,
              retire: () =>
                authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({ type: "agentDeletion.retire", input: { guard } }),
                  {
                    onCommitted: () => {
                      journal.phase = "retiring";
                    },
                  },
                ),
              runDatabaseCleanup: createAgentDeletionDatabaseCleanup({
                agentId: id,
                statePath,
                workerAuthority: authority,
                assertCurrent: assertCurrentFinal,
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
                  assertCurrentFinal();
                  commit();
                },
              }),
              fenceDatabasePaths: (paths) =>
                fenceAgentDeletionJournalPaths(authority, journal, {
                  kind: "database",
                  paths: [...new Set(paths.map((pathname) => path.resolve(pathname)))],
                }),
              fenceCleanupPaths: (paths) =>
                fenceAgentDeletionJournalPaths(authority, journal, {
                  kind: "cleanup",
                  paths: structuredClone([...paths]),
                }),
              finish: (finishOptions) =>
                authority.runWithWorker(
                  (scope, guard) =>
                    scope.execute({
                      type: "agentDeletion.finish",
                      input: { guard, ...finishOptions },
                    }),
                  { onCommitted: completeOperation },
                ),
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
                        completeOperation();
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
                  completeOperation();
                  publishRegistryRemoval();
                  return;
                }
                await execute(
                  (scope, identity) =>
                    scope.execute({
                      type: "agentDeletion.rollback",
                      input: {
                        guard: { lease: identity, predicate },
                      },
                    }),
                  { onCommitted: completeOperation },
                );
              },
            };
            return operation;
          });
        } finally {
          closed = true;
          currentJournal.release();
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

type LifecycleFacts = Partial<AgentLifecycleStoreFacts>;
type LifecycleStore = {
  context: OpenClawStateWorkerContext;
  agents: Map<string, LifecycleFacts>;
};

// This projection has complete writer coverage through provenance and journal receipts.
const lifecycleStores = resolveGlobalSingleton(
  Symbol.for("openclaw.agentLifecycleStores"),
  () => {
    const stores = new Map<string, LifecycleStore>();
    agentProvenancePublication.subscribeFacts((change) => {
      for (const store of stores.values()) {
        if (change.kind === "committed") {
          if (change.receipt.source.identity !== store.context.admission.identity.key) {
            continue;
          }
          for (const [agentId, fact] of change.receipt.facts) {
            if (fact.kind !== "unchanged") {
              store.agents.set(agentId, {
                ...store.agents.get(agentId),
                provenance:
                  fact.kind === "postimage"
                    ? fact.value
                    : fact.kind === "absent"
                      ? null
                      : undefined,
              });
            }
          }
        } else if (
          change.kind === "unknown" &&
          change.identity === store.context.admission.identity.key
        ) {
          for (const [agentId, facts] of store.agents) {
            store.agents.set(agentId, { ...facts, provenance: undefined });
          }
        }
      }
    });
    agentDeletionJournalPublication.subscribeFacts((change) => {
      for (const store of stores.values()) {
        if (change.kind === "committed") {
          if (change.receipt.source.identity !== store.context.admission.identity.key) {
            continue;
          }
          for (const [agentId, fact] of change.receipt.facts) {
            if (fact.kind !== "unchanged") {
              store.agents.set(agentId, {
                ...store.agents.get(agentId),
                deletionBlocked:
                  fact.kind === "postimage" ? true : fact.kind === "absent" ? false : undefined,
              });
            }
          }
        } else if (
          change.kind === "unknown" &&
          change.identity === store.context.admission.identity.key
        ) {
          for (const [agentId, facts] of store.agents) {
            store.agents.set(agentId, { ...facts, deletionBlocked: undefined });
          }
        }
      }
    });
    return stores;
  },
  (stores) => stores.clear(),
);

function knownLifecycleFacts(facts: LifecycleFacts | undefined): facts is AgentLifecycleStoreFacts {
  return facts?.deletionBlocked !== undefined && facts.provenance !== undefined;
}

async function readLifecycleFactsInWorker(
  agentId: string,
  options: OpenClawStateDatabaseOptions,
): Promise<AgentLifecycleStoreFacts> {
  const context = captureOpenClawStateReadWorkerContext({
    path: options.database?.path ?? options.path,
    env: options.env,
  });
  let store = lifecycleStores.get(context.admission.databasePath);
  if (!store || store.context.admission.identity.key !== context.admission.identity.key) {
    store = { context, agents: new Map() };
    lifecycleStores.set(context.admission.databasePath, store);
  } else {
    store.context = context;
  }
  const prepared = store.agents.get(agentId);
  if (knownLifecycleFacts(prepared)) {
    return prepared;
  }
  const pending = prepared ?? {};
  store.agents.set(agentId, pending);
  const reply = await executeExistingOpenClawStateRead(
    { path: context.admission.databasePath, env: context.environment },
    { type: "agentLifecycle.read", input: agentId },
    { context, current: true },
  );
  context.admission.assertCurrent();
  if (reply && !reply.ok) {
    throw new Error(reply.message);
  }
  if (reply && reply.type !== "agentLifecycle.read") {
    throw new Error("Unexpected agent lifecycle result");
  }
  const observed = store.agents.get(agentId);
  // A committed receipt supersedes an in-flight read, including an unknown outcome.
  if (observed === pending) {
    const facts = reply?.facts ?? { deletionBlocked: false, provenance: null };
    store.agents.set(agentId, facts);
    return facts;
  }
  return knownLifecycleFacts(observed) ? observed : { deletionBlocked: true, provenance: null };
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
  return Object.freeze({ agentId: id, provenance: structuredClone(facts.provenance) });
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

/** The final effect check consumes prepared owner facts and never queries SQLite. */
export function matchesAgentLifecycleBinding(
  config: OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(binding.agentId);
  if (id !== binding.agentId || !admitsLifecycleBinding(config, id, options)) {
    return false;
  }
  const pathname = path.resolve(
    options.database?.path ??
      options.path ??
      resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const store = lifecycleStores.get(pathname);
  try {
    store?.context.admission.assertCurrent();
  } catch {
    return false;
  }
  const facts = store?.agents.get(id);
  return (
    knownLifecycleFacts(facts) &&
    !facts.deletionBlocked &&
    isDeepStrictEqual(facts.provenance, binding.provenance)
  );
}
