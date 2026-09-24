// Authority checks at final platform handoff and restart-only transport cancellation.
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import { PlatformMessageNotDispatchedError } from "../../infra/outbound/deliver-types.js";
import {
  AGENT_RUN_RESTART_ABORT_ERROR,
  isAgentRunRestartAbortReason,
  throwAgentRunRestartAbortReason,
} from "../run-termination.js";
import type { AgentCommandOpts } from "./types.js";

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
  opts: Pick<AgentCommandOpts, "abortSignal">;
  assertDeliveryCurrent?: () => void;
}): () => void {
  return () => {
    try {
      // Restart may retire source authority while the durable final is still owed.
      throwAgentRunRestartAbortReason(params.opts.abortSignal?.reason);
      params.assertDeliveryCurrent?.();
    } catch (error) {
      if (isAgentRunRestartAbortReason(error)) {
        // Restart retires this sender, not the captured final's durable owner.
        throw new PlatformMessageNotDispatchedError(AGENT_RUN_RESTART_ABORT_ERROR, {
          cause: error,
        });
      }
      if (!isSessionWorkStartInvalidatedError(error)) {
        throw error;
      }
      // Revoked task/session custody cannot leave a stale final queued for
      // retry after this process-local assertion disappears.
      throw new PlatformMessageNotDispatchedError("Agent final delivery custody was revoked", {
        cause: error,
        retryable: false,
      });
    }
  };
}
