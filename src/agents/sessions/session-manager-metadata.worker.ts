import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import {
  persistCompactionBoundaryWithSessionEntryInWorker,
  type CompactionBoundaryOperations,
} from "../../config/sessions/session-accessor.sqlite-compaction.js";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptAppendRefusal,
  TranscriptMessageAppendResult,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  ensureSessionEntryInTransaction,
  type InitialSessionEntryCommit,
} from "../../config/sessions/session-accessor.sqlite-initial-entry.js";
import { readTranscriptMutationAtSync } from "../../config/sessions/session-accessor.sqlite-metadata-read.js";
import {
  runWithSessionPendingInputWorkerCustody,
  type SessionPendingInputWorkerFacts,
  type SessionPendingInputWorkerReceipt,
} from "../../config/sessions/session-accessor.sqlite-pending-inputs.js";
import {
  inspectTranscriptEventsSync,
  loadTranscriptReadSnapshotSync,
  validatePreparedAssistantAppendSync,
} from "../../config/sessions/session-accessor.sqlite-read.js";
import {
  resolveSqliteTranscriptScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import type { PreparedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
  type TranscriptEventAppendResult,
  type TranscriptWriteSnapshot,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.js";
import type { SessionTranscriptRuntimeTarget } from "../../config/sessions/session-accessor.types.js";
import { assertCanonicalSessionKeyWrite } from "../../config/sessions/session-canonical-key.js";
import {
  findSessionTranscriptHeader,
  isIndexedSessionEntry,
  isReadableSessionMessage,
  parseOpaqueLeafEntry,
} from "../../config/sessions/session-entry-codec.js";
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { prepareTranscriptPayloadForReuse } from "../../config/sessions/transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import { readDatabasePathIdentitySync } from "../../infra/sqlite-worker-identity.js";
import { requestSqliteWorkerOperationAdmission } from "../../infra/sqlite-worker-operation-admission.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { Message } from "../../llm/types.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import {
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import type { AgentDatabaseAdmissionRestriction } from "../../state/openclaw-agent-execution-domain.js";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import {
  executeSessionMaintenance,
  type SessionMaintenanceOperations,
} from "./session-manager-maintenance.worker.js";
import type {
  SessionEntry,
  SessionHeader,
  SessionLeafControl,
  SessionMessageEntry,
} from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

type MetadataTarget = Omit<SessionTranscriptWriteScope, "env"> & SessionTranscriptRuntimeTarget;

export type SessionMetadataMessageControl = {
  pendingInput?: { facts: SessionPendingInputWorkerFacts; relocation?: string };
  freshMessageCheck?: true;
};

type MetadataWorkerAdmission = (
  stage: "transaction" | "commit",
  restriction?: AgentDatabaseAdmissionRestriction,
) => void;

function runWithMetadataMessageAdmission<T>(
  context: { admit: MetadataWorkerAdmission },
  controls: SessionMetadataMessageControl | undefined,
  run: (admit: MetadataWorkerAdmission, beforeFreshMessageCommit: () => void) => T,
): { value: T; pendingInputReceipt?: SessionPendingInputWorkerReceipt } {
  let transactionFacts: unknown;
  let pendingAuthorityChecked = false;
  const requestMessageCheck = (check: "pending" | "fresh") => {
    requestSqliteWorkerOperationAdmission({
      stage: "prepare",
      facts: { kind: "session-message", domainFacts: transactionFacts, check },
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

export type SessionMetadataOperations = SessionMaintenanceOperations &
  CompactionBoundaryOperations & {
    "session.transcript.appendMessage": {
      input: {
        scope: MetadataTarget;
        messageJson: string;
        cwd: string;
      } & SessionMetadataMessageControl;
      output: {
        snapshot: ReturnType<
          typeof appendTranscriptMessageSnapshotSync<
            Message | CustomMessage | BashExecutionMessage | undefined
          >
        >;
        projectionNeedsReconcile: boolean;
        pendingInputReceipt?: SessionPendingInputWorkerReceipt;
      };
    };
    "session.metadata.initialize": {
      input: {
        scope: MetadataTarget;
        entry: InternalSessionEntry;
        initialWriterRunId?: string;
      };
      output: InitialSessionEntryCommit;
    };
    "session.metadata.append": {
      input: {
        scope: MetadataTarget;
        event: Omit<SessionMessageEntry, "message"> | string;
        message?: {
          messageJson: string;
          cwd: string;
          validateTurn: boolean;
          idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
        } & SessionMetadataMessageControl;
        options: Pick<
          NonNullable<Parameters<typeof appendTranscriptEventSnapshotSync>[2]>,
          "appendIntent" | "expectedMutationAt"
        >;
        view?: {
          loadedVersion?: SessionTranscriptContextVersion;
          limits?: SessionManagerBoundedContextLimits;
          admission?: UserTurnTranscriptAdmissionReceipt;
        };
      };
      output: {
        snapshot: Result<
          TranscriptWriteSnapshot<
            | TranscriptEventAppendResult
            | TranscriptMessageAppendResult<SessionMessageEntry["message"] | undefined>
            | undefined
          >,
          TranscriptAppendRefusal
        >;
        projectionNeedsReconcile: boolean;
        pendingInputReceipt?: SessionPendingInputWorkerReceipt;
        reload?: Result<
          PreparedSessionTranscriptReload,
          OpenClawStateWorkerErrorPayload | undefined
        >;
      };
    };
    "session.metadata.mutation": {
      input: { scope: MetadataTarget };
      output: number | null;
    };
  };

export type SessionMetadataWorkerOperations = {
  [Key in keyof SessionMetadataOperations]: {
    input: SessionMetadataOperations[Key]["input"];
    output:
      | { ok: true; value: SessionMetadataOperations[Key]["output"] }
      | { ok: false; refusal?: TranscriptAppendRefusal };
  };
};

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

function copyTranscriptRefusal(value: unknown): TranscriptAppendRefusal | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !isRecord(value) ||
    typeof value.agentIdHash !== "string" ||
    typeof value.expectedSessionIdHash !== "string" ||
    typeof value.sessionKeyHash !== "string"
  ) {
    throw new Error("Session metadata refusal has an invalid identity");
  }
  const identity = {
    agentIdHash: value.agentIdHash,
    expectedSessionIdHash: value.expectedSessionIdHash,
    sessionKeyHash: value.sessionKeyHash,
  };
  if (value.code === "session-entry-missing") {
    return { ...identity, code: value.code };
  }
  if (value.code === "session-rebound" && typeof value.actualSessionIdHash === "string") {
    return { ...identity, code: value.code, actualSessionIdHash: value.actualSessionIdHash };
  }
  throw new Error("Session metadata refusal has an invalid kind");
}

function readCommittedMetadataView(
  scope: MetadataTarget,
  limits: SessionManagerBoundedContextLimits | undefined,
  admission: UserTurnTranscriptAdmissionReceipt | undefined,
): PreparedSessionTranscriptReload {
  return runWithSessionTranscriptReadFence(admission, (): PreparedSessionTranscriptReload => {
    if (limits) {
      return {
        kind: "bounded",
        snapshot: readSessionTranscriptBoundedActiveContextCore(scope, {
          ...limits,
          ...(admission !== undefined ? { ignoreReadFence: true } : {}),
        }),
      };
    }
    if (admission !== undefined) {
      const inspected = inspectTranscriptEventsSync(scope);
      return {
        kind: "full",
        snapshot: {
          events: inspected.events,
          version: {
            generation: inspected.snapshot.generation,
            rawSeq: inspected.snapshot.lastSeq,
            updatedAt: inspected.snapshot.transcriptUpdatedAt,
          },
        },
      };
    }
    return { kind: "full", snapshot: loadTranscriptReadSnapshotSync(scope) };
  });
}

/** Borrow the canonical actor's connection; this domain never opens or closes a database. */
export function bindSqliteWorkerBackend(
  _input: undefined,
  context: {
    databasePath: string;
    database: DatabaseSync;
    admit(stage: "transaction" | "commit", restriction?: AgentDatabaseAdmissionRestriction): void;
  },
): SqliteWorkerBackend<SessionMetadataWorkerOperations> {
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
          const error = new Error(
            `SQLite transcript changed while preparing rewrite for ${scope.sessionId}`,
          );
          error.name = "SqliteTranscriptMutationConflictError";
          throw error;
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
                  )
                : appendTranscriptEventSnapshotSync(scope, event, command.input.options, {
                    ...projection,
                    eventJson:
                      typeof command.input.event === "string" ? command.input.event : undefined,
                  });
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
            value: readCommittedMetadataView(scope, view.limits, view.admission),
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
        return execute(command);
      } catch (error) {
        if (error instanceof SessionTranscriptWriterClaimReboundError) {
          return { ok: false, refusal: copyTranscriptRefusal(error.cause) };
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
    close() {
      closed = true;
    },
  };
}
