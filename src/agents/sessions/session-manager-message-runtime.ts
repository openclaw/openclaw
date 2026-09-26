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
import { redactTranscriptMessageForStorage } from "../../config/sessions/session-accessor.sqlite-transcript-store.js";
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
import { createSqliteLifecycleAggregateError } from "../../infra/sqlite-coordinator.js";
import { isSqliteWorkerError } from "../../infra/sqlite-worker-contract.js";
import { resolveOpenClawAgentSqlitePath } from "../../state/openclaw-agent-db.paths.js";
import { captureOpenClawAgentDatabaseExecution } from "../../state/openclaw-agent-execution.js";
import { openOpenClawAgentSqliteWorkerStore } from "../../state/openclaw-agent-worker-store.js";
import { recordModelFallbackStop } from "../model-fallback-stop.js";
import type { CustomMessage } from "./messages.js";
import { SessionTranscriptMessageCommittedError } from "./session-manager-message-error.js";
import type { SessionMetadataWorkerOperations } from "./session-manager-metadata.worker.js";

const moduleUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.sessionManagerMetadata);

/** The existing session domain owns the transaction; only committed facts return to its caller. */
export async function appendSessionTranscriptMessage(input: {
  target: SessionTranscriptTargetBinding & SessionTranscriptWriteScope;
  candidate: SessionStoreReadCandidate;
  message: CustomMessage;
  config?: OpenClawConfig;
  cwd: string;
  assertCurrent: () => void;
}): Promise<
  Pick<TranscriptMessageAppendResult<CustomMessage>, "messageId" | "message" | "appended"> & {
    currentTail: boolean;
  }
> {
  const message = redactTranscriptMessageForStorage(input.message, input);
  const preparedJson = JSON.stringify(message);
  const assertPrepared = () => {
    input.assertCurrent();
    if (JSON.stringify(redactTranscriptMessageForStorage(input.message, input)) !== preparedJson) {
      throw new Error("Transcript message redaction changed before persistence");
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
        message: CustomMessage;
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
      { moduleUrl, input: undefined },
    );
    await worker.run(async (scope) => {
      const reply = await scope.execute({
        type: "session.transcript.appendMessage",
        input: {
          scope: { ...writeTarget, storePath: execution.path },
          message,
          cwd: input.cwd,
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
        message: snapshot.value.result.message,
        appended: snapshot.value.result.appended,
        currentTail: isTranscriptMessageAppendCurrentTail(snapshot.value),
        version: snapshot.value.after,
        lifecycleRevision: snapshot.value.lifecycleRevision,
      };
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
