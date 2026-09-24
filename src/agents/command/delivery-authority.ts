// Authority checks at final platform handoff and restart-only transport cancellation.
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { AGENT_RUN_RESTART_ABORT_ERROR, isAgentRunRestartAbortReason } from "../run-termination.js";

export function createRestartOnlyAbortSignal(source: AbortSignal | undefined): {
  signal?: AbortSignal;
  dispose: () => void;
} {
  if (!source) {
    return { dispose: () => {} };
  }
  const controller = new AbortController();
  const onAbort = () => {
    if (isAgentRunRestartAbortReason(source.reason)) {
      controller.abort(source.reason);
    }
  };
  if (source.aborted) {
    onAbort();
  } else {
    source.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    dispose: () => source.removeEventListener("abort", onAbort),
  };
}

export function createAgentCommandDeliveryGuard(params: {
  opts: { abortSignal?: AbortSignal };
  assertDeliveryCurrent?: () => void;
}): () => void {
  return () => {
    try {
      params.assertDeliveryCurrent?.();
    } catch (error) {
      const retryable =
        isAgentRunRestartAbortReason(error) ||
        (isSessionWorkStartInvalidatedError(error) &&
          isAgentRunRestartAbortReason(params.opts.abortSignal?.reason));
      // Assertions precede I/O; only restart retirement preserves durable custody.
      throw new PlatformMessageNotDispatchedError(
        retryable ? AGENT_RUN_RESTART_ABORT_ERROR : "Agent final delivery custody was revoked",
        { cause: error, retryable },
      );
    }
  };
}
