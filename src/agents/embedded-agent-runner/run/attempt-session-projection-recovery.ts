import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import {
  recoverSessionTranscriptProjection,
  type SessionTranscriptRuntimeTarget,
} from "../../../config/sessions/session-accessor.js";
import { isSessionTranscriptProjectionUnavailableError } from "../../../config/sessions/session-transcript-projection-error.js";
import { DEFAULT_AGENT_TIMEOUT_MS } from "../../timeout.js";
import { outsideExecutionCapacity } from "./execution-capacity.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

/** Retry one admitted open after its projection rebuild, outside transcript write custody. */
export async function openSessionAfterProjectionRecovery<T>(input: {
  open: () => Promise<T>;
  target: SessionTranscriptRuntimeTarget;
  timeoutMs: number;
  signal: AbortSignal;
  assertCurrent: () => void;
  replyOperation?: EmbeddedRunAttemptParams["replyOperation"];
}): Promise<T> {
  input.signal.throwIfAborted();
  try {
    return await input.open();
  } catch (error) {
    if (
      !isSessionTranscriptProjectionUnavailableError(error) ||
      error.reason !== "rebuilding" ||
      error.sessionId !== input.target.sessionId
    ) {
      throw error;
    }
    input.assertCurrent();
    input.signal.throwIfAborted();
    input.replyOperation?.markWaitingForDeferredMaintenance();
    try {
      await outsideExecutionCapacity(async () => {
        const deadline = new AbortController();
        const recoveryBudgetMs =
          input.timeoutMs >= MAX_TIMER_TIMEOUT_MS
            ? DEFAULT_AGENT_TIMEOUT_MS
            : Math.max(1, input.timeoutMs);
        const timer = setTimeout(() => deadline.abort(error), recoveryBudgetMs);
        timer.unref();
        try {
          await recoverSessionTranscriptProjection(
            input.target,
            AbortSignal.any([input.signal, deadline.signal]),
            input.assertCurrent,
          );
        } finally {
          clearTimeout(timer);
        }
      });
    } catch (waitError) {
      input.assertCurrent();
      input.signal.throwIfAborted();
      if (
        waitError === error ||
        (waitError instanceof Error && waitError.name === "AbortError" && waitError.cause === error)
      ) {
        throw error;
      }
      throw waitError;
    } finally {
      input.replyOperation?.markDeferredMaintenanceWaitEnded();
    }
    input.assertCurrent();
    input.signal.throwIfAborted();
    return await input.open();
  }
}
