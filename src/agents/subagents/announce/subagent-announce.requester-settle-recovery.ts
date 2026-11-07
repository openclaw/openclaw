import type { OpenClawConfig } from "../../../config/config.js";
import { isInternalMessageChannel } from "../../../utils/message-channel.js";
import { hasAnnounceSendEvidence } from "./subagent-announce-delivery-retry.js";
import { resolveExternalBestEffortDeliveryTarget } from "./subagent-announce-delivery.runtime.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";
import { deliverRequesterStallFallback } from "./subagent-announce.requester-settle-fallback.js";
import {
  REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS,
  resolveRequesterSettleRetryState,
  type RequesterSettleWakeBatchState,
} from "./subagent-announce.requester-settle-state.js";

/** Settle delivery-only recovery through the requester's existing state and authority owners. */
export async function settleRequesterStallFallback(
  params: Omit<
    Parameters<typeof deliverRequesterStallFallback>[0],
    "directDelivery" | "assertCurrent"
  > & {
    cfg: OpenClawConfig;
    requesterDepth: number;
    origin?: Parameters<typeof resolveExternalBestEffortDeliveryTarget>[0];
    signal?: AbortSignal;
    state: RequesterSettleWakeBatchState;
    isCurrent: () => boolean;
    settleRevoked: () => Promise<boolean>;
    transition: (state: RequesterSettleWakeBatchState) => void | Promise<void>;
    complete: (
      state: RequesterSettleWakeBatchState,
      delivery: SubagentAnnounceDeliveryResult,
    ) => Promise<void>;
  },
): Promise<boolean> {
  const recoveryState = params.state;
  if (
    recoveryState.requesterStallFallback === "external" &&
    recoveryState.status === "dispatching"
  ) {
    await params.complete(recoveryState, {
      delivered: false,
      path: "direct",
      disposition: "ambiguous",
      error:
        "External requester-stall recovery was interrupted after admission; delivery is unconfirmed and the retained results were not resent.",
    });
    return false;
  }
  const directDelivery =
    params.requesterDepth === 0 &&
    params.origin?.channel &&
    !isInternalMessageChannel(params.origin.channel)
      ? {
          cfg: params.cfg,
          deliveryTarget: resolveExternalBestEffortDeliveryTarget(params.origin),
          signal: params.signal,
        }
      : undefined;
  const fallbackState = {
    ...recoveryState,
    requesterStallFallback: directDelivery ? ("external" as const) : ("transcript" as const),
    status: "dispatching" as const,
    // An admitted stall gets its own bounded budget; parent attempts cannot exhaust it.
    attemptCount: recoveryState.requesterStallFallback ? recoveryState.attemptCount + 1 : 1,
    nextAttemptAt: undefined,
  };
  await params.transition(fallbackState);
  let fallback: SubagentAnnounceDeliveryResult;
  try {
    fallback = await deliverRequesterStallFallback({
      ...params,
      directDelivery,
      assertCurrent: () => {
        if (!params.isCurrent()) {
          throw new Error("Requester completion ownership changed before stall fallback.");
        }
      },
    });
  } catch (error) {
    if (await params.settleRevoked()) {
      return false;
    }
    fallback = {
      delivered: false,
      path: "none",
      disposition: hasAnnounceSendEvidence(error) ? "ambiguous" : "permanent_failure",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (fallback.delivered) {
    await params.complete(fallbackState, fallback);
    return true;
  }
  if (await params.settleRevoked()) {
    return false;
  }
  const retryState = resolveRequesterSettleRetryState({
    state: fallbackState,
    delivery: fallback,
    attemptCount: fallbackState.attemptCount,
    // Only the fallback delivery retries; the public parent remains spent.
    parentOnly: false,
    now: Date.now(),
  });
  if (retryState) {
    await params.transition(retryState);
  } else {
    await params.complete(fallbackState, {
      ...fallback,
      disposition:
        fallback.disposition === "retryable" ? "permanent_failure" : fallback.disposition,
      error: `Requester-stall recovery ${fallbackState.attemptCount >= REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS ? "exhausted" : "failed"}; child results retained. ${fallback.error ?? fallback.reason ?? "Delivery was not confirmed."}`,
    });
  }
  return false;
}
