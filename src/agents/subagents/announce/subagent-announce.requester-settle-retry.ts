/** Retry and final-attempt decisions for requester settle wakes that did not deliver. */
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveExternalBestEffortDeliveryTarget } from "../../../infra/outbound/best-effort-delivery.js";
import { logWarn } from "../../../logger.js";
import type { DeliveryContext } from "../../../utils/delivery-context.types.js";
import { deliverMissingReplyGroupNotice } from "./subagent-announce-completion-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export const REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS = 3;
export const REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS = [30_000, 120_000] as const;

type MissingReplyNoticeTarget = {
  cfg: OpenClawConfig;
  requesterSessionKey: string;
  requesterAgentId?: string;
  directIdempotencyKey: string;
  directOrigin?: DeliveryContext;
  signal?: AbortSignal;
  isSourceSessionEffectsAllowed: () => boolean;
};

export type SettleWakeAttemptFailure =
  | { final: SubagentAnnounceDeliveryResult; retry?: undefined }
  | {
      final?: undefined;
      retry: { attemptCount: number; nextAttemptAt: number; lastError: string };
    };

/**
 * Schedules the next attempt, or closes the batch after the last one. A channel
 * requester whose completion turns all stayed silent gets one content-free notice
 * so a finished child result is not lost without a visible trace.
 */
export async function resolveSettleWakeAttemptFailure(params: {
  attemptIndex: number;
  delivery: SubagentAnnounceDeliveryResult;
  missingReplyNotice?: MissingReplyNoticeTarget;
}): Promise<SettleWakeAttemptFailure> {
  const { attemptIndex, delivery } = params;
  const attemptCount = attemptIndex + 1;
  const retryDelayMs = REQUESTER_SETTLE_WAKE_RETRY_DELAYS_MS[attemptIndex];
  const lastError = delivery.error ?? delivery.reason ?? "undelivered";
  if (attemptCount < REQUESTER_SETTLE_WAKE_MAX_ATTEMPTS && retryDelayMs !== undefined) {
    logWarn(
      `requester settle wake attempt ${attemptCount} failed; retrying in ${Math.round(retryDelayMs / 1000)}s: ${lastError}`,
    );
    return { retry: { attemptCount, nextAttemptAt: Date.now() + retryDelayMs, lastError } };
  }
  const notice = params.missingReplyNotice;
  if (notice && delivery.reason === "visible_reply_missing") {
    const { directOrigin, ...target } = notice;
    const posted = await deliverMissingReplyGroupNotice({
      ...target,
      deliveryTarget: resolveExternalBestEffortDeliveryTarget({
        channel: directOrigin?.channel,
        to: directOrigin?.to,
        accountId: directOrigin?.accountId,
        threadId: directOrigin?.threadId,
      }),
    });
    if (posted?.delivered) {
      logWarn(
        `requester settle wake attempts exhausted without a visible reply; posted a missing-result notice: ${lastError}`,
      );
    }
  }
  // The child result itself stays undelivered; a notice is only a trace.
  return { final: { ...delivery, error: lastError } };
}
