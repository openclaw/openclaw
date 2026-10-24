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
    // A controller can call the native cancel hook before this signal's listener.
    // Keep the upstream cause, especially a hard timeout, in either callback order.
    const abortReason = params.upstreamSignal?.aborted ? params.upstreamSignal.reason : reason;
    notifyAttemptAbort();
    params.state.explicitCancellationObserved = true;
    params.state.explicitCancellationReason ??= abortReason;
    controller.abort(abortReason);
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
