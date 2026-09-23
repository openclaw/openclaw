/** Own cancellation admission without interpreting a backend's native stop receipt. */
export function createAgentHarnessAttemptCancellation(params: {
  upstreamSignal?: AbortSignal;
  onAttemptAbort?: () => void;
  state: AgentHarnessAttemptCancellationState;
}) {
  const controller = new AbortController();
  let attemptAbortNotified = false;
  const notifyAttemptAbort = () => {
    if (attemptAbortNotified) {
      return;
    }
    attemptAbortNotified = true;
    params.onAttemptAbort?.();
  };
  const abortExplicitly = (reason: unknown) => {
    if (params.state.terminalOutcomeFrozen) {
      if (params.state.sharedAbortAllowedAfterTerminalOutcome) {
        notifyAttemptAbort();
      }
      return;
    }
    notifyAttemptAbort();
    params.state.explicitCancellationObserved = true;
    params.state.explicitCancellationReason ??= reason;
    controller.abort(reason);
  };
  const abortFromUpstream = () => {
    abortExplicitly(params.upstreamSignal?.reason ?? "upstream_abort");
  };
  const dispose = () => {
    params.upstreamSignal?.removeEventListener("abort", abortFromUpstream);
  };
  const freezeTerminalOutcome = () => {
    if (params.state.terminalOutcomeFrozen) {
      return;
    }
    params.state.terminalOutcomeFrozen = true;
    dispose();
  };
  if (params.upstreamSignal?.aborted) {
    abortFromUpstream();
  } else {
    params.upstreamSignal?.addEventListener("abort", abortFromUpstream, { once: true });
  }
  return { controller, abortExplicitly, freezeTerminalOutcome, dispose };
}

export type AgentHarnessAttemptCancellationState = {
  explicitCancellationObserved: boolean;
  explicitCancellationReason?: unknown;
  terminalOutcomeFrozen: boolean;
  sharedAbortAllowedAfterTerminalOutcome: boolean;
};
