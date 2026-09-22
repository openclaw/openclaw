import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { CodexAttemptResources } from "./run-attempt-resources.js";
import { assertCodexBindingMayBeReplaced } from "./session-binding.js";

export function canClearCodexBindingForRecovery(
  resources: CodexAttemptResources,
  operation: string,
): boolean {
  const { params } = resources.prompt.context.runtime.connection;
  const resourceState = resources.state;
  if (params.expectedSessionRuntimeOwnership) {
    // Optional recovery preserves both native ownership and the completed turn's outcome.
    embeddedAgentLog.warn(
      "codex app-server preserved native binding instead of recovery rotation",
      {
        threadId: resourceState.thread.threadId,
        operation,
      },
    );
    return false;
  }
  assertCodexBindingMayBeReplaced(resourceState.thread, operation);
  return true;
}
