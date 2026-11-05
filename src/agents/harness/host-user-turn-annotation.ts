import { isDeepStrictEqual } from "node:util";
import { bindUserTurnTranscriptAnnotation } from "../../sessions/user-turn-transcript-annotation.js";
import type { EmbeddedRunAttemptInternalParams } from "../embedded-agent-runner/run/internal-params.js";
import { cloneHostSnapshot as cloneSnapshot } from "./host-snapshot.js";

/** Bind annotation to the original recorder and session, not later mutable attempt inputs. */
export function bindHostUserTurnAnnotation(
  attempt: Partial<EmbeddedRunAttemptInternalParams> &
    Pick<EmbeddedRunAttemptInternalParams, "runId">,
  config: EmbeddedRunAttemptInternalParams["config"] | undefined,
  assertActive: () => void,
  bindAbortSignal: (signal: AbortSignal | undefined) => AbortSignal,
) {
  const recorder = attempt.userTurnTranscriptRecorder;
  const sessionTarget = attempt.sessionTarget ? cloneSnapshot(attempt.sessionTarget) : undefined;
  return attempt.userTurnTranscriptRecorder &&
    attempt.sessionTarget &&
    attempt.agentId &&
    attempt.sessionId &&
    attempt.sessionKey &&
    attempt.sessionTarget.storePath &&
    !attempt.suppressNextUserMessagePersistence &&
    attempt.trigger !== "memory"
    ? bindUserTurnTranscriptAnnotation({
        recorder: attempt.userTurnTranscriptRecorder,
        target: {
          ...attempt.sessionTarget,
          agentId: attempt.agentId,
          sessionId: attempt.sessionId,
          sessionKey: attempt.sessionKey,
          storePath: attempt.sessionTarget.storePath,
        },
        runId: attempt.runId,
        config,
        abortSignal: bindAbortSignal(attempt.abortSignal),
        assertCurrent: () => {
          assertActive();
          if (
            attempt.userTurnTranscriptRecorder !== recorder ||
            !isDeepStrictEqual(attempt.sessionTarget, sessionTarget) ||
            (sessionTarget?.agentId !== undefined && sessionTarget.agentId !== attempt.agentId) ||
            (sessionTarget?.sessionId !== undefined &&
              sessionTarget.sessionId !== attempt.sessionId) ||
            (sessionTarget?.sessionKey !== undefined &&
              sessionTarget.sessionKey !== attempt.sessionKey)
          ) {
            throw new Error("native prompt annotation lost its source execution claim");
          }
        },
      })
    : undefined;
}
