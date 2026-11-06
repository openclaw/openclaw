// Authority checks at final platform handoff and restart-only transport cancellation.
import {
  CommandOwnerRevokedError,
  type CommandOwnerAssertion,
} from "../../auto-reply/command-owner-authority.js";
import { isSessionWorkStartInvalidatedError } from "../../config/sessions/lifecycle.js";
import {
  prepareSessionSourceScope,
  releaseSessionSourceAuthorities,
  type PreparedSessionSourceAuthority,
  type SessionSourceAssertion,
} from "../../config/sessions/session-source-authority.js";
import { SESSION_WORK_START_INVALIDATED_ERROR_CODE } from "../../config/sessions/work-start-error.js";
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

export function createAgentCommandDeliveryGuard(
  params: { opts: { abortSignal?: AbortSignal }; assertDeliveryCurrent?: SessionSourceAssertion },
  completion?: { commandOwnerReference?: CommandOwnerAssertion["recoveryReference"] },
): (() => void) & { prepare: () => Promise<void>; release: () => Promise<void> } {
  let prepared: PreparedSessionSourceAuthority | undefined;
  const release = async () => {
    const previous = prepared;
    prepared = undefined;
    if (previous) {
      await releaseSessionSourceAuthorities([previous]);
    }
  };
  const rethrowDeliveryError = (error: unknown): never => {
    // Only known restart retirement transfers custody. Recovery cannot repeat
    // an unreadable or changed source assertion after its live closure is gone.
    const retryable =
      isAgentRunRestartAbortReason(error) ||
      (isAgentRunRestartAbortReason(params.opts.abortSignal?.reason) &&
        completion?.commandOwnerReference != null &&
        (error instanceof CommandOwnerRevokedError ||
          (isSessionWorkStartInvalidatedError(error) &&
            error.code === SESSION_WORK_START_INVALIDATED_ERROR_CODE)));
    throw new PlatformMessageNotDispatchedError(
      error instanceof Error ? error.message : "Agent final delivery source check failed",
      { cause: error, retryable },
    );
  };
  const assertCurrent = () => {
    try {
      if (prepared) {
        prepared.assertCurrent();
      } else {
        params.assertDeliveryCurrent?.();
      }
    } catch (error) {
      rethrowDeliveryError(error);
    }
  };
  return Object.assign(assertCurrent, {
    prepare: async () => {
      await release();
      try {
        // Queue receipts precede this hook, so each dispatch prepares its own source facts.
        prepared = await prepareSessionSourceScope(params.assertDeliveryCurrent);
      } catch (error) {
        rethrowDeliveryError(error);
      }
      assertCurrent();
    },
    release,
  });
}
