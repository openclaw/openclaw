import { randomUUID } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { findSessionTranscriptReadFenceError } from "openclaw/plugin-sdk/context-engine-transcript-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isIncognitoSessionKey } from "openclaw/plugin-sdk/routing";
import { listWorkshopChanges } from "openclaw/plugin-sdk/skill-workshop-host-runtime";
import { resolveSkillWorkshopConfig } from "./config.js";
import { buildSkillExperienceReviewPrompt } from "./experience-review-prompt.js";
import type { ExperienceReviewCandidate } from "./experience-review-scheduler.js";
import { postWorkshopChangeNotice } from "./review-outcome.js";
import { workshopReviewRunId } from "./review-undo.js";
import { getWorkshopRuntime, readWorkshopRuntimeConfig } from "./runtime.js";

const REVIEW_TOOLS = ["skill_workshop"] as const;
// How often a running review rereads the live learning mode; turning learning off stops it.
const LEARNING_MODE_POLL_MS = 1_000;

/** An expected cancellation: the operator turned learning off while the review ran. */
function learningTurnedOff(): Error {
  return Object.assign(new Error("Skill Workshop was turned off during review."), {
    name: "AbortError",
  });
}

/**
 * Runs one background review as a hidden fork of the finished turn, with only this plugin's
 * `skill_workshop` tool. The fork owner admits it against the session's tool policy, reads the
 * anchored turn's requester, model and workspace, and fences it to that session generation.
 */
export async function runSkillExperienceReview(
  candidate: ExperienceReviewCandidate,
  options: { abortSignal?: AbortSignal } = {},
): Promise<void> {
  const { source } = candidate;
  // Learning may have been turned off, or the session made incognito, while the review waited.
  const config: OpenClawConfig = readWorkshopRuntimeConfig();
  if (
    isIncognitoSessionKey(source.sessionKey) ||
    resolveSkillWorkshopConfig(config).autonomous.mode === "off"
  ) {
    return;
  }
  const runtime = getWorkshopRuntime();
  // The notice needs the session's store; the fork reports the generation it admitted.
  const current = await runtime.system.captureSessionGeneration({
    agentId: source.agentId,
    sessionKey: source.sessionKey,
  });
  if (!current || current.sessionId !== source.sessionId) {
    return;
  }
  const runId = workshopReviewRunId(randomUUID());
  // The operator may turn learning off mid-review: stop the model run, not only its writes.
  const learningOff = new AbortController();
  const pollLearningMode = setInterval(() => {
    if (resolveSkillWorkshopConfig(readWorkshopRuntimeConfig()).autonomous.mode === "off") {
      learningOff.abort(learningTurnedOff());
    }
  }, LEARNING_MODE_POLL_MS);
  pollLearningMode.unref?.();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, learningOff.signal])
    : learningOff.signal;
  try {
    // Settlement runs inside the fork's detached admission, so a graceful restart waits for the
    // notice of skills the review already committed.
    await runtime.subagent.runForkedTurn({
      sessionKey: source.sessionKey,
      through: { sessionId: source.sessionId, entryId: source.entryId },
      prompt: buildSkillExperienceReviewPrompt({
        ...candidate,
        propose: resolveSkillWorkshopConfig(config).autonomous.mode === "propose",
      }),
      tools: REVIEW_TOOLS,
      runId,
      // The fork's 120 s is a default; a review gets the agent's own run timeout.
      timeoutMs: runtime.agent.resolveAgentTimeoutMs({ cfg: config }),
      signal,
      onSettled: async (outcome) => {
        const reviewFailure: unknown = outcome.ok ? undefined : outcome.error;
        // Each skill_workshop call commits on its own, so a failed or aborted run may have changed
        // skills. Cleanup always runs after the stop, and its independent failure must stay visible
        // to the scheduler instead of being classified as part of the cancellation.
        let cleanupFailure: unknown;
        try {
          const changes = await listWorkshopChanges(source.agentId, { runId });
          if (outcome.source) {
            // A Gateway reset keeps the sessionId and rotates the lifecycle revision; the notice is
            // posted only to the generation the review read.
            await postWorkshopChangeNotice({
              config: readWorkshopRuntimeConfig(),
              generation: { ...current, ...outcome.source },
              runId,
              changes,
            });
          }
        } catch (error) {
          cleanupFailure = error;
        }
        if (cleanupFailure !== undefined) {
          // Cleanup failure identity survives even when the model succeeded. Do not throw it bare:
          // an aborted controller would classify a plain error as expected cancellation.
          throw reviewFailure === undefined
            ? new AggregateError([cleanupFailure], "Skill experience review cleanup failed")
            : new AggregateError(
                [reviewFailure, cleanupFailure],
                "Skill experience review and its cleanup failed",
              );
        }
        if (!outcome.ok) {
          if (learningOff.signal.aborted) {
            throw learningOff.signal.reason;
          }
          // Keep the host's bounded mismatch diagnostic through its authority wrapper and the
          // plugin's settlement.
          const transcriptFence = findSessionTranscriptReadFenceError(outcome.error);
          if (transcriptFence) {
            throw transcriptFence;
          }
          if (outcome.cancelled || options.abortSignal?.aborted) {
            // The model aborts with a plain error; normalize the outcome so the scheduler reports
            // an expected cancellation rather than a review failure.
            throw Object.assign(new Error("Skill experience review was stopped by the user."), {
              name: "AbortError",
            });
          }
          throw outcome.error instanceof Error
            ? outcome.error
            : new Error(formatErrorMessage(outcome.error));
        }
      },
    });
  } finally {
    clearInterval(pollLearningMode);
  }
  // A `refused` result means the session's tool policy hides skill_workshop: nothing ran.
}
