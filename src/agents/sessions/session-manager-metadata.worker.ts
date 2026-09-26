import type { DatabaseSync } from "node:sqlite";
import { serialize } from "node:v8";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { Result } from "@openclaw/normalization-core/result";
import { readSessionTranscriptBoundedActiveContextCore } from "../../config/sessions/session-accessor.sqlite-active-context.js";
import { persistCompactionBoundaryWithSessionEntrySync } from "../../config/sessions/session-accessor.sqlite-compaction.js";
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
import { runWithSessionTranscriptReadFence } from "../../config/sessions/session-transcript-read-fence.js";
import { prepareTranscriptPayloadForReuse } from "../../config/sessions/transcript-payload.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { InternalSessionEntry } from "../../config/sessions/types.js";
import { assertTransactionUsable } from "../../infra/sqlite-transaction.js";
import type {
  SqliteWorkerBackend,
  SqliteWorkerCommand,
} from "../../infra/sqlite-worker-contract.js";
import { getSqliteWorkerStateContext } from "../../infra/sqlite-worker-state-context.js";
import type { UserTurnTranscriptAdmissionReceipt } from "../../sessions/user-turn-transcript.types.js";
import { runOpenClawAgentWriteTransaction } from "../../state/openclaw-agent-db.js";
import {
  encodeOpenClawStateWorkerError,
  type OpenClawStateWorkerErrorPayload,
} from "../../state/openclaw-state-worker-error.js";
import type { CustomMessage } from "./messages.js";
import type { PreparedCompactionAccounting } from "./session-compaction-persistence.js";
import type {
  CompactionEntry,
  ModelChangeEntry,
  SessionHeader,
  SessionMessageEntry,
  ThinkingLevelChangeEntry,
} from "./session-manager-types.js";
import type {
  PreparedSessionTranscriptReload,
  SessionManagerBoundedContextLimits,
} from "./session-manager-view-types.js";

type MetadataTarget = Omit<SessionTranscriptWriteScope, "env"> & SessionTranscriptRuntimeTarget;

export type SessionMetadataOperations = {
  "session.transcript.appendMessage": {
    input: { scope: MetadataTarget; message: CustomMessage; cwd: string };
    output: {
      snapshot: ReturnType<typeof appendTranscriptMessageSnapshotSync<CustomMessage>>;
      projectionNeedsReconcile: boolean;
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
      event:
        | SessionHeader
        | ModelChangeEntry
        | ThinkingLevelChangeEntry
        | SessionMessageEntry
        | CompactionEntry;
      compactionAccounting?: Omit<PreparedCompactionAccounting, "scope"> & {
        scope: Omit<PreparedCompactionAccounting["scope"], "env">;
      };
      message?: {
        prepared: PreparedTranscriptMessageAppend<SessionMessageEntry["message"]>;
        cwd: string;
        validateTurn: boolean;
        idempotencyLookup?: "scan" | "scan-assistant" | "caller-checked";
      };
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
          | TranscriptMessageAppendResult<SessionMessageEntry["message"]>
          | undefined
        >,
        TranscriptAppendRefusal
      >;
      projectionNeedsReconcile: boolean;
      reload?: Result<PreparedSessionTranscriptReload, OpenClawStateWorkerErrorPayload | undefined>;
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
    admit(stage: "transaction" | "commit"): void;
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
    if (options.path !== context.databasePath) {
      throw new Error("Session metadata target changed its database owner");
    }
    if (command.type === "session.metadata.mutation") {
      return { ok: true, value: readTranscriptMutationAtSync(scope) };
    }
    assertCanonicalSessionKeyWrite(resolved.sessionKey, resolved.agentId);
    if (command.type === "session.transcript.appendMessage") {
      return runOpenClawAgentWriteTransaction<
        SessionMetadataWorkerOperations["session.transcript.appendMessage"]["output"]
      >((database) => {
        if (database.db !== context.database) {
          throw new Error("Session message lost its borrowed canonical connection");
        }
        context.admit("transaction");
        let projectionNeedsReconcile = false;
        const snapshot = appendTranscriptMessageSnapshotSync(
          scope,
          { message: command.input.message, cwd: command.input.cwd },
          undefined,
          {
            messageAlreadyRedacted: true,
            scheduleProjectionReconcile: false,
            onProjectionReconcileNeeded: () => {
              projectionNeedsReconcile = true;
            },
          },
        );
        context.admit("commit");
        return { ok: true, value: { snapshot, projectionNeedsReconcile } };
      }, options);
    }
    if (command.type === "session.metadata.append" && command.input.event.type === "message") {
      const { event, message } = command.input;
      if (!message) {
        throw new Error("Session message append requires prepared storage bytes");
      }
      const { message: _message, ...envelope } = event;
      const eventJson = `${JSON.stringify(envelope).slice(0, -1)},"message":${message.prepared.messageJson}}`;
      message.prepared.physicalPayload = prepareTranscriptPayloadForReuse(
        context.database,
        eventJson,
        {
          ...envelope,
          message: message.prepared.persistedMessage,
        },
      );
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
    const outcome = runOpenClawAgentWriteTransaction<
      SessionMetadataWorkerOperations[
        | "session.metadata.initialize"
        | "session.metadata.append"]["output"]
    >((database) => {
      if (database.db !== context.database) {
        throw new Error("Session metadata lost its borrowed canonical connection");
      }
      context.admit("transaction");
      if (command.type === "session.metadata.initialize") {
        const result = ensureSessionEntryInTransaction(
          database,
          resolved,
          scope,
          command.input.entry,
          command.input.initialWriterRunId,
        );
        context.admit("commit");
        return { ok: true, value: result };
      }
      let projectionNeedsReconcile = false;
      const projection = {
        scheduleProjectionReconcile: false,
        onProjectionReconcileNeeded: () => {
          projectionNeedsReconcile = true;
        },
      } as const;
      const { event, message, compactionAccounting } = command.input;
      const snapshot = (() => {
        if (compactionAccounting) {
          if (event.type !== "compaction") {
            throw new Error("Compaction accounting requires a compaction boundary");
          }
          const committed = persistCompactionBoundaryWithSessionEntrySync(
            { ...compactionAccounting.scope, env: scope.env },
            {
              prepared: { scope, event, ...command.input.options },
              transcriptByteCompactionLatch: compactionAccounting.transcriptByteCompactionLatch,
            },
            projection,
          );
          return {
            ok: true as const,
            value: {
              before: committed.before,
              after: committed.after,
              result: { appended: true as const, effectiveParentId: committed.result.parentId },
            },
          };
        }
        return event.type === "message" && message
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
              },
              message.prepared,
              projection,
            )
          : appendTranscriptEventSnapshotSync(scope, event, command.input.options, projection);
      })();
      context.admit("commit");
      return { ok: true, value: { snapshot, projectionNeedsReconcile } };
    }, options);
    if (
      command.type === "session.metadata.append" &&
      command.input.event.type !== "session" &&
      command.input.view &&
      outcome.ok &&
      "snapshot" in outcome.value &&
      outcome.value.snapshot.ok
    ) {
      const { event, view } = command.input;
      const committed = outcome.value.snapshot.value;
      if (!committed.result?.appended) {
        return outcome;
      }
      const version = view.loadedVersion;
      const effectiveParentId = committed.result.effectiveParentId;
      if (
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
