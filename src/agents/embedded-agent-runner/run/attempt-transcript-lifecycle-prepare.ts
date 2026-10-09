/** Prepares the admitted writer context and teardown tracker for one attempt. */
import { getReplyOperationSessionReader } from "../../../auto-reply/reply/reply-run-registry.state.js";
import { prepareCronRootSessionGeneration } from "../../../config/sessions/session-delivery-generation.js";
import {
  getOwnedSessionTranscriptInitialWriter,
  type OwnedSessionTranscriptWriteContext,
  withOwnedSessionTranscriptWrites,
} from "../../../config/sessions/transcript-write-context.js";
import { resolveAdmittedRunActiveAssertion } from "../../admitted-run-context.js";
import { resolveAgentRunSessionTarget } from "../../run-session-target.js";
import { resolveCompactionTimeoutMs } from "../compaction-safety-timeout.js";
import { createEmbeddedAttemptTranscriptLifecycle } from "./attempt-transcript-lifecycle.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type WithOwnedTranscriptWrite = <T>(operation: () => Promise<T> | T) => Promise<T>;

export async function prepareEmbeddedAttemptTranscriptLifecycle(input: {
  runAbortController?: AbortController;
  attempt: Pick<
    EmbeddedRunAttemptInternalParams,
    | "abortSignal"
    | "config"
    | "runId"
    | "replyOperation"
    | "sessionFile"
    | "sessionId"
    | "sessionKey"
    | "sessionManager"
    | "sessionTarget"
    | "preparedSessionTarget"
  > & { admittedRunContext?: EmbeddedRunAttemptParams["admittedRunContext"] };
  externalAbortController: {
    arm: () => void;
    throwIfFiredAfterPrepCleanup: () => Promise<void>;
  };
}): Promise<{
  compactionTimeoutMs: number;
  assertCronRootCurrent?: () => void;
  ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext;
  transcriptLifecycle: ReturnType<typeof createEmbeddedAttemptTranscriptLifecycle>;
  withOwnedTranscriptWrite: WithOwnedTranscriptWrite;
}> {
  const { attempt, externalAbortController } = input;
  const preparedTarget = attempt.preparedSessionTarget;
  preparedTarget?.assertCurrent();
  const initialWriter = getOwnedSessionTranscriptInitialWriter({
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: attempt.sessionManager?.getSessionTarget() ?? attempt.sessionTarget,
  });
  const sessionTarget =
    preparedTarget?.target ??
    (await resolveAgentRunSessionTarget({
      agentId: attempt.sessionTarget?.agentId,
      config: attempt.config,
      missingSessionKey: "resolve-existing",
      sessionFile: attempt.sessionFile,
      sessionId: attempt.sessionId,
      sessionKey: attempt.sessionKey,
      sessionTarget: attempt.sessionTarget,
    }));
  await externalAbortController.throwIfFiredAfterPrepCleanup();
  preparedTarget?.assertCurrent();
  initialWriter?.assertActive();

  const fencedSessionTarget = {
    ...sessionTarget,
    expectedLifecycleRevision: attempt.sessionTarget?.expectedLifecycleRevision,
    expectedWriterRunId: attempt.sessionTarget?.expectedWriterRunId,
  };
  // The stable cron root can rotate while its exact run remains stored. Retain
  // its admitted generation only for this attempt, before compaction adoption.
  const generation = await prepareCronRootSessionGeneration(
    {
      ...sessionTarget,
      sessionKey: attempt.sessionKey ?? sessionTarget.sessionKey,
      lifecycleRevision: fencedSessionTarget.expectedLifecycleRevision,
    },
    input.runAbortController ? (reason) => input.runAbortController?.abort(reason) : undefined,
  );
  const lifecycle = createEmbeddedAttemptTranscriptLifecycle({
    runId: attempt.runId,
    sessionId: attempt.sessionId,
  });
  const transcriptLifecycle = {
    ...lifecycle,
    dispose: async () => {
      try {
        await lifecycle.dispose();
      } finally {
        generation?.release();
      }
    },
  };
  const assertAdmittedActive = attempt.admittedRunContext
    ? resolveAdmittedRunActiveAssertion(attempt.admittedRunContext, attempt.abortSignal)
    : undefined;
  const withTranscriptWrite: WithOwnedTranscriptWrite = (operation) =>
    initialWriter
      ? initialWriter.withTranscriptWrite(() => transcriptLifecycle.withTranscriptWrite(operation))
      : transcriptLifecycle.withTranscriptWrite(operation);
  const ownedTranscriptWriteContext: OwnedSessionTranscriptWriteContext = {
    sessionFile: attempt.sessionFile,
    sessionKey: attempt.sessionKey,
    sessionTarget: fencedSessionTarget,
    sessionReader: getReplyOperationSessionReader(attempt.replyOperation),
    ...(initialWriter ? { initialWriter } : {}),
    assertCommitAllowed: () => {
      attempt.abortSignal?.throwIfAborted();
      assertAdmittedActive?.();
      generation?.assertCurrent();
    },
    withTranscriptWrite,
  };
  externalAbortController.arm();
  try {
    await externalAbortController.throwIfFiredAfterPrepCleanup();
    preparedTarget?.assertCurrent();
  } catch (error) {
    await transcriptLifecycle.dispose();
    throw error;
  }

  return {
    compactionTimeoutMs: resolveCompactionTimeoutMs(attempt.config),
    assertCronRootCurrent: generation ? ownedTranscriptWriteContext.assertCommitAllowed : undefined,
    ownedTranscriptWriteContext,
    transcriptLifecycle,
    withOwnedTranscriptWrite: (operation) =>
      withOwnedSessionTranscriptWrites(ownedTranscriptWriteContext, async () =>
        withTranscriptWrite(operation),
      ),
  };
}
