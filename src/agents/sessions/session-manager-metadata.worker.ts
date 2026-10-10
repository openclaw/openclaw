import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runWithCliHistoryWriter } from "../../config/sessions/cli-history-boundary.js";
import { persistCompactionBoundaryWithSessionEntryInWorker } from "../../config/sessions/session-accessor.sqlite-compaction.js";
import { ensureSessionEntryInTransaction } from "../../config/sessions/session-accessor.sqlite-initial-entry.js";
import { readTranscriptMutationAtSync } from "../../config/sessions/session-accessor.sqlite-metadata-read.js";
import {
  runWithSessionPendingInputWorkerCustody,
  type SessionPendingInputWorkerReceipt,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import { validatePreparedAssistantAppendSync } from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { PreparedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import { assertCanonicalSessionKeyWrite } from "../../config/sessions/session-canonical-key.js";
import {
  findSessionTranscriptHeader,
  isIndexedSessionEntry,
  isReadableSessionMessage,
  parseOpaqueLeafEntry,
} from "../../config/sessions/session-entry-codec.js";
import { captureSessionEntryMetadataReceipts } from "../../config/sessions/session-entry-metadata-receipt.js";
import type {
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
  SessionMetadataMessageControl,
} from "../../config/sessions/session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { readSessionPendingInputAuthorityFacts } from "../../config/sessions/session-pending-input-authority.kernel.js";
import { readStagedSessionTranscriptAuthority } from "../../config/sessions/session-transcript-authority.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import {
  parseTranscriptAppendRefusal,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/session-transcript-writer-claim-error.js";
import { prepareTranscriptPayloadForReuse } from "../../config/sessions/transcript-payload.js";
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
import { executeSessionMaintenance } from "./session-manager-maintenance.worker.js";
import type { SessionManagerAuthorityPublication } from "./session-manager-publication.js";
import { readSessionManagerReload } from "./session-manager-reload.js";
import type {
  SessionEntry,
  SessionHeader,
  SessionLeafControl,
  SessionMessageEntry,
} from "./session-manager-types.js";

type MetadataWorkerAdmission = (
  stage: "transaction" | "commit",
  restriction?: AgentDatabaseAdmissionRestriction,
) => void;

function runWithMetadataMessageAdmission<T>(
  context: { admit: MetadataWorkerAdmission; database: DatabaseSync; databasePath: string },
  controls: SessionMetadataMessageControl | undefined,
  run: (admit: MetadataWorkerAdmission, beforeFreshMessageCommit: () => void) => T,
): { value: T; pendingInputReceipt?: SessionPendingInputWorkerReceipt } {
  let transactionFacts: unknown;
  let pendingAuthorityChecked = false;
  const readAuthority = () => {
    const source = controls?.pendingInput?.facts;
    // Foreign custody keeps its original host owner's live assertion.
    if (source?.preparedAuthority && source.databasePath !== context.databasePath) {
      return null;
    }
    return source?.preparedAuthority && source.agentId && source.databaseAgentId
      ? readSessionPendingInputAuthorityFacts(
          { db: context.database, path: context.databasePath, agentId: source.databaseAgentId },
          source.sessionKey,
          source.agentId,
        )
      : undefined;
  };
  const requestMessageCheck = (check: "pending" | "fresh") => {
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: {
        kind: "session-message",
        domainFacts: transactionFacts,
        check,
        authority: check === "pending" ? readAuthority() : undefined,
      },
    });
    if (check === "pending") {
      pendingAuthorityChecked = true;
    }
  };
  const admit: MetadataWorkerAdmission = (stage) =>
    context.admit(stage, (request, dispatch) => {
      transactionFacts = request.facts;
      dispatch({
        ...request,
        facts: {
          kind: "session-message",
          domainFacts: request.facts,
          ...(stage === "commit" && pendingAuthorityChecked ? { check: "pending" } : {}),
          ...(stage === "commit" && pendingAuthorityChecked ? { authority: readAuthority() } : {}),
        },
      });
    });
  const write = () => run(admit, () => requestMessageCheck("fresh"));
  const pending = controls?.pendingInput;
  if (!pending) {
    return { value: write() };
  }
  const result = runWithSessionPendingInputWorkerCustody(
    pending.facts,
    pending.relocation,
    () => requestMessageCheck("pending"),
    write,
  );
  return { value: result.value, pendingInputReceipt: result.receipt };
}

function decodeMetadataAppendEvent(
  input: SessionMetadataOperations["session.metadata.append"]["input"],
): SessionHeader | SessionEntry | SessionLeafControl {
  const event: unknown =
    typeof input.event === "string"
      ? JSON.parse(input.event)
      : { ...input.event, message: JSON.parse(input.message?.messageJson ?? "null") };
  if (isIndexedSessionEntry(event)) {
    if ((event.type === "message") !== (typeof input.event !== "string")) {
      throw new Error("Session message append requires prepared storage bytes");
    }
    return event;
  }
  const header = findSessionTranscriptHeader([event]);
  if (header) {
    return header;
  }
  const leaf = parseOpaqueLeafEntry(event);
  if (leaf && isRecord(event) && typeof event.timestamp === "string") {
    return { ...leaf, type: "leaf", timestamp: event.timestamp };
  }
  throw new Error("Invalid serialized session transcript entry");
}

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
  const context = {
    ...nativeContext,
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction) {
      const transcriptPublication =
        stage === "commit"
          ? (readStagedSessionTranscriptAuthority({ db: context.database }) ?? [])
          : [];
      const entryPublication =
        stage === "commit" ? captureSessionEntryMetadataReceipts(entryChanges) : [];
      if (!transcriptPublication.length && !entryPublication.length) {
        nativeContext.admit(stage, restriction);
        return;
      }
      const publication: SessionManagerAuthorityPublication = {
        kind: "session-manager-authority",
        transcriptPublication,
        entryPublication,
      };
      deferSqliteWorkerCommitReceipt(context.database, publication);
      nativeContext.admit(stage, (request, dispatch) => {
        const publish = (restricted: typeof request) =>
          dispatch({ ...restricted, facts: { ...publication, domainFacts: restricted.facts } });
        if (restriction) {
          restriction(request, publish);
        } else {
          publish(request);
        }
      });
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
      const message: unknown = JSON.parse(command.input.messageJson);
      if (!isReadableSessionMessage(message)) {
        throw new Error("Invalid serialized session transcript message");
      }
      const prepared = { messageJson: command.input.messageJson, persistedMessage: message };
      const result = runWithMetadataMessageAdmission(context, command.input, (admit) =>
        runOpenClawAgentWriteTransaction<
          SessionMetadataWorkerOperations["session.transcript.appendMessage"]["output"]
        >(
          (database) => {
            if (database.db !== context.database) {
              throw new Error("Session message lost its borrowed canonical connection");
            }
            admit("transaction");
            let projectionNeedsReconcile = false;
            const snapshot = appendTranscriptMessageSnapshotSync(
              scope,
              { message, cwd: command.input.cwd },
              prepared,
              {
                messageAlreadyRedacted: true,
                scheduleProjectionReconcile: false,
                onProjectionReconcileNeeded: () => {
                  projectionNeedsReconcile = true;
                },
              },
              undefined,
              database,
            );
            admit("commit");
            return { ok: true, value: { snapshot, projectionNeedsReconcile } };
          },
          options,
          { operationLabel: command.type },
        ),
      );
      if (result.value.ok) {
        result.value.value.pendingInputReceipt = result.pendingInputReceipt;
        const { snapshot } = result.value.value;
        if (snapshot.ok && snapshot.value.result?.message === message) {
          snapshot.value.result.message = undefined;
        }
      }
      return result.value;
    }
    const event =
      command.type === "session.metadata.append"
        ? decodeMetadataAppendEvent(command.input)
        : undefined;
    let prepared: PreparedTranscriptMessageAppend<SessionMessageEntry["message"]> | undefined;
    if (command.type === "session.metadata.append" && event?.type === "message") {
      const { message } = command.input;
      if (!message) {
        throw new Error("Session message append requires prepared storage bytes");
      }
      const { message: _message, ...envelope } = event;
      const eventJson = `${JSON.stringify(envelope).slice(0, -1)},"message":${message.messageJson}}`;
      prepared = {
        messageJson: message.messageJson,
        persistedMessage: event.message,
        physicalPayload: prepareTranscriptPayloadForReuse(context.database, eventJson, event),
      };
      if (message.validateTurn) {
        const mutationAt = validatePreparedAssistantAppendSync(
          scope,
          event.parentId,
          command.input.view?.admission?.entryId,
        );
        if (mutationAt === undefined) {
          throw new SqliteTranscriptMutationConflictError(scope.sessionId);
        }
        command.input.options.expectedMutationAt = mutationAt;
      }
    }
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
            let projectionNeedsReconcile = false;
            const projection = {
              scheduleProjectionReconcile: false,
              onProjectionReconcileNeeded: () => {
                projectionNeedsReconcile = true;
              },
            } as const;
            if (!event) {
              throw new Error("Session metadata append requires a serialized event");
            }
            const { message } = command.input;
            const snapshot =
              event.type === "message" && message
                ? appendTranscriptMessageSnapshotSync(
                    scope,
                    {
                      ...command.input.options,
                      message: event.message,
                      eventId: event.id,
                      parentId: event.parentId,
                      now: Date.parse(event.timestamp),
                      cwd: message.cwd,
                      idempotencyLookup: message.idempotencyLookup,
                      ...(message.freshMessageCheck ? { beforeFreshMessageCommit } : {}),
                    },
                    prepared,
                    projection,
                    undefined,
                    database,
                  )
                : appendTranscriptEventSnapshotSync(
                    scope,
                    event,
                    command.input.options,
                    {
                      ...projection,
                      eventJson:
                        typeof command.input.event === "string" ? command.input.event : undefined,
                    },
                    undefined,
                    database,
                  );
            admit("commit");
            return { ok: true, value: { snapshot, projectionNeedsReconcile } };
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
    if (outcome.ok && "snapshot" in outcome.value && outcome.value.snapshot.ok) {
      const receipt = outcome.value.snapshot.value.result;
      if (receipt && "message" in receipt && receipt.message === prepared?.persistedMessage) {
        // Fresh commits reuse host custody; pending-input and replay receipts retain their own payload.
        receipt.message = undefined;
      }
    }
    if (result.pendingInputReceipt && outcome.ok && "snapshot" in outcome.value) {
      outcome.value.pendingInputReceipt = result.pendingInputReceipt;
    }
    if (
      command.type === "session.metadata.append" &&
      event &&
      event.type !== "session" &&
      command.input.view &&
      outcome.ok &&
      "snapshot" in outcome.value &&
      outcome.value.snapshot.ok
    ) {
      const { view } = command.input;
      const committed = outcome.value.snapshot.value;
      if (!committed.result) {
        return outcome;
      }
      const adoptedMessage =
        "messageId" in committed.result && committed.result.messageId !== event.id;
      if (!committed.result.appended && !adoptedMessage) {
        return outcome;
      }
      const version = view.loadedVersion;
      const effectiveParentId =
        "effectiveParentId" in committed.result ? committed.result.effectiveParentId : undefined;
      if (
        adoptedMessage ||
        (version &&
          (committed.before.generation !== version.generation ||
            committed.before.rawSeq !== version.rawSeq)) ||
        (effectiveParentId !== undefined && effectiveParentId !== event.parentId)
      ) {
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
        return runWithCliHistoryWriter(
          cliWriter
            ? {
                ...cliWriter,
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
                return execute(command);
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
