import {
  collectNestedErrorCandidates,
  extractErrorCode,
} from "@openclaw/normalization-core/error-coercion";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { sanitizePendingFinalDeliveryText } from "../../../auto-reply/reply/pending-final-delivery-state.js";
import { appendAssistantMessageToSessionTranscript } from "../../../config/sessions/transcript.js";
import { deliverCompletionDirect } from "./subagent-announce-completion-delivery.js";
import type { SubagentAnnounceDeliveryResult } from "./subagent-announce-dispatch.js";

export function isRequesterSettleWatchdogFailure(error: unknown): boolean {
  return collectNestedErrorCandidates(error).some(
    (candidate) => extractErrorCode(candidate) === "OPENCLAW_SESSION_WATCHDOG",
  );
}

/** The accepted turn may already have performed external effects. Publish only its retained result. */
export async function deliverRequesterStallFallback(params: {
  requesterSessionKey: string;
  requesterSessionId: string;
  requesterLifecycleRevision?: string;
  requesterAgentId?: string;
  requesterStorePath?: string;
  idempotencyKey: string;
  findings?: string;
  directDelivery?: Pick<
    Parameters<typeof deliverCompletionDirect>[0],
    "cfg" | "deliveryTarget" | "signal"
  >;
  assertCurrent: () => void;
}): Promise<SubagentAnnounceDeliveryResult> {
  const text =
    params.findings === undefined
      ? "The follow-up turn stalled. I did not rerun it. The delegated results are retained privately; this notice does not include their contents."
      : [
          "The follow-up turn stalled. I did not rerun it. The retained delegated-work results are below.",
          sanitizePendingFinalDeliveryText(params.findings),
        ].join("\n\n");
  params.assertCurrent();
  if (params.directDelivery) {
    const result = await deliverCompletionDirect({
      ...params.directDelivery,
      requesterSessionKey: params.requesterSessionKey,
      requesterSessionId: params.requesterSessionId,
      requesterLifecycleRevision: params.requesterLifecycleRevision,
      requesterAgentId: params.requesterAgentId,
      directIdempotencyKey: params.idempotencyKey,
      contentKind: "completed_result",
      preparedNotice: text,
      isSourceSessionEffectsAllowed: () => {
        params.assertCurrent();
        return true;
      },
    });
    if (result) {
      return result.disposition === "retryable" && !result.reason
        ? { ...result, reason: "visible_reply_missing" }
        : result;
    }
    // No direct route (thread, group, channel) sent nothing; keep the notice visible in history.
  }
  try {
    const result = await appendAssistantMessageToSessionTranscript({
      sessionKey: params.requesterSessionKey,
      expectedSessionId: params.requesterSessionId,
      expectedLifecycleRevision: params.requesterLifecycleRevision ?? null,
      agentId: params.requesterAgentId,
      storePath: params.requesterStorePath,
      idempotencyKey: params.idempotencyKey,
      text,
      // This is a public terminal result, not another hidden requester-processing reply.
      beforeMessageWrite: ({ message }) => ({ ...message, display: true }),
      assertCurrent: params.assertCurrent,
    });
    if (result.ok) {
      return {
        delivered: true,
        path: "direct",
        requesterVisibleFinalDelivered: true,
        finalAssistantVisibleText: truncateUtf16Safe(text, 12_000),
      };
    }
  } catch {
    // Revoked ownership must not be converted into a retry owned by this attempt.
    params.assertCurrent();
  }
  return {
    delivered: false,
    path: "none",
    disposition: "retryable",
    reason: "visible_reply_missing",
    error: "The retained subagent results could not be appended to the requester transcript.",
  };
}
