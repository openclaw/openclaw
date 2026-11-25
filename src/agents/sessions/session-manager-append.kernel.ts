import { requireTranscriptEventAppendSnapshot } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import type { TranscriptAppendCursor } from "../../config/sessions/session-accessor.sqlite-transcript-append.types.js";
import type { PreparedTranscriptMessageAppend } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import { canRebasePreparedAssistantInTransaction } from "../../config/sessions/session-accessor.sqlite-transcript-parent.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "../../config/sessions/session-accessor.sqlite-transcript-write.kernel.js";
import { isReadableSessionMessage } from "../../config/sessions/session-entry-codec.js";
import type { SessionMetadataOperations } from "../../config/sessions/session-manager-write-contract.js";
import { SqliteTranscriptMutationConflictError } from "../../config/sessions/session-mutation-conflict-error.js";
import { prepareTranscriptPayloadForReuse } from "../../config/sessions/transcript-payload.js";
import type { EngineConnection } from "../../infra/sql-connection.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db-contract.js";
import { decodeMetadataAppendEvent } from "./session-manager-append-codec.js";
import type {
  SessionHeader,
  SessionEntry,
  SessionLeafControl,
  SessionMessageEntry,
} from "./session-manager-types.js";

type PreparedSessionManagerAppend = {
  event: SessionHeader | SessionEntry | SessionLeafControl;
  message?: PreparedTranscriptMessageAppend<SessionMessageEntry["message"]>;
};

export function prepareSessionMetadataAppend(
  database: EngineConnection,
  input: SessionMetadataOperations["session.metadata.append"]["input"],
): PreparedSessionManagerAppend {
  const event = decodeMetadataAppendEvent(input);
  if (event.type !== "message") {
    return { event };
  }
  const { message } = input;
  if (!message) {
    throw new Error("Session message append requires prepared storage bytes");
  }
  const { message: _message, ...envelope } = event;
  const eventJson = `${JSON.stringify(envelope).slice(0, -1)},"message":${message.messageJson}}`;
  return {
    event,
    message: {
      messageJson: message.messageJson,
      persistedMessage: event.message,
      physicalPayload: prepareTranscriptPayloadForReuse(database, eventJson, event),
    },
  };
}

/** Both SessionManager adapters lend their exact transaction to this append owner. */
export function applySessionMetadataAppendInTransaction(
  database: OpenClawAgentDatabase,
  input: SessionMetadataOperations["session.metadata.append"]["input"],
  beforeFreshMessageCommit: () => void,
  preparation?: PreparedSessionManagerAppend,
  persistActorMutation = true,
  cursor?: TranscriptAppendCursor,
): SessionMetadataOperations["session.metadata.append"]["output"] {
  const event = preparation?.event ?? decodeMetadataAppendEvent(input);
  let projectionNeedsReconcile = false;
  const projection = {
    persistActorMutation,
    cursor,
    scheduleProjectionReconcile: false,
    onProjectionReconcileNeeded: () => {
      projectionNeedsReconcile = true;
    },
  } as const;
  const { message } = input;
  if (event.type === "message" && message) {
    const prepared = preparation?.message ?? {
      messageJson: message.messageJson,
      persistedMessage: event.message,
    };
    const options = { ...input.options };
    if (message.validateTurn) {
      if (
        !canRebasePreparedAssistantInTransaction(
          database,
          input.scope.sessionId,
          event.parentId,
          input.view?.admission?.entryId,
          input.view?.questionAnswers,
        )
      ) {
        throw new SqliteTranscriptMutationConflictError(input.scope.sessionId);
      }
      // Rebase validation and append now share this write reservation.
      options.expectedMutationAt = undefined;
    }
    const snapshot = appendTranscriptMessageSnapshotSync<
      SessionMessageEntry["message"] | undefined
    >(
      input.scope,
      {
        ...options,
        message: event.message,
        eventId: event.id,
        parentId: event.parentId,
        now: Date.parse(event.timestamp),
        cwd: message.cwd,
        idempotencyLookup: message.idempotencyLookup,
        mentionInvitation: message.mentionInvitation,
        ...(message.freshMessageCheck ? { beforeFreshMessageCommit } : {}),
      },
      prepared,
      projection,
      undefined,
      database,
    );
    if (snapshot.ok && snapshot.value.result?.message === prepared.persistedMessage) {
      // Fresh bytes stay in host custody; replay and accepted-input receipts retain theirs.
      snapshot.value.result.message = undefined;
    }
    return { snapshot, projectionNeedsReconcile };
  }
  const initialModel = input.initialModel
    ? requireTranscriptEventAppendSnapshot(
        appendTranscriptEventSnapshotSync(
          input.scope,
          input.initialModel,
          input.options,
          { ...projection, persistActorMutation: false },
          undefined,
          database,
        ),
        "Initial model metadata was not persisted",
      )
    : undefined;
  const snapshot = appendTranscriptEventSnapshotSync(
    input.scope,
    event,
    initialModel ? { ...input.options, expectedMutationAt: undefined } : input.options,
    {
      ...projection,
      eventJson: typeof input.event === "string" ? input.event : undefined,
    },
    undefined,
    database,
  );
  if (initialModel) {
    const thinking = requireTranscriptEventAppendSnapshot(
      snapshot,
      "Initial thinking metadata was not persisted",
    );
    return {
      snapshot: { ok: true, value: { ...thinking, before: initialModel.before } },
      initialModelParentId: initialModel.result.effectiveParentId,
      projectionNeedsReconcile,
    };
  }
  return { snapshot, projectionNeedsReconcile };
}

export function applySessionDirectMessageInTransaction(
  database: OpenClawAgentDatabase,
  input: SessionMetadataOperations["session.transcript.appendMessage"]["input"],
  beforeFreshMessageCommit?: () => void,
): SessionMetadataOperations["session.transcript.appendMessage"]["output"] {
  const message: unknown = JSON.parse(input.messageJson);
  if (!isReadableSessionMessage(message)) {
    throw new Error("Invalid serialized session transcript message");
  }
  let projectionNeedsReconcile = false;
  const snapshot = appendTranscriptMessageSnapshotSync<typeof message | undefined>(
    input.scope,
    {
      message,
      cwd: input.cwd,
      mentionInvitation: input.mentionInvitation,
      ...(input.freshMessageCheck && beforeFreshMessageCommit ? { beforeFreshMessageCommit } : {}),
    },
    { messageJson: input.messageJson, persistedMessage: message },
    {
      scheduleProjectionReconcile: false,
      onProjectionReconcileNeeded: () => {
        projectionNeedsReconcile = true;
      },
    },
    undefined,
    database,
  );
  if (snapshot.ok && snapshot.value.result?.message === message) {
    snapshot.value.result.message = undefined;
  }
  return { snapshot, projectionNeedsReconcile };
}
