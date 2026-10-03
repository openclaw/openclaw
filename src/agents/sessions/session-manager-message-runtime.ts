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
import { prepareTranscriptMessageAppendForWorker } from "../../config/sessions/session-accessor.sqlite-transcript-message-append.js";
import {
  assertSessionStoreReadCandidate,
  type SessionStoreReadCandidate,
} from "../../config/sessions/session-store-read-candidates.js";
import { startSessionTranscriptIndexReconcile } from "../../config/sessions/session-transcript-reconcile.js";
import type { SessionTranscriptTargetBinding } from "../../config/sessions/transcript-target-binding.js";
import { SessionTranscriptWriterClaimReboundError } from "../../config/sessions/transcript-write-context.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { runtimeProcessEntrypoints } from "../../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-lifecycle-errors.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import type { Message } from "../../llm/types.js";
import { readLoggingConfig } from "../../logging/config.js";
import { getSecretRedactionRegistryRevision } from "../../logging/secret-redaction-registry.js";
import { freezeJsonSnapshot } from "../../shared/immutable-data.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { BashExecutionMessage, CustomMessage } from "./messages.js";
import { captureSessionMessageAdmission } from "./session-manager-message-admission.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-metadata.worker.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);

type TranscriptAppendMessage = Message | CustomMessage | BashExecutionMessage;
type TranscriptAppendInput<TMessage> = {
  target: SessionTranscriptTargetBinding & SessionTranscriptWriteScope;
  candidate: SessionStoreReadCandidate;
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
  const readRedactPatterns = () =>
    input.config?.logging?.redactPatterns ?? readLoggingConfig()?.redactPatterns;
  let redactionRevision = getSecretRedactionRegistryRevision();
  let redactPatterns = readRedactPatterns()?.slice();
  const prepared = prepareTranscriptMessageAppendForWorker(input);
  freezeJsonSnapshot(prepared.persistedMessage);
  const assertPrepared = () => {
    input.assertCurrent();
    const revision = getSecretRedactionRegistryRevision();
    const patterns = readRedactPatterns();
    if (
      revision !== redactionRevision ||
      patterns?.length !== redactPatterns?.length ||
      patterns?.some((pattern, index) => pattern !== redactPatterns?.[index])
    ) {
      if (prepareTranscriptMessageAppendForWorker(input).messageJson !== prepared.messageJson) {
        throw new Error("Transcript message redaction changed before persistence");
      }
      redactionRevision = revision;
      redactPatterns = patterns?.slice();
    }
  };
  assertPrepared();
  const resolved = await prepareSqliteTranscriptReadScope(input.target);
  const options = toDatabaseOptions(resolved);
  const databasePath = resolveOpenClawAgentSqlitePath(options);
  const assertCurrent = () => {
    assertPrepared();
    assertSessionStoreReadCandidate(databasePath, [input.candidate]);
  };
  assertCurrent();
  const admission = captureSessionMessageAdmission(assertCurrent);
  const execution = captureOpenClawAgentDatabaseExecution(options);
  const { env: _env, ...writeTarget } = input.target;
  let worker:
    | Awaited<
        ReturnType<typeof openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>>
      >
    | undefined;
  let committed:
    | {
        messageId: string;
        message: TranscriptAppendMessage;
        appended: boolean;
        currentTail: boolean;
        version: SessionTranscriptContextVersion;
        lifecycleRevision?: string;
      }
    | undefined;
  const failures: unknown[] = [];
  try {
    worker = await openOpenClawAgentSqliteWorkerStore<SessionMetadataWorkerOperations>(
      options,
      { execution },
      { moduleUrl, input: undefined, assertAdmission: admission.assertAdmission },
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
      const snapshot = reply.value.snapshot;
      if (!snapshot.ok) {
        throw new Error("Session transcript message was not persisted", { cause: snapshot.error });
      }
      if (!snapshot.value.result) {
        throw new Error("Session transcript message was not persisted");
      }
      committed = {
        messageId: snapshot.value.result.messageId,
        message: snapshot.value.result.message ?? prepared.persistedMessage,
        appended: snapshot.value.result.appended,
        currentTail: isTranscriptMessageAppendCurrentTail(snapshot.value),
        version: snapshot.value.after,
        lifecycleRevision: snapshot.value.lifecycleRevision,
      };
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
    try {
      await worker?.close();
    } catch (error) {
      failures.push(error);
    }
    try {
      await execution.release();
    } catch (error) {
      failures.push(error);
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
    if (committed) {
      throw new SessionTranscriptMessageCommittedError(
        committed.messageId,
        error,
        input.target,
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
  if (!committed) {
    throw new Error("Session transcript message was not persisted");
  }
  return {
    messageId: committed.messageId,
    message: committed.message,
    appended: committed.appended,
    currentTail: committed.currentTail,
  };
}
