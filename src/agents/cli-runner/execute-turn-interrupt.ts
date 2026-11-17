import type { CliBackendTurnInterrupt } from "../../plugins/cli-backend.types.js";
import { stripOpenClawMcpToolPrefix } from "../tool-display-call.js";
import { isAlreadyPendingSessionsYieldResult } from "../tools/sessions-yield-tool.js";

type CliTurnInterruptReason = Parameters<CliBackendTurnInterrupt["interrupt"]>[0];

/** Sends one graceful turn end once both its reason and the backend capability are known. */
export function createCliTurnInterruptRequest() {
  let interrupt: CliBackendTurnInterrupt | undefined;
  let supported = false;
  let reason: CliTurnInterruptReason | undefined;
  let pending: Promise<void> | undefined;
  const flush = () => {
    if (!reason || !interrupt || pending) {
      return;
    }
    const target = interrupt;
    const requested = reason;
    pending = Promise.resolve().then(() => target.interrupt(requested));
    // The execution owner joins this promise and cancels the transport on failure.
    void pending.catch(() => {});
  };
  return {
    register(next: CliBackendTurnInterrupt | undefined) {
      interrupt = next;
      supported ||= next !== undefined;
      flush();
    },
    request(next: CliTurnInterruptReason) {
      reason ??= next;
      flush();
    },
    isSupported: () => supported,
    reason: () => reason,
    wait: () => pending,
  };
}

/**
 * Ends the turn once a sessions_yield result is consumed: a real yield, or an earlier
 * turn's already-pending wait after this turn delivered its visible reply. That earlier
 * wake resumes the session, so trailing assistant text is not a reply (embedded parity).
 */
export function createCliYieldTurnEnd(
  turnInterrupt: ReturnType<typeof createCliTurnInterruptRequest>,
) {
  let pendingAfterSourceReply = false;
  return {
    observe(toolName: string, call: { outcome: string; result?: unknown }, delivered: boolean) {
      pendingAfterSourceReply ||=
        delivered &&
        call.outcome === "completed" &&
        isAlreadyPendingSessionsYieldResult(toolName, call.result);
    },
    onToolResult(toolName: string, isError: boolean | undefined, yielded: boolean) {
      if (isError || stripOpenClawMcpToolPrefix(toolName) !== "sessions_yield") {
        return;
      }
      if (yielded) {
        // Native's tool-result record confirms the yield response was consumed before interruption.
        turnInterrupt.request("yield");
      } else if (pendingAfterSourceReply) {
        turnInterrupt.request("source_reply");
      }
    },
  };
}
