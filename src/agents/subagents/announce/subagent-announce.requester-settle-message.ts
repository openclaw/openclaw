import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import {
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION,
} from "../completion/subagent-completion-instructions.js";
import type { SubagentRunRecord } from "../registry/subagent-registry.types.js";
import {
  buildSubagentRestartRecoveryRoster,
  SUBAGENT_RESTART_RECOVERY_INSTRUCTION,
} from "../subagent-restart-recovery-prompt.js";

const REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS = 1_024;
const ROUTE_NOTICE_TRUNCATION = "\n[model-route changes truncated]";

export function buildRequesterSettleWakeMessage(params: {
  findings?: string;
  requireVisibleReply: boolean;
  parentOnly?: boolean;
  children: readonly SubagentRunRecord[];
  recoveryChildren: readonly SubagentRunRecord[];
  preserveModelRouteNotice: boolean;
}): string {
  // The scheduling row need not be the rerouted child. Keep every current
  // child's producer-owned notice, with stable bytes and one batch-wide cap.
  const routeNotices = [
    ...new Set(
      params.children.flatMap(({ completion }) => {
        const reply = completion?.terminalReply;
        return reply?.disposition === "visible" && reply.modelRouteChange
          ? [reply.modelRouteChange]
          : [];
      }),
    ),
  ]
    .toSorted()
    .join("\n");
  const modelRouteChange =
    routeNotices.length > REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS
      ? `${truncateUtf16Safe(routeNotices, REQUESTER_SETTLE_WAKE_ROUTE_NOTICE_MAX_CHARS - ROUTE_NOTICE_TRUNCATION.length)}${ROUTE_NOTICE_TRUNCATION}`
      : routeNotices;
  const recoveryRoster = buildSubagentRestartRecoveryRoster(params.recoveryChildren);
  return [
    "[Subagent Context] Every subagent in this batch has now settled, including its descendants.",
    "[Subagent Context] Do not keep waiting or call sessions_yield again for this batch; no further completion events will arrive for it. Other batches may still be running.",
    // Private completion guidance already includes the shared outcome policy.
    ...(params.parentOnly ? [] : [`[Subagent Context] ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`]),
    ...(recoveryRoster
      ? [`[Subagent Context] ${SUBAGENT_RESTART_RECOVERY_INSTRUCTION}`, recoveryRoster]
      : []),
    params.parentOnly
      ? `[Subagent Context] ${SUBAGENT_PRIVATE_COMPLETION_INSTRUCTION}`
      : params.requireVisibleReply
        ? "[Subagent Context] Child completion delivery is internal; the original user request still requires your visible final answer only after the requested outcome is complete or genuinely blocked."
        : "[Subagent Context] Review the settled results and continue any unfinished work. Avoid repeating a consolidated final answer that was already delivered.",
    ...(modelRouteChange
      ? [
          modelRouteChange,
          params.preserveModelRouteNotice
            ? "[Subagent Context] Preserve this runtime-authored model-route change notice in your final answer."
            : "[Subagent Context] Keep this runtime-authored model-route change notice internal on this shared surface.",
        ]
      : []),
    "",
    params.findings ??
      "(each child result was announced individually in earlier completion events)",
  ].join("\n");
}
