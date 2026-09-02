import { resolvePoolAcquire } from "./attempt-config.js";
import type { AgentHarnessAttemptResult, AttemptParamsLike } from "./attempt-types.js";
import type { SessionLike } from "./event-bridge.js";

export function createCopilotToolTerminalObserver(
  observer: AttemptParamsLike["observeToolTerminal"],
  onLastToolError: (error: AgentHarnessAttemptResult["lastToolError"]) => void,
): AttemptParamsLike["observeToolTerminal"] {
  return observer
    ? (observation) => {
        const terminal = observer(observation);
        onLastToolError(terminal.lastToolError);
        return terminal;
      }
    : undefined;
}

export function createCopilotAbortLifecycle(params: {
  markExternalAbort: () => void;
  shouldAbortSession: () => boolean;
  session: () => SessionLike | undefined;
}) {
  const abortActiveSession = () => {
    params.markExternalAbort();
    const session = params.session();
    if (!params.shouldAbortSession() || !session) {
      return;
    }
    void session.abort().catch(() => undefined);
  };
  return { abortActiveSession, onAbort: abortActiveSession };
}

export function resolveCopilotExecutionPoolAcquire(
  input: AttemptParamsLike,
  settledToolFinalization: boolean,
) {
  const resolved = resolvePoolAcquire(input);
  return settledToolFinalization
    ? {
        ...resolved,
        options: { ...resolved.options, mode: "empty" as const },
      }
    : resolved;
}
