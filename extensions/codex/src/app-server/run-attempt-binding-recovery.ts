import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";

export function canClearCodexBindingForRecovery(
  thread: NonNullable<Parameters<typeof assertCodexBindingMayBeReplaced>[0]>,
  expectedSessionRuntimeOwnership: boolean,
  operation: string,
): boolean {
  if (expectedSessionRuntimeOwnership) {
    // Optional recovery preserves both native ownership and the completed turn's outcome.
    embeddedAgentLog.warn(
      "codex app-server preserved native binding instead of recovery rotation",
      {
        threadId: thread.threadId,
        operation,
      },
    );
    return false;
  }
  assertCodexBindingMayBeReplaced(thread, operation);
  return true;
}
