import type { ReplyMessageInjectionOptions } from "../../auto-reply/reply/reply-run-registry.contracts.js";
import { resolveActiveReplyOperationForSessionId } from "../../auto-reply/reply/reply-run-registry.js";
import { getAttachedBackend } from "../../auto-reply/reply/reply-run-registry.state.js";
import {
  ACTIVE_EMBEDDED_RUNS,
  EMBEDDED_RUN_WAITERS,
  type EmbeddedRunWaiter,
  type EmbeddedAgentQueueMessageOutcome,
} from "./run-state.js";

/** Settlement belongs to the exact receiving run, independently of the source's injection dialect. */
export async function queueEmbeddedAgentMessageWithCustody(
  sessionId: string,
  text: string,
  options: ReplyMessageInjectionOptions | undefined,
  dispatch: (
    sessionId: string,
    text: string,
    options?: ReplyMessageInjectionOptions,
    canInject?: () => boolean,
  ) => Promise<EmbeddedAgentQueueMessageOutcome>,
  canInject?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome> {
  const handle = ACTIVE_EMBEDDED_RUNS.get(sessionId);
  const onQueueSettled = options?.onQueueSettled;
  if (!handle || !onQueueSettled) {
    return dispatch(sessionId, text, options, canInject);
  }
  // Bind custody before dispatch: a backend can accept synchronously, then end
  // without reporting per-input settlement. Never follow a same-session successor.
  const waiters = EMBEDDED_RUN_WAITERS.get(sessionId) ?? new Set<EmbeddedRunWaiter>();
  const operation = resolveActiveReplyOperationForSessionId(sessionId);
  const abortSignal =
    operation && getAttachedBackend(operation) === handle ? operation.abortSignal : undefined;
  let settled = false;
  const close = (notify: boolean) => {
    if (settled) {
      return;
    }
    settled = true;
    waiters.delete(waiter);
    if (waiters.size === 0 && EMBEDDED_RUN_WAITERS.get(sessionId) === waiters) {
      EMBEDDED_RUN_WAITERS.delete(sessionId);
    }
    abortSignal?.removeEventListener("abort", settle);
    if (notify) {
      onQueueSettled();
    }
  };
  const settle = () => close(true);
  const waiter: EmbeddedRunWaiter = { handle, resolve: settle, settleOnAbort: true };
  waiters.add(waiter);
  EMBEDDED_RUN_WAITERS.set(sessionId, waiters);
  abortSignal?.addEventListener("abort", settle, { once: true });
  if (abortSignal?.aborted || handle.isAborted?.()) {
    settle();
  }
  try {
    const outcome = await dispatch(
      sessionId,
      text,
      { ...options, onQueueSettled: settle },
      canInject,
    );
    if (!outcome.queued) {
      // Admission can retry without transcript waiting; rejection never owns custody.
      close(false);
    }
    return outcome;
  } catch (error) {
    close(false);
    throw error;
  }
}
