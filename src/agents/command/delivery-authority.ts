// Authority checks at final platform handoff and restart-only transport cancellation.
import { CommandOwnerRevokedError } from "../../auto-reply/command-owner-authority.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import { isAgentRunRestartAbortReason } from "../run-termination.js";

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
      const restart = isAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
      const retryable =
        !(error instanceof CommandOwnerRevokedError) &&
        (restart ||
          (!params.opts.abortSignal?.aborted && !isSessionWorkStartInvalidatedError(error)));
      // Assertions precede I/O: read failures retain custody; revocation does not.
      throw new PlatformMessageNotDispatchedError(
        error instanceof Error ? error.message : "Agent final delivery source check failed",
        { cause: error, retryable },
      );
    }
  };
}
