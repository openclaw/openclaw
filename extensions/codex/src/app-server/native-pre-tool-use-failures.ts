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
  let fallback:
    | { terminalReason: CodexNativePreToolUseFailure["disposition"] | undefined }
    | undefined;
  const emit = (failure: CodexNativePreToolUseFailure) =>
    emitCodexNativePreToolUseFailureDiagnostic({
      ...params,
      failure,
      ...(fallback ? { terminalReason: fallback.terminalReason ?? failure.disposition } : {}),
    });
  const flush = () => {
    for (const failure of pending.splice(0)) {
      emit(failure);
    }
  };
  return {
    pending,
    get active() {
      return fallback !== undefined;
    },
    record(failure: CodexNativePreToolUseFailure) {
      if (fallback) {
        emit(failure);
      } else {
        pending.push(failure);
      }
    },
    activateFallback(wasAborted: boolean) {
      fallback ??= {
        terminalReason: wasAborted ? resolveCodexToolAbortTerminalReason(params.signal) : undefined,
      };
      flush();
    },
    flush,
  };
}
