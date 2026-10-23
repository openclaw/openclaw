import { createMessageInjectionAuthority } from "../../auto-reply/reply/message-injection-authority.js";
import { logMessageQueuedWithBacklogPolicy } from "../../logging/diagnostic-runtime.js";
import type { ReplyOperation } from "../../sessions/session-controller.contracts.js";
import {
  getAttachedBackendAttachment,
  isCurrentSessionControllerOperation,
} from "../../sessions/session-controller.state.js";
import { getControllerEmbeddedAttachment } from "./run-state.js";

function logActiveRunMessageAccepted(sessionId: string): void {
  // Active-run steering is consumed by the current turn, not queued as another
  // turn for the single idle transition to drain. Keep the event and activity.
  logMessageQueuedWithBacklogPolicy(
    {
      sessionId,
      source: "embedded-agent-runner",
    },
    false,
  );
}

/** TUI preflight requires V2 ownership; failure leaves ordinary input to local queue policy. */
export async function claimPendingEmbeddedAgentQuestionAnswer(
  operation: ReplyOperation,
  text: string,
): Promise<{ runId: string } | null> {
  const registration = getControllerEmbeddedAttachment(operation);
  const backendAttachment = getAttachedBackendAttachment(operation);
  const handle = registration?.handle;
  const guarded = handle?.messageInjectionV2;
  if (!handle?.runId?.trim() || guarded?.version !== 2 || !guarded.claimPendingUserInputAnswer) {
    return null;
  }
  const runId = handle.runId;
  let isCurrent: () => boolean;
  try {
    // Retain the selected physical owner instead of re-resolving a shared session ID.
    isCurrent = () =>
      isCurrentSessionControllerOperation(operation) &&
      getControllerEmbeddedAttachment(operation) === registration &&
      getAttachedBackendAttachment(operation) === backendAttachment;
    registration?.toolAuthority?.assertActive();
    if (!guarded.isAvailable() || !isCurrent()) {
      return null;
    }
  } catch {
    return null;
  }
  // V2 carries the captured owner assertion through persistence and final dispatch.
  // An unconfirmed answer must propagate; queue fallback could replay accepted input.
  const assertCurrent = createMessageInjectionAuthority(() => {
    registration?.toolAuthority?.assertActive();
    return isCurrent();
  });
  const claimed = await guarded.claimPendingUserInputAnswer(
    text,
    { isInboundUserMessage: true },
    assertCurrent,
    "run",
  );
  if (!claimed) {
    return null;
  }
  logActiveRunMessageAccepted(operation.sessionId);
  return { runId };
}
