import { collectNestedErrorCandidates } from "@openclaw/normalization-core/error-coercion";
import type {
  SessionTranscriptContextVersion,
  SessionTranscriptWriteScope,
  TranscriptMessageAppendResult,
} from "../../config/sessions/session-accessor.sqlite-contract.js";
import {
  prepareSqliteTranscriptReadScope,
  toDatabaseOptions,
} from "../../config/sessions/session-accessor.sqlite-scope.js";
import { isTranscriptMessageAppendCurrentTail } from "../../config/sessions/session-accessor.sqlite-transcript-append-result.js";
import {
  prepareTranscriptMessageAppendForWorker,
  type PreparedTranscriptMessageAppend,
} from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import type { SessionActor } from "../../config/sessions/session-actor-contract.js";
import type {
  SessionMetadataOperations,
  SessionMetadataWorkerOperations,
} from "../../config/sessions/session-manager-write-contract.js";
import {
  assertSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../../config/sessions/session-store-read-candidates.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import {
  getOwnedSessionTranscriptActor,
  SessionTranscriptWriterClaimReboundError,
} from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { Message } from "../../llm/types.js";
import type { OpenClawAgentDatabaseOptions } from "../../state/openclaw-agent-db-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { appendSessionManagerActor } from "./session-manager-actor-append.js";
import { captureSessionMessageAdmission } from "./session-manager-message-admission.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import { createSessionManagerPublicationHooks } from "./session-manager-publication.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);

type TranscriptAppendMessage = Message | CustomMessage | BashExecutionMessage;
type TranscriptAppendInput<TMessage> = {
  target: SessionTranscriptTargetBinding & SessionTranscriptWriteScope;
  candidate?: SessionStoreReadCandidate;
  message: TMessage;
  config?: OpenClawConfig;
  cwd: string;
  assertCurrent: () => void;
};
export type SessionTranscriptAppendResult<TMessage> = Pick<
  TranscriptMessageAppendResult<TMessage>,
  "messageId" | "message" | "appended"
> & {
  currentTail: boolean;
};

export function appendSessionTranscriptMessage(
  input: TranscriptAppendInput<CustomMessage>,
): Promise<SessionTranscriptAppendResult<CustomMessage>>;
export function appendSessionTranscriptMessage(
  input: TranscriptAppendInput<TranscriptAppendMessage>,
): Promise<SessionTranscriptAppendResult<TranscriptAppendMessage>>;
/** The existing session domain owns the transaction; only committed facts return to its caller. */
export async function appendSessionTranscriptMessage(
  input: TranscriptAppendInput<TranscriptAppendMessage>,
): Promise<SessionTranscriptAppendResult<TranscriptAppendMessage>> {
  const prepared = prepareTranscriptMessageAppendForWorker(input);
  Object.freeze(prepared.persistedMessage);
  input.assertCurrent();
  const actorBinding = getOwnedSessionTranscriptActor(input.target);
  if (actorBinding) {
    return appendOwnedActorTranscriptMessage(
      input,
      prepared,
      actorBinding.actor,
      actorBinding.database,
    );
  }
  if (!input.candidate) {
    throw new Error("Unbound transcript append requires a captured store candidate");
  }
  return appendUnboundSdkTranscriptMessage({ ...input, candidate: input.candidate }, prepared);
}

type PreparedTranscriptMessage = PreparedTranscriptMessageAppend<TranscriptAppendMessage>;
type CommittedTranscriptMessage = {
  result: SessionTranscriptAppendResult<TranscriptAppendMessage>;
  version: SessionTranscriptContextVersion;
  lifecycleRevision?: string;
};

function readCommittedMessage(
  append: SessionMetadataOperations["session.transcript.appendMessage"]["output"],
  prepared: PreparedTranscriptMessage,
): CommittedTranscriptMessage {
  const persisted = append.snapshot;
  if (!persisted.ok) {
    throw new Error("Session transcript message was not persisted", { cause: persisted.error });
  }
  const result = persisted.value.result;
  if (!result) {
    throw new Error("Session transcript message was not persisted");
  }
  return {
    result: {
      messageId: result.messageId,
      message: result.message ?? prepared.persistedMessage,
      appended: result.appended,
      currentTail: isTranscriptMessageAppendCurrentTail(persisted.value),
    },
    version: persisted.value.after,
    lifecycleRevision: persisted.value.lifecycleRevision,
  };
}

function throwTranscriptAppendError(
  error: unknown,
  committed: CommittedTranscriptMessage | undefined,
  target: TranscriptAppendInput<TranscriptAppendMessage>["target"],
): never {
  if (committed) {
    throw new SessionTranscriptMessageCommittedError(
      committed.result.messageId,
      error,
      target,
      committed.version,
      committed.lifecycleRevision,
    );
  }
  if (
    error instanceof Error &&
    collectNestedErrorCandidates(error).some((cause) =>
      isSqliteWorkerError(cause, "outcome-unknown"),
    )
  ) {
    recordModelFallbackStop(error);
  }
  throw error;
}

async function appendOwnedActorTranscriptMessage(
  input: TranscriptAppendInput<TranscriptAppendMessage>,
  prepared: PreparedTranscriptMessage,
  actor: SessionActor,
  options: Readonly<OpenClawAgentDatabaseOptions & { agentId: string; path: string }>,
): Promise<SessionTranscriptAppendResult<TranscriptAppendMessage>> {
  const databasePath = options.path;
  const assertCurrent = () => {
    input.assertCurrent();
    if (input.candidate) {
      assertSessionStoreReadCandidate(databasePath, [input.candidate]);
    }
    actor.assertCurrent();
  };
  let committed: CommittedTranscriptMessage | undefined;
  try {
    const { env: _env, ...writeTarget } = input.target;
    const receipt = await appendSessionManagerActor({
      actor,
      toolResult: false,
      assertCurrent,
      append: {
        kind: "message",
        input: {
          scope: { ...writeTarget, storePath: databasePath },
          messageJson: prepared.messageJson,
          cwd: input.cwd,
        },
      },
      onCommitted(append) {
        if (append.kind !== "message") {
          throw new Error("Session actor omitted the committed transcript message");
        }
        committed = readCommittedMessage(append.value, prepared);
      },
    });
    if (receipt.failure) {
      throw receipt.failure;
    }
    assertCurrent();
    if (!committed) {
      throw new Error("Session actor omitted its committed transcript observation");
    }
    if (receipt.committed.value.projectionNeedsReconcile) {
      startSessionTranscriptIndexReconcile({
        ...options,
        preferredSessionId: input.target.sessionId,
      });
    }
    return committed.result;
  } catch (error) {
    return throwTranscriptAppendError(error, committed, input.target);
  }
}

/** Released unbound SDK calls retain their native metadata adapter. */
async function appendUnboundSdkTranscriptMessage(
  input: TranscriptAppendInput<TranscriptAppendMessage> & { candidate: SessionStoreReadCandidate },
  prepared: PreparedTranscriptMessage,
): Promise<SessionTranscriptAppendResult<TranscriptAppendMessage>> {
  const resolved = await prepareSqliteTranscriptReadScope(input.target);
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const assertCurrent = () => {
    input.assertCurrent();
    assertSessionStoreReadCandidate(databasePath, [input.candidate]);
  };
  assertCurrent();
  const admission = captureSessionMessageAdmission(assertCurrent);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const publication = createSessionManagerPublicationHooks({
    agentId: input.target.agentId,
    storePath: execution.path,
    databaseIdentity: () => execution.fileIdentity?.physicalIdentity,
  });
  const { env: _env, ...writeTarget } = input.target;
  let worker:
    | Awaited<
        ReturnType<typeof openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>>
      >
    | undefined;
  let committed: CommittedTranscriptMessage | undefined;
  const failures: unknown[] = [];
  try {
    worker = await openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>(
      options,
      { execution },
      {
        moduleUrl,
        input: undefined,
        assertAdmission: (request) => admission.assertAdmission(publication.unwrap(request)),
        onAdmitted: publication.onAdmitted,
        observeAdmission: publication.observeAdmission,
      },
    );
    await worker.run(async (scope) => {
      const reply = await scope.execute({
        type: "session.transcript.appendMessage",
        input: {
          scope: { ...writeTarget, storePath: execution.path },
          messageJson: prepared.messageJson,
          cwd: input.cwd,
          ...admission.control,
        },
      });
      if (!reply.ok) {
        throw new SessionTranscriptWriterClaimReboundError(reply.refusal);
      }
      committed = readCommittedMessage(reply.value, prepared);
      admission.publish(reply.value.pendingInputReceipt);
      assertCurrent();
      if (reply.value.projectionNeedsReconcile) {
        startSessionTranscriptIndexReconcile({
          ...options,
          preferredSessionId: input.target.sessionId,
        });
      }
    }, assertCurrent);
  } catch (error) {
    failures.push(error);
  } finally {
    for (const release of [() => worker?.close(), () => execution.release()]) {
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  try {
    if (failures.length > 1) {
      throw createSqliteLifecycleAggregateError(
        failures,
        "Session transcript append and cleanup failed",
        failures[0],
      );
    }
    if (failures.length === 1) {
      throw failures[0];
    }
    assertCurrent();
  } catch (error) {
    return throwTranscriptAppendError(error, committed, input.target);
  }
  if (!committed) {
    throw new Error("Session transcript message was not persisted");
  }
  return committed.result;
}
