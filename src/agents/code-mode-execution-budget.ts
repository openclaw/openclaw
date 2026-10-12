import type { AgentRunApprovalWait } from "./agent-run-approval-wait.js";
import {
  CODE_MODE_RESUME_MARGIN_MS,
  type CodeModeConfig,
  type CodeModeSettlementMode,
} from "./code-mode-runtime.js";
import {
  pendingBridgeStatesForSettlement,
  waitForPendingBridgeSettlement,
  type PendingBridgeState,
} from "./code-mode-state.js";

export type CodeModeCallBudget = { deadlineMs: number };

export function usableResumeBudgetMs(
  deadlineMs: number,
  config: CodeModeConfig,
): number | undefined {
  // VM restore costs tens of ms and counts against the guest interrupt budget;
  // resuming with less than this floor converts an otherwise successful run
  // into an immediate interrupt timeout, so callers park the snapshot instead.
  const minimum = Math.min(
    CODE_MODE_RESUME_MARGIN_MS,
    Math.max(1, Math.floor(config.timeoutMs / 2)),
  );
  const remaining = deadlineMs - performance.now();
  return remaining >= minimum ? remaining : undefined;
}

export async function waitForCodeModePending(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
  budget: CodeModeCallBudget,
  approvalWait: AgentRunApprovalWait,
  signal?: AbortSignal,
): Promise<boolean> {
  // Abort wins even over already-settled requests: callers treat `false` as
  // "do not resume the guest", which is what a cancelled exec/wait needs.
  if (signal?.aborted) {
    return false;
  }
  const required = pendingBridgeStatesForSettlement(pending, settlementMode);
  if (
    required.length === 0 ||
    (settlementMode.kind === "awaiting" && required.some((entry) => entry.settled)) ||
    required.every((entry) => entry.settled)
  ) {
    return true;
  }
  const pausedAtMs = approvalWait.pausedMs;
  const timeoutMs = Math.max(1, budget.deadlineMs - performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const settlement = new AbortController();
  try {
    const bridgeReady = waitForPendingBridgeSettlement(
      pending,
      settlementMode,
      settlement.signal,
    ).then(() => true);
    return await Promise.race([
      bridgeReady,
      new Promise<boolean>((resolve) => {
        onAbort = () => resolve(false);
        signal?.addEventListener("abort", onAbort, { once: true });
        let remainingMs = timeoutMs;
        let resumedAtMs = performance.now();
        const arm = () => {
          resumedAtMs = performance.now();
          timer = setTimeout(() => resolve(false), Math.max(1, remainingMs));
        };
        approvalWait.onChange = (approvalPending) => {
          if (approvalPending) {
            // Preserve the unused guest budget while its owning approval remains inline.
            clearTimeout(timer);
            remainingMs = Math.max(1, remainingMs - (performance.now() - resumedAtMs));
          } else {
            arm();
          }
        };
        if (!approvalWait.pending) {
          arm();
        }
      }),
    ]);
  } finally {
    settlement.abort();
    // Credit only approval time actually spent blocked here. A live sibling
    // approval must not refund guest computation, worker restore, or parked time.
    budget.deadlineMs += Math.max(0, approvalWait.pausedMs - pausedAtMs);
    if (timer) {
      clearTimeout(timer);
    }
    if (signal && onAbort) {
      signal.removeEventListener("abort", onAbort);
    }
    approvalWait.onChange = undefined;
  }
}
