import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  createCliHistoryOwnerProbe,
  runWithCliHistoryWriter,
} from "../../config/sessions/cli-history-boundary.js";
import { persistCompactionBoundaryWithSessionEntryInWorker } from "../../config/sessions/session-accessor.sqlite-compaction.js";
import { ensureSessionEntryInTransaction } from "../../config/sessions/session-accessor.sqlite-initial-entry.js";
import { readTranscriptMutationAtSync } from "../../config/sessions/session-accessor.sqlite-metadata-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { assertCanonicalSessionKeyWrite } from "../../config/sessions/session-canonical-key.js";
import {
  boundSessionEntryMetadataReceipts,
  captureSessionEntryMetadataReceipts,
} from "../../config/sessions/session-entry-metadata-receipt.js";
import type {
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
} from "../../config/sessions/session-manager-write-contract.js";
import { readStagedSessionTranscriptAuthority } from "../../config/sessions/session-transcript-authority.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import {
  parseTranscriptAppendRefusal,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/session-transcript-writer-claim-error.js";
import {
  sqliteSessionIdWriteScope,
  withoutSqliteDatabaseWriteScope,
  withSqliteDatabaseWriteScope,
} from "../../infra/sqlite-database-admission.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import {
  deferSqliteWorkerCommitReceipt,
  requestSqliteWorkerOperationAdmission,
} from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import {
  captureSessionRowChanges,
  type SessionRowChange,
} from "../../sessions/session-row-changes.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import { encodeOpenClawStateWorkerError } from "../../state/openclaw-state-worker-error.js";
import { sessionMetadataAppendNeedsReload } from "./session-manager-append-codec.js";
import {
  applySessionDirectMessageInTransaction,
  applySessionMetadataAppendInTransaction,
  prepareSessionMetadataAppend,
} from "./session-manager-append.kernel.js";
import { executeSessionMaintenance } from "./session-manager-maintenance.worker.js";
import { runWithMetadataMessageAdmission } from "./session-manager-message-admission.worker.js";
import type { SessionManagerAuthorityPublication } from "./session-manager-publication.js";
import { readSessionManagerReload } from "./session-manager-reload.js";

/** Borrow the canonical actor's connection; this domain never opens or closes a database. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  nativeContext: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): Omit<SqliteWorkerBackend<SessionMetadataWorkerOperations>, "close"> & { close(): undefined } {
  let entryChanges: readonly SessionRowChange[] = [];
  // The current command's owner probe. It rides on the single transaction admission, so the
  // host answers before the transaction writes; an unanswered probe never confirms the owner.
  let ownerProbe: ReturnType<typeof createCliHistoryOwnerProbe> | undefined;
  const withOwnerProbe = (
    stage: "transaction" | "commit",
    restriction: AgentDatabaseAdmissionRestriction | undefined,
  ): AgentDatabaseAdmissionRestriction | undefined => {
    const probe = stage === "transaction" ? ownerProbe : undefined;
    if (!probe) {
      return restriction;
    }
    return (request, dispatch) => {
      const attach = (restricted: typeof request) =>
        dispatch({
          ...restricted,
          facts: {
            ...(isRecord(restricted.facts) ? restricted.facts : {}),
            cliHistoryOwnerProbe: probe.fact,
          },
        });
      if (restriction) {
        restriction(request, attach);
      } else {
        attach(request);
      }
    };
  };
  const context = {
    ...nativeContext,
    checkMessage: (facts: unknown) =>
      withoutSqliteDatabaseWriteScope(nativeContext.database, () =>
        requestSqliteWorkerOperationAdmission({ stage: "prepare", facts }),
      ),
    admit(stage: "transaction" | "commit", domainRestriction?: AgentDatabaseAdmissionRestriction) {
      const restriction = withOwnerProbe(stage, domainRestriction);
      const transcriptPublication =
        stage === "commit"
          ? (readStagedSessionTranscriptAuthority({ db: context.database }) ?? [])
          : [];
      const entryPublication =
        stage === "commit" ? captureSessionEntryMetadataReceipts(entryChanges) : [];
      if (!transcriptPublication.length && !entryPublication.length) {
        withoutSqliteDatabaseWriteScope(context.database, () =>
          nativeContext.admit(stage, restriction),
        );
        return;
      }
      const publication: SessionManagerAuthorityPublication = {
        kind: "session-manager-authority",
        transcriptPublication,
        entryPublication,
      };
      boundSessionEntryMetadataReceipts(entryPublication, publication);
      deferSqliteWorkerCommitReceipt(context.database, publication);
      withoutSqliteDatabaseWriteScope(context.database, () =>
        nativeContext.admit(stage, (request, dispatch) => {
          const publish = (restricted: typeof request) =>
            dispatch({ ...restricted, facts: { ...publication, domainFacts: restricted.facts } });
          if (restriction) {
            restriction(request, publish);
          } else {
            publish(request);
          }
        }),
      );
    },
  };
  let closed = false;
  const assertOpen = () => {
    if (closed || !context.database.isOpen) {
      throw new Error("Session metadata domain is closed");
    }
    assertTransactionUsable(context.database);
  };
  const execute = (
    command: SqliteWorkerCommand<SessionMetadataOperations>,
  ): SessionMetadataWorkerOperations[keyof SessionMetadataWorkerOperations]["output"] => {
    assertOpen();
    // Database execution already carries the captured host environment. Command payloads
    // must not transport process.env or its non-cloneable Windows semantics proxy.
    const scope = { ...command.input.scope, env: getSqliteWorkerStateContext().environment };
    const resolved = resolveSqliteTranscriptScope(scope);
    const options = toDatabaseOptions(resolved);
    if (
      readDatabasePathIdentitySync(resolveOpenClawAgentSqlitePath(options)).canonicalPath !==
      context.databasePath
    ) {
      throw new Error("Session metadata target changed its database owner");
    }
    scope.storePath = context.databasePath;
    resolved.path = context.databasePath;
    options.path = context.databasePath;
    if (command.type === "session.metadata.mutation") {
      return { ok: true, value: readTranscriptMutationAtSync(scope) };
    }
    assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
    if (command.type === "session.transcript.compactionBoundary") {
      return {
        ok: true,
        value: persistCompactionBoundaryWithSessionEntryInWorker(
          scope,
          {
            ...command.input,
            prepared: {
              ...command.input.prepared,
              scope: { ...command.input.prepared.scope, env: scope.env },
            },
          },
          context,
        ),
      };
    }
    if (command.type === "session.transcript.branch") {
      return { ok: true, value: executeSessionMaintenance(command, scope, context) };
    }
    if (command.type === "session.transcript.replaceSuffix") {
      return { ok: true, value: executeSessionMaintenance(command, scope, context) };
    }
    if (command.type === "session.transcript.rewrite") {
      const result = runWithMetadataMessageAdmission(context, command.input, (admit) =>
        executeSessionMaintenance(command, scope, { ...context, admit }),
      );
      return {
        ok: true,
        value: { ...result.value, pendingInputReceipt: result.pendingInputReceipt },
      };
    }
    if (command.type === "session.transcript.appendMessage") {
      const result = runWithMetadataMessageAdmission(context, command.input, (admit) =>
        runOpenClawAgentWriteTransaction<
          SessionMetadataWorkerOperations["session.transcript.appendMessage"]["output"]
        >(
          (database) => {
            if (database.db !== context.database) {
              throw new Error("Session message lost its borrowed canonical connection");
            }
            admit("transaction");
            const value = applySessionDirectMessageInTransaction(database, {
              ...command.input,
              scope,
            });
            admit("commit");
            return { ok: true, value };
          },
          options,
          { operationLabel: command.type },
        ),
      );
      if (result.value.ok) {
        result.value.value.pendingInputReceipt = result.pendingInputReceipt;
      }
      return result.value;
    }
    const prepared =
      command.type === "session.metadata.append"
        ? prepareSessionMetadataAppend(context.database, command.input)
        : undefined;
    const event = prepared?.event;
    const messageControl =
      command.type === "session.metadata.append" ? command.input.message : undefined;
    const result = runWithMetadataMessageAdmission(
      context,
      messageControl,
      (admit, beforeFreshMessageCommit) =>
        runOpenClawAgentWriteTransaction<
          SessionMetadataWorkerOperations[
            | "session.metadata.initialize"
            | "session.metadata.append"]["output"]
        >(
          (database) => {
            if (database.db !== context.database) {
              throw new Error("Session metadata lost its borrowed canonical connection");
            }
            admit("transaction");
            if (command.type === "session.metadata.initialize") {
              const initialized = ensureSessionEntryInTransaction(
                database,
                resolved,
                scope,
                command.input.entry,
                command.input.initialWriterRunId,
              );
              admit("commit");
              return { ok: true, value: initialized };
            }
            const value = applySessionMetadataAppendInTransaction(
              database,
              { ...command.input, scope },
              beforeFreshMessageCommit,
              prepared,
            );
            admit("commit");
            return { ok: true, value };
          },
          options,
          {
            operationLabel: command.type,
            diagnosticContext: {
              sessionId: scope.sessionId,
              eventType: event?.type,
              messageRole: event?.type === "message" ? event.message.role : undefined,
            },
          },
        ),
    );
    const outcome = result.value;
    if (result.pendingInputReceipt && outcome.ok && "snapshot" in outcome.value) {
      outcome.value.pendingInputReceipt = result.pendingInputReceipt;
    }
    if (
      command.type === "session.metadata.append" &&
      command.input.view &&
      outcome.ok &&
      "snapshot" in outcome.value &&
      sessionMetadataAppendNeedsReload(command.input, outcome.value)
    ) {
      const { view } = command.input;
      try {
        outcome.value.reload = {
          ok: true,
          value: runWithSessionTranscriptReadFence(view.admission, () =>
            readSessionManagerReload(scope, view.limits, view.admission !== undefined),
          ),
        };
        // Detect view serialization failure while the small committed receipt is still retained.
        serialize(outcome);
      } catch (error) {
        // This transaction already committed. Preserve its receipt across read failure.
        outcome.value.reload = {
          ok: false,
          error: encodeOpenClawStateWorkerError(error, { includeOrdinary: true }),
        };
      }
    }
    return outcome;
  };
  return {
    execute(command) {
      try {
        const cliWriter =
          command.type === "session.transcript.appendMessage" ||
          command.type === "session.metadata.append"
            ? command.input.cliWriter
            : undefined;
        // Coverage takes the host's live owner check from this command's transaction admission.
        ownerProbe = cliWriter?.confirmOwner ? createCliHistoryOwnerProbe() : undefined;
        const probe = ownerProbe;
        return runWithCliHistoryWriter(
          cliWriter
            ? {
                ...cliWriter,
                ...(probe ? { confirmsOwner: probe.holds } : {}),
                target: { ...command.input.scope, storePath: context.databasePath },
                // Host liveness is composed into both transaction and commit grants.
                assertCurrent: assertOpen,
                assertReadable: assertOpen,
              }
            : undefined,
          () =>
            captureSessionRowChanges(context.database, (changes) => {
              entryChanges = changes;
              try {
                return withSqliteDatabaseWriteScope(
                  context.database,
                  [
                    command.input.scope.sessionKey,
                    sqliteSessionIdWriteScope(command.input.scope.sessionId),
                  ],
                  () => execute(command),
                );
              } finally {
                entryChanges = [];
              }
            }).result,
        );
      } catch (error) {
        if (error instanceof SessionTranscriptWriterClaimReboundError) {
          const refusal = parseTranscriptAppendRefusal(error.cause);
          if (error.cause !== undefined && !refusal) {
            throw new Error("Session metadata refusal has an invalid identity", { cause: error });
          }
          return { ok: false, refusal };
        }
        throw error;
      } finally {
        ownerProbe = undefined;
      }
    },
    assertSettled() {
      assertOpen();
      if (context.database.isTransaction) {
        throw new Error("Session metadata command left a transaction open");
      }
    },
    close(): undefined {
      closed = true;
    },
  };
}
