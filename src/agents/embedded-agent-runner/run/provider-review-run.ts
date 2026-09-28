import { resolveSessionWorkStartError } from "../../../config/sessions/lifecycle.js";
import { captureAgentRunProviderReview } from "../../../sessions/provider-review-terminal.js";
import {
  assertSessionProviderReviewWorkStart,
  claimProviderReviewAttempt,
  createSessionProviderReview,
  readProviderReviewAcknowledgment,
  recordSessionProviderReview,
  type ProviderReviewTarget,
} from "../../../sessions/provider-review.js";
import { isIncognitoSessionKey } from "../../../shared/incognito-session-key.js";
import { classifyAgentRunTerminalOutcome } from "../../agent-run-terminal-outcome.js";
import { FailoverError } from "../../failover/error.js";
import { recordModelFallbackStop } from "../../model-fallback-stop.js";
import { createAgentRunDirectAbortError } from "../../run-termination.js";
import type { EmbeddedAgentRunResult } from "../types.js";
import type { PreparedEmbeddedRunInput } from "./execution-context.js";
import { resolveProviderRefusal } from "./provider-refusal.js";
import type { prepareEmbeddedRunRuntime } from "./runtime-preparation.js";
import type { createEmbeddedRunSessionPromptState } from "./session-prompt-state.js";
import { resolveEmbeddedRunAttemptTerminalOutcome } from "./terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "./types.js";

/** Owns review admission, one physical attempt, and refusal recording for the logical run. */
export function createProviderReviewRun(input: {
  run: PreparedEmbeddedRunInput;
  runtime: Awaited<ReturnType<typeof prepareEmbeddedRunRuntime>>;
  session: Awaited<ReturnType<typeof createEmbeddedRunSessionPromptState>>;
  assertCurrent: (() => void) | undefined;
}) {
  const { run, runtime, session } = input;
  const params = run.runParams;
  const acknowledgment = params.providerReviewAcknowledgment;
  function stop(error: Error): never {
    recordModelFallbackStop(error);
    throw error;
  }
  const target = (sessionId: string): ProviderReviewTarget => {
    const current = session.sessionTarget;
    if (!current?.agentId || !current.sessionKey || !current.storePath || !input.assertCurrent) {
      return stop(
        new Error("Provider precaution requires current run authority and session identity"),
      );
    }
    return {
      agentId: current.agentId,
      sessionKey: current.sessionKey,
      storePath: current.storePath,
      sessionId,
      lifecycleRevision:
        session.sessionWriterFence?.expectedLifecycleRevision ??
        run.sessionAdmission?.entry.lifecycleRevision,
    };
  };
  const assertCurrent = () => {
    if (!input.assertCurrent) {
      stop(new Error("Provider precaution requires current run authority"));
    }
    input.assertCurrent();
  };
  const failure = (cause?: unknown) => {
    if (!acknowledgment) {
      return;
    }
    let error =
      cause instanceof Error
        ? cause
        : cause === undefined
          ? undefined
          : new Error("Provider continuation failed", { cause });
    try {
      readProviderReviewAcknowledgment(acknowledgment);
    } catch (revoked) {
      error ??= new Error(
        "Provider continuation stopped; review the current findings before trying again",
        { cause: revoked },
      );
    }
    if (error) {
      stop(error);
    }
  };
  return {
    async admit(): Promise<void> {
      const entry = run.sessionAdmission?.entry;
      const unavailable =
        entry?.providerReview &&
        resolveSessionWorkStartError(run.resolvedSessionKey, entry, {
          providerReviewAcknowledgment: acknowledgment,
          runId: params.runId,
        });
      if (unavailable) {
        stop(new Error(unavailable));
      }
      if (!acknowledgment) {
        return;
      }
      const snapshot = runtime.snapshot();
      try {
        await assertSessionProviderReviewWorkStart({
          target: target(session.sessionId),
          acknowledgment,
          runId: params.runId,
          provider: runtime.provider,
          model: runtime.modelId,
          runtimeId: snapshot.agentHarness.id,
          api: snapshot.effectiveModel.api,
          assertCurrent,
        });
      } catch (cause) {
        stop(new Error("Provider review continuation is no longer admitted", { cause }));
      }
    },
    beginAttempt(): void {
      if (acknowledgment) {
        try {
          claimProviderReviewAttempt(acknowledgment, params.runId);
        } catch (cause) {
          stop(new Error("Provider review continuation cannot start another attempt", { cause }));
        }
      }
    },
    failure,
    async settle(attempt: EmbeddedRunAttemptResult) {
      const assistant = attempt.currentAttemptCompletedAssistant ?? attempt.currentAttemptAssistant;
      const refusal = resolveProviderRefusal(assistant);
      if (
        refusal?.category === "misalignment" &&
        assistant?.stopReason === "error" &&
        params.sessionPersistence !== "detached"
      ) {
        const ownedTarget = target(attempt.sessionIdUsed);
        const snapshot = runtime.snapshot();
        try {
          const recording = {
            target: ownedTarget,
            refusal: {
              runId: params.runId,
              ...(attempt.runtimeModelSelection ?? {
                provider: runtime.provider,
                model: runtime.modelId,
              }),
              runtimeId: snapshot.agentHarness.id,
              api: snapshot.effectiveModel.api,
              review: refusal.review,
              nativeThreadId: refusal.nativeThreadId,
              nativeTurnId: refusal.nativeTurnId,
            },
            assertCurrent,
          };
          if (isIncognitoSessionKey(ownedTarget.sessionKey)) {
            captureAgentRunProviderReview({
              runId: params.runId,
              target: ownedTarget,
              review: createSessionProviderReview({
                sessionId: ownedTarget.sessionId,
                refusal: recording.refusal,
              }),
              expectedWriterRunId: session.sessionWriterFence?.expectedWriterRunId ?? params.runId,
              assertCurrent,
            });
          } else {
            await recordSessionProviderReview(recording);
          }
          assertCurrent();
        } catch (cause) {
          stop(
            new Error("The provider paused this session, but its findings could not be saved", {
              cause,
            }),
          );
        } finally {
          try {
            const { clearSessionQueues } =
              await import("../../../auto-reply/reply/queue/cleanup.js");
            assertCurrent();
            clearSessionQueues([ownedTarget.sessionKey, attempt.sessionIdUsed]);
          } catch (cause) {
            stop(new Error("Provider precaution queue settlement did not complete", { cause }));
          }
        }
      }
      if (acknowledgment) {
        const outcome = resolveEmbeddedRunAttemptTerminalOutcome({
          attempt,
          assistant,
          abortSignal: params.abortSignal,
        });
        const classification = classifyAgentRunTerminalOutcome(outcome);
        const error =
          classification === "success"
            ? undefined
            : params.abortSignal?.aborted && params.abortSignal.reason instanceof Error
              ? params.abortSignal.reason
              : classification === "cancellation"
                ? createAgentRunDirectAbortError()
                : classification === "timeout"
                  ? new FailoverError(outcome.error ?? "Provider continuation timed out", {
                      reason: "timeout",
                      timeout: {
                        timeoutPhase: outcome.timeoutPhase,
                        providerStarted: outcome.providerStarted,
                      },
                    })
                  : new Error(
                      "Provider continuation failed; review its result before trying again",
                    );
        failure(error);
      }
      return refusal;
    },
    finish(result: EmbeddedAgentRunResult): EmbeddedAgentRunResult {
      return acknowledgment
        ? {
            ...result,
            meta: {
              ...result.meta,
              modelFallbackStopReason:
                result.meta.modelFallbackStopReason ?? "provider_review_continuation",
            },
          }
        : result;
    },
  };
}
