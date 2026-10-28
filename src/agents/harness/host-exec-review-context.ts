import { isDeepStrictEqual } from "node:util";
import { resolveSessionTranscriptDatabasePath } from "../../config/sessions/session-accessor.transcript-target.js";
import { composeSessionSourceAssertion } from "../../config/sessions/session-source-authority.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getUserTurnTranscriptAdmissionOwner } from "../../sessions/user-turn-transcript-admission.js";
import { isSameOpenClawAgentDatabasePath } from "../../state/openclaw-agent-db.paths.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { buildExecAutoReviewTranscript } from "../exec-auto-review-transcript.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import { cloneHostSnapshot as cloneSnapshot } from "./host-snapshot.js";

/** Bind reviewer evidence to the host's admitted input, never plugin-authored text. */
export function bindHarnessExecReviewContext(params: {
  attempt: Partial<EmbeddedRunAttemptParams> & Pick<EmbeddedRunAttemptParams, "runId">;
  config?: OpenClawConfig;
  assertActive: () => void;
  abort: (reason: Error) => void;
}) {
  const { attempt, config, assertActive } = params;
  const runId = attempt.runId;
  const attemptSignal = attempt.abortSignal;
  const recorder = attempt.userTurnTranscriptRecorder;
  const sessionTarget = attempt.sessionTarget ? cloneSnapshot(attempt.sessionTarget) : undefined;
  // Capture the canonical admitted input before plugin invocation. Native prompt
  // annotations and plugin-supplied context must not rewrite reviewer consent.
  const reviewOwner = recorder && getUserTurnTranscriptAdmissionOwner(recorder);
  let reviewAdmission = reviewOwner?.receipt() ? cloneSnapshot(reviewOwner.receipt()!) : undefined;
  const reviewMessage = reviewOwner?.message() ? cloneSnapshot(reviewOwner.message()!) : undefined;
  const assertExecReviewSource = composeSessionSourceAssertion([assertActive], (assertSource) => {
    assertSource();
    attemptSignal?.throwIfAborted();
    if (!reviewOwner || !reviewAdmission || !reviewMessage || !sessionTarget?.storePath) {
      return;
    }
    if (
      attempt.runId !== runId ||
      attempt.userTurnTranscriptRecorder !== recorder ||
      !isDeepStrictEqual(attempt.sessionTarget, sessionTarget) ||
      attempt.agentId !== reviewAdmission.agentId ||
      attempt.sessionId !== reviewAdmission.sessionId ||
      attempt.sessionKey !== reviewAdmission.sessionKey ||
      !isSameOpenClawAgentDatabasePath(
        resolveSessionTranscriptDatabasePath({
          ...sessionTarget,
          agentId: reviewAdmission.agentId,
          sessionId: reviewAdmission.sessionId,
          sessionKey: reviewAdmission.sessionKey,
          storePath: sessionTarget.storePath,
        }),
        reviewAdmission.storePath,
      ) ||
      reviewOwner.blocked() ||
      !isDeepStrictEqual(reviewOwner.receipt(), reviewAdmission)
    ) {
      const error = new Error("exec review context lost its source execution claim");
      // Review failures normally ask a human; a stale source must instead stop
      // the already-bound tool before approval fallback can dispatch it.
      params.abort(error);
      throw error;
    }
  });
  const reviewTranscript = () => {
    assertExecReviewSource();
    if (!reviewOwner || !reviewAdmission || !reviewMessage || !sessionTarget?.storePath) {
      return undefined;
    }
    return reviewMessage.excludeFromContext
      ? undefined
      : buildExecAutoReviewTranscript({ messages: [reviewMessage], config });
  };
  return {
    assertCurrent: assertExecReviewSource,
    reviewTranscript,
    bindAnnotation:
      (
        annotate: NonNullable<AgentHarnessHostCapabilities["annotateCurrentUserTurn"]>,
      ): NonNullable<AgentHarnessHostCapabilities["annotateCurrentUserTurn"]> =>
      async (annotation) => {
        // Only the existing validated annotation owner may refresh this anchor;
        // arbitrary recorder/receipt replacement must still invalidate execution.
        await annotate(annotation);
        assertActive();
        reviewAdmission = reviewOwner?.receipt()
          ? cloneSnapshot(reviewOwner.receipt()!)
          : undefined;
      },
  };
}
