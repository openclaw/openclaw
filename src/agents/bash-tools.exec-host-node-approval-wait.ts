import { addTimerTimeoutGraceMs } from "@openclaw/normalization-core/number-coercion";
import { emitAgentEvent } from "../infra/agent-events.js";
import { registerActiveEmbeddedRunHumanInputWaitForRun } from "./embedded-agent-runner/run-state.js";

/**
 * Parks an inline node exec approval as the owning run's human-input wait.
 * Production caller: executeNodeHostCommand when approvalFollowupMode is unset.
 * Same invariant as plugin approvals / #161821: stuck-session recovery must not
 * abort during the approval's own timeout window.
 */
export async function waitForNodeInlineExecApprovalWithHumanInputProtection<T>(params: {
  runId?: string;
  sessionKey?: string;
  sessionId?: string;
  toolCallId?: string;
  approvalId: string;
  expiresAtMs: number;
  signal?: AbortSignal;
  wait: () => Promise<T>;
  isHumanDecision?: (outcome: T) => boolean;
}): Promise<T> {
  if (params.runId) {
    emitAgentEvent({
      runId: params.runId,
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      stream: "lifecycle",
      data: {
        phase: "waiting-approval",
        approvalId: params.approvalId,
        toolCallId: params.toolCallId,
      },
    });
  }
  const remainingMs = Math.max(0, params.expiresAtMs - Date.now());
  const deadlineAtMs =
    Date.now() + (addTimerTimeoutGraceMs(remainingMs, 10_000) ?? remainingMs + 10_000);
  let pendingWait = true;
  let humanResolved = false;
  const releaseHumanInputWait = params.runId
    ? registerActiveEmbeddedRunHumanInputWaitForRun(
        params.runId,
        () => pendingWait && params.signal?.aborted !== true && Date.now() < deadlineAtMs,
      )
    : undefined;
  try {
    const outcome = await params.wait();
    humanResolved = params.isHumanDecision?.(outcome) === true;
    return outcome;
  } finally {
    pendingWait = false;
    releaseHumanInputWait?.(humanResolved);
    if (params.runId) {
      emitAgentEvent({
        runId: params.runId,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        stream: "lifecycle",
        data: {
          phase: "approval-resolved",
          approvalId: params.approvalId,
          toolCallId: params.toolCallId,
        },
      });
    }
  }
}
