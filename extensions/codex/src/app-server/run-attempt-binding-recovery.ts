import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";

/** Creates the native-ownership guard used by optional finalization recovery. */
export function createCodexBindingRecoveryGuard(
  thread: NonNullable<Parameters<typeof assertCodexBindingMayBeReplaced>[0]>,
  expectedSessionRuntimeOwnership: unknown,
): (operation: string) => boolean {
  return (operation) => {
    if (expectedSessionRuntimeOwnership) {
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
  };
}
