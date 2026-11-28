import type { SessionTranscriptRuntimeTarget } from "../../../config/sessions/session-accessor.js";
import { applySessionEntryOperation } from "../../../config/sessions/session-accessor.sqlite-entry.js";
import type { SessionSourceAssertion } from "../../../config/sessions/session-source-authority.js";
import { sessionEntryCommitGuardOptions } from "../../../config/sessions/session-source-authority.js";
import { SESSION_TOTAL_TOKENS_VERSION } from "../../../config/sessions/types.js";
import { log } from "../logger.js";
import type { EmbeddedRunAttemptInternalParams } from "./internal-params.js";

/** Publish the request owner's prepared occupancy before another model call can wait for hours. */
export async function publishEmbeddedRequestContext(
  attempt: Pick<
    EmbeddedRunAttemptInternalParams,
    "runId" | "sessionPersistence" | "preparedSessionTarget" | "onContextAccountingEvent"
  >,
  contextTokens: number,
): Promise<void> {
  attempt.onContextAccountingEvent?.({ kind: "request", contextTokens });
  const prepared = attempt.preparedSessionTarget;
  if (!prepared || attempt.sessionPersistence === "detached") {
    return;
  }
  const { target, assertCurrent } = prepared;
  await publishSessionContext(
    target,
    {
      sessionId: target.sessionId,
      lifecycleRevision: target.expectedLifecycleRevision,
      activeWriterRunId: target.expectedWriterRunId ?? attempt.runId,
    },
    assertCurrent,
    contextTokens,
  );
}

export async function publishSessionContext(
  target: SessionTranscriptRuntimeTarget,
  {
    sessionId,
    lifecycleRevision,
    activeWriterRunId,
  }: { sessionId: string; lifecycleRevision?: string; activeWriterRunId?: string },
  assertCurrent: SessionSourceAssertion,
  contextTokens: number,
): Promise<void> {
  try {
    await applySessionEntryOperation(
      target,
      {
        kind: "fields",
        expected: { sessionId, lifecycleRevision, activeWriterRunId },
        patch: {
          totalTokens: contextTokens,
          totalTokensFresh: true,
          totalTokensVersion: SESSION_TOTAL_TOKENS_VERSION,
        },
      },
      { ...sessionEntryCommitGuardOptions(assertCurrent), preserveActivity: true, result: "none" },
    );
  } catch (error) {
    log.warn(`request context accounting failed: ${String(error)}`);
  }
}
