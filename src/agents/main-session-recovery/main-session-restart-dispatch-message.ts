import { sanitizePendingFinalDeliveryText } from "../../auto-reply/reply/pending-final-delivery-state.js";
import type { InternalSessionEntry as SessionEntry } from "../../config/sessions.js";
import { resolveRestartRecoveryChannelAuthority } from "../../config/sessions/restart-recovery-state.js";
import { isTrustedMessageActionTurnIngress } from "../../gateway/message-action-turn-capability.js";
import { formatSystemTurnPrompt } from "../../sessions/system-turn-prompt.js";
import { SUBAGENT_RESTART_RECOVERY_INSTRUCTION } from "../subagents/subagent-restart-recovery-prompt.js";
import { TOOL_FAILURE_INSTRUCTION } from "../tool-outcome-instructions.js";

const RESTART_RECOVERY_RESUME_MESSAGE = formatSystemTurnPrompt(
  "Your previous turn was interrupted by a gateway restart while " +
    "OpenClaw was waiting on tool/model work. The restart did not cancel the user's task. " +
    "Continue from the existing transcript: check the current state, recover interrupted work, " +
    "and finish the task without asking the user to repeat the request. " +
    `${SUBAGENT_RESTART_RECOVERY_INSTRUCTION} Treat a tool result ` +
    "marked interrupted or missing as having an unknown outcome; verify what happened before " +
    `repeating an action. ${TOOL_FAILURE_INSTRUCTION}`,
);

const RESTART_SAFE_TOOLS_NOTICE =
  "For this turn only, the tool surface has been narrowed to replay-safe tools as a " +
  "recovery precaution. Use the tools that are available to report status or continue " +
  "read-only work; the full tool surface restores on the next user turn.";

export function hasRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  const authority = resolveRestartRecoveryChannelAuthority(entry);
  // Keep the pre-dispatch gate identical to recovered capability minting.
  return (
    authority !== undefined && isTrustedMessageActionTurnIngress(authority.deliveryContext.channel)
  );
}

/** Internal continuations never inherit channel authority; every other message-tool recovery must. */
export function requiresRestartRecoveryMessageActionAuthority(entry: SessionEntry): boolean {
  return (
    entry.restartRecoverySourceReplyDeliveryMode === "message_tool_only" &&
    entry.restartRecoverySourceIngress !== "internal"
  );
}

export function buildResumeMessage(
  pendingFinalDeliveryText: string,
  forceRestartSafeTools?: boolean,
  childRecoveryRoster?: string,
  continueGoal?: boolean,
): string {
  const sanitizedPendingText = sanitizePendingFinalDeliveryText(pendingFinalDeliveryText);
  const continuation = continueGoal
    ? formatSystemTurnPrompt(
        "Gateway replacement interrupted pursuit of the current session goal. Continue that unfinished goal " +
          "from the accepted transcript and checkpoint. Inspect current state before repeating any action; " +
          "completed turns and deliveries do not need to be repeated. " +
          TOOL_FAILURE_INSTRUCTION,
      )
    : RESTART_RECOVERY_RESUME_MESSAGE;
  const instructions = forceRestartSafeTools
    ? `${continuation}\n\n${RESTART_SAFE_TOOLS_NOTICE}`
    : continuation;
  const base = childRecoveryRoster ? `${instructions}\n\n${childRecoveryRoster}` : instructions;
  return sanitizedPendingText
    ? `${base}\n\nNote: The interrupted final reply was captured: "${sanitizedPendingText}"`
    : base;
}
