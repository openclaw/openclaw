import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getAgentToolExecutionContext } from "../../packages/agent-core/src/tool-execution-context.js";
import type { AgentRunApprovalWait } from "./agent-run-approval-wait.js";
import { raceWithAbortSignal } from "./agent-tools.abort.js";
import type { CodeModeCatalogProjection } from "./code-mode-catalog.js";
import {
  CODE_MODE_RESUME_MARGIN_MS,
  type CodeModeConfig,
  type CodeModeSettlementMode,
} from "./code-mode-runtime.js";
import {
  pendingBridgeStatesForSettlement,
  waitForPendingBridgeSettlement,
  type CodeModeRunOwner,
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

export function isCodeModePendingReady(
  pending: readonly PendingBridgeState[],
  settlementMode: CodeModeSettlementMode,
): boolean {
  const required = pendingBridgeStatesForSettlement(pending, settlementMode);
  return (
    required.length === 0 ||
    (settlementMode.kind === "awaiting" && required.some((entry) => entry.settled)) ||
    required.every((entry) => entry.settled)
  );
}

/** Ordinary input can release a parked shell observer, never the cell or the shell. */
export async function waitForRequiredCodeModePending(
  pending: readonly PendingBridgeState[],
  mode: CodeModeSettlementMode,
  params: {
    signal: AbortSignal;
    owner: CodeModeRunOwner;
    catalogProjection: CodeModeCatalogProjection;
  },
  reserveForSteering: () => boolean,
): Promise<boolean> {
  const input = getAgentToolExecutionContext()?.pendingInput;
  const yieldWait = new AbortController();
  const onInput = () => {
    if (yieldWait.signal.aborted || !input?.hasPending()) {
      return;
    }
    const outstanding = pending.filter((entry) => !entry.settled);
    if (
      outstanding.length &&
      outstanding.every((entry) => {
        if (entry.method !== "callValue" || typeof entry.args[0] !== "string") {
          return false;
        }
        const id = params.catalogProjection.byCallableName.get(entry.args[0])?.id;
        return (
          id === "openclaw:core:exec" ||
          (id === "openclaw:core:process" &&
            isRecord(entry.args[1]) &&
            entry.args[1].action === "poll")
        );
      }) &&
      reserveForSteering()
    ) {
      yieldWait.abort();
    }
  };
  const unsubscribe = input?.subscribe(onInput);
  try {
    onInput();
    await raceWithAbortSignal(
      waitForPendingBridgeSettlement(
        pending,
        mode,
        AbortSignal.any([params.signal, yieldWait.signal]),
      ),
      params.signal,
    );
    return yieldWait.signal.aborted && !params.signal.aborted;
  } finally {
    unsubscribe?.();
  }
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
  if (isCodeModePendingReady(pending, settlementMode)) {
    return true;
  }
  const pausedAtMs = approvalWait.pausedMs;
  const timeoutMs = Math.max(1, budget.deadlineMs - performance.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settlement = new AbortController();
  const waitSignal = signal ? AbortSignal.any([signal, settlement.signal]) : settlement.signal;
  try {
    let remainingMs = timeoutMs;
    let resumedAtMs = performance.now();
    const arm = () => {
      resumedAtMs = performance.now();
      timer = setTimeout(() => settlement.abort(), Math.max(1, remainingMs));
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
    await waitForPendingBridgeSettlement(pending, settlementMode, waitSignal);
    return !waitSignal.aborted;
  } finally {
    settlement.abort();
    // Credit only approval time actually spent blocked here. A live sibling
    // approval must not refund guest computation, worker restore, or parked time.
    budget.deadlineMs += Math.max(0, approvalWait.pausedMs - pausedAtMs);
    if (timer) {
      clearTimeout(timer);
    }
    approvalWait.onChange = undefined;
  }
}
