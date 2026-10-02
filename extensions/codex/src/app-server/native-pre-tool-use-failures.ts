import {
  emitCodexNativePreToolUseFailureDiagnostic,
  type CodexNativePreToolUseFailure,
} from "./native-hook-relay.js";
import { resolveCodexToolAbortTerminalReason } from "./tool-abort-terminal-reason.js";

/** Holds failures until a projector or terminal diagnostic owns their delivery. */
export function createCodexNativePreToolUseFailureBuffer(params: {
  agentId: string | undefined;
  sessionId: string;
  sessionKey: string | undefined;
  runId: string;
  signal: AbortSignal;
}) {
  const pending: CodexNativePreToolUseFailure[] = [];
  let active = false;
  let terminalReason: CodexNativePreToolUseFailure["disposition"] | undefined;
  const emit = (failure: CodexNativePreToolUseFailure) =>
    emitCodexNativePreToolUseFailureDiagnostic({
      ...params,
      failure,
      ...(active ? { terminalReason: terminalReason ?? failure.disposition } : {}),
    });
  const flush = () => {
    for (const failure of pending.splice(0)) {
      emit(failure);
    }
  };
  return {
    pending,
    get active() {
      return active;
    },
    record(failure: CodexNativePreToolUseFailure) {
      if (active) {
        emit(failure);
      } else {
        pending.push(failure);
      }
    },
    activateFallback(wasAborted: boolean) {
      if (!active) {
        terminalReason = wasAborted
          ? resolveCodexToolAbortTerminalReason(params.signal)
          : undefined;
        active = true;
      }
      flush();
    },
    flush,
  };
}
