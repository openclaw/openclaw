import crypto from "node:crypto";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { captureActiveCronJobAgentDeletion } from "../cron/active-jobs.js";
import { stageSqliteTransactionState } from "../infra/sqlite-post-commit.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { readAgentDatabaseAdmissionRefusal } from "../state/agent-database-admission.js";
import { createAgentDeletionDatabaseCleanup } from "../state/agent-deletion-cleanup.js";
import {
  beginAgentDeletionJournal,
  claimCompletedAgentDeletionJournal,
  completeAgentDeletionJournalInDatabase,
  handoffAgentDeletionJournalInDatabase,
  readAgentDeletionJournal,
  readAgentDeletionJournalInDatabase,
  removeAgentDeletionJournal,
  updateAgentDeletionJournalDatabasePaths,
  updateAgentDeletionJournalCleanupPaths,
  type AgentDeletionJournalCleanupPath,
  type AgentDeletionJournalEntry,
} from "../state/agent-deletion-journal.js";
import { readAgentDeletionJournalAuthorityInWorker } from "../state/agent-deletion-journal.read.js";
import { readAgentProvenance, type AgentProvenance } from "../state/agent-provenance.js";
import { assertNoOpenClawAgentDatabaseLeases } from "../state/openclaw-agent-db-lease.js";
import { requireOpenClawStateDatabaseIdentity } from "../state/openclaw-state-db-cache.js";
import type {
  OpenClawStateDatabase,
  OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db-contract.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { withOpenClawStateLease } from "../state/openclaw-state-lease.js";
import { captureOpenClawStateReadWorkerContext } from "../state/openclaw-state-worker-context.js";
import { isReservedSystemAgentId } from "../system-agent/agent-id.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

export class AgentDeletionAuthorityRollbackError extends AggregateError {}

export class AgentDeletionCommitUncertainError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
  }
}

export type AgentLifecycleBinding = Readonly<{
  agentId: string;
  provenance: AgentProvenance | null;
}>;

type AgentDeletionInput = Omit<
  AgentDeletionJournalEntry,
  | "createdAt"
  | "operationId"
  | "cleanupCompleted"
  | "databasePaths"
  | "cleanupPaths"
  | "deleteFiles"
> & {
  databasePaths?: string[];
  cleanupPaths?: AgentDeletionJournalCleanupPath[];
  deleteFiles?: boolean;
};

export type AgentDeletionOperation = {
  entry: AgentDeletionJournalEntry;
  assertCurrent: (database?: OpenClawStateDatabase) => void;
  assertCurrentAsync: () => Promise<void>;
  runDatabaseCleanup: ReturnType<typeof createAgentDeletionDatabaseCleanup>;
  fenceDatabasePaths: (paths: readonly string[]) => void;
  fenceCleanupPaths: (paths: readonly AgentDeletionJournalCleanupPath[]) => void;
  finish: () => void;
  completeInTransaction: (database: OpenClawStateDatabase) => void;
  handoffToRetry: (database: OpenClawStateDatabase) => void;
  rollback: () => void;
};

const log = createSubsystemLogger("agents/lifecycle");

/** Acquire before the config lock and retain ownership through cleanup and recovery. */
export function withAgentDeletion<T>(
  agentId: string,
  run: (begin: (entry: AgentDeletionInput) => AgentDeletionOperation) => Promise<T>,
  options: OpenClawStateDatabaseOptions = {},
): Promise<T> {
  const id = normalizeAgentId(agentId);
  if (isReservedSystemAgentId(id)) {
    throw new Error(
      `System agent ${id} cannot be deleted; run openclaw doctor --fix to quarantine invalid deletion history.`,
    );
  }
  const statePath = path.resolve(
    options.path ?? resolveOpenClawStateSqlitePath(options.env ?? process.env),
  );
  const stateOptions = { ...options, path: statePath, env: { ...(options.env ?? process.env) } };
  return withOpenClawStateLease(
    {
      scope: "core:agent-deletion",
      key: id,
      database: { scope: "shared", options: stateOptions },
      leaseMs: 60_000,
      waitMs: 5_000,
      // SQLite cleanup can block the event loop beyond the lease duration.
      heartbeat: "worker",
      leaseLabel: "agent deletion",
      operationLabel: "agent.deletion.lease",
    },
    async (lease) => {
      let begun = false;
      let closed = false;
      try {
        return await run((entry) => {
          if (closed || begun || normalizeAgentId(entry.agentId) !== id) {
            throw new Error(`Agent ${id} deletion already began or has a different target.`);
          }
          begun = true;
          const operationId = crypto.randomUUID();
          const journal = runOpenClawStateWriteTransaction((database) => {
            lease.assertOwnedInTransaction(database.db);
            const cancelCronRuns = captureActiveCronJobAgentDeletion(
              id,
              requireOpenClawStateDatabaseIdentity(database).key,
            );
            const entryJournal = beginAgentDeletionJournal(
              { ...entry, agentId: id, operationId, deleteFiles: entry.deleteFiles !== false },
              stateOptions,
            );
            // Revoke before cleanup preparation can yield, but never for a rolled-back journal.
            if (
              !stageSqliteTransactionState(database.db, {
                stage() {},
                rollback() {},
                commit: cancelCronRuns,
              })
            ) {
              throw new Error("Agent deletion requires a managed transaction");
            }
            return entryJournal;
          }, stateOptions);
          const readContext = captureOpenClawStateReadWorkerContext(stateOptions);
          const assertJournalIdentity = (
            currentStatePath: string,
            entries: readonly Pick<
              AgentDeletionJournalEntry,
              "agentId" | "operationId" | "cleanupCompleted"
            >[],
          ) => {
            if (
              closed ||
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
          };
          const assertJournal = (
            currentStatePath: string,
            entries: Parameters<typeof assertJournalIdentity>[1],
            database?: OpenClawStateDatabase,
          ) => {
            assertJournalIdentity(currentStatePath, entries);
            if (database) {
              lease.assertOwnedInTransaction(database.db);
            } else {
              lease.assertOwned();
            }
            return id;
          };
          const assertCurrent = (database?: OpenClawStateDatabase) => {
            const current = closed
              ? undefined
              : database
                ? readAgentDeletionJournalInDatabase(database, id)
                : readAgentDeletionJournal(id, stateOptions);
            assertJournal(database?.path ?? statePath, current ? [current] : [], database);
          };
          const assertAsyncScopeCurrent = () => {
            if (closed) {
              throw new Error(`Agent ${id} deletion no longer owns database cleanup.`);
            }
            lease.signal.throwIfAborted();
            readContext.maintenanceScope?.assertAdmission();
            readContext.admission.assertCurrent();
          };
          const assertCurrentAsync = async () => {
            assertAsyncScopeCurrent();
            const verifyLease = lease.assertOwnedAsync;
            if (!verifyLease) {
              throw new Error(
                "Agent deletion requires asynchronous worker-heartbeat verification.",
              );
            }
            const current = await readAgentDeletionJournalAuthorityInWorker(
              id,
              readContext,
              lease.signal,
            );
            assertAsyncScopeCurrent();
            assertJournalIdentity(readContext.admission.databasePath, current ? [current] : []);
            await verifyLease();
            assertAsyncScopeCurrent();
          };
          const mutateJournal = <Result>(mutate: () => Result): Result =>
            runOpenClawStateWriteTransaction((database) => {
              assertCurrent(database);
              return mutate();
            }, stateOptions);
          const completeInTransaction = (database: OpenClawStateDatabase) => {
            assertCurrent(database);
            if (!completeAgentDeletionJournalInDatabase(database, id, operationId)) {
              throw new Error(`Failed to complete deletion journal for agent ${id}.`);
            }
            closed = true;
          };
          return {
            entry: journal,
            assertCurrent,
            assertCurrentAsync,
            handoffToRetry: (database) => {
              assertCurrent(database);
              if (
                !handoffAgentDeletionJournalInDatabase(
                  database,
                  id,
                  operationId,
                  crypto.randomUUID(),
                )
              ) {
                throw new Error(`Failed to hand off deletion journal for agent ${id}.`);
              }
              // Journal replacement revokes this attempt; rollback must leave its local authority usable.
            },
            runDatabaseCleanup: createAgentDeletionDatabaseCleanup({
              statePath,
              assertAdmission: () => assertNoOpenClawAgentDatabaseLeases(id, stateOptions),
              assertCurrent,
              assertJournal,
              withCommit: (commit) => {
                let committed = false;
                try {
                  // Agent writers already acquire agent -> shared. Hold that order through
                  // COMMIT so an expired deletion cannot race a replacement owner.
                  mutateJournal(() => {
                    commit();
                    committed = true;
                  });
                } catch (error) {
                  if (!committed) {
                    throw error;
                  }
                  // Guard release cannot roll back durable agent rows or restore native bindings.
                  try {
                    log.warn("Agent deletion committed, but releasing its state guard failed", {
                      agentId: id,
                      error,
                    });
                  } catch {
                    // Diagnostics are also postcommit and cannot change the durable outcome.
                  }
                }
              },
            }),
            fenceDatabasePaths: (paths) =>
              mutateJournal(() => {
                if (
                  !updateAgentDeletionJournalDatabasePaths(id, operationId, paths, stateOptions)
                ) {
                  throw new Error(`Failed to fence database cleanup paths for agent ${id}.`);
                }
                journal.databasePaths = [
                  ...new Set(paths.map((entryPath) => path.resolve(entryPath))),
                ];
              }),
            fenceCleanupPaths: (paths) =>
              mutateJournal(() => {
                if (!updateAgentDeletionJournalCleanupPaths(id, operationId, paths, stateOptions)) {
                  throw new Error(`Failed to fence cleanup paths for agent ${id}.`);
                }
                journal.cleanupPaths = [...paths];
              }),
            completeInTransaction,
            finish: () => runOpenClawStateWriteTransaction(completeInTransaction, stateOptions),
            rollback: () =>
              mutateJournal(() => {
                if (!removeAgentDeletionJournal(id, operationId, stateOptions)) {
                  throw new Error(`Failed to roll back deletion journal for agent ${id}.`);
                }
                closed = true;
              }),
          };
        });
      } finally {
        closed = true;
      }
    },
  );
}

/** Atomically claim a completed deletion tombstone for a newly created identity. */
export function claimCompletedAgentDeletion(
  agentId: string,
  operationId: string,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  return claimCompletedAgentDeletionJournal(normalizeAgentId(agentId), operationId, options);
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
  deletion?: AgentDeletionOperation,
): void {
  const id = normalizeAgentId(agentId);
  const journal = readAgentDeletionJournalInDatabase(database, id);
  if (deletion) {
    if (
      deletion.entry.agentId !== id ||
      !journal ||
      journal.operationId !== deletion.entry.operationId ||
      journal.cleanupCompleted
    ) {
      throw new Error(`Agent ${id} mutation does not belong to the current deletion.`);
    }
    deletion.assertCurrent(database);
    return;
  }
  if (journal && !journal.cleanupCompleted) {
    throw new Error(`Agent ${id} has pending deletion; retry after removal completes.`);
  }
}

/** Captures the exact durable incarnation of an existing, deletion-safe agent. */
export function captureAgentLifecycleBinding(
  config: OpenClawConfig,
  agentId: string,
  options: OpenClawStateDatabaseOptions = {},
): AgentLifecycleBinding | undefined {
  const id = normalizeAgentId(agentId);
  if (
    !resolveAgentConfig(config, id) ||
    readAgentDatabaseAdmissionRefusal(id, options) ||
    isAgentDeletionBlocked(id, options)
  ) {
    return undefined;
  }
  return Object.freeze({
    agentId: id,
    provenance: readAgentProvenance(id, options) ?? null,
  });
}

/** Revalidates an agent binding against both the roster and lifecycle owner. */
export function matchesAgentLifecycleBinding(
  config: OpenClawConfig,
  binding: AgentLifecycleBinding,
  options: OpenClawStateDatabaseOptions = {},
): boolean {
  const id = normalizeAgentId(binding.agentId);
  return (
    id === binding.agentId &&
    Boolean(resolveAgentConfig(config, id)) &&
    !readAgentDatabaseAdmissionRefusal(id, options) &&
    !isAgentDeletionBlocked(id, options) &&
    isDeepStrictEqual(readAgentProvenance(id, options) ?? null, binding.provenance)
  );
}
