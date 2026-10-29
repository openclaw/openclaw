import { AgentHarnessPreflightError } from "openclaw/plugin-sdk/agent-harness-runtime";
import { isCodexAppServerLiveThreadProtected } from "./client-runtime.js";
import type { CodexAppServerClient } from "./client.js";

/** Native compaction cannot be trusted to retain a continuation's current context. */
export function assertCodexProtectedContextCarrier(
  client: CodexAppServerClient,
  threadId: string | undefined,
  hasCurrentRelay: boolean,
  turnContext: string | undefined,
): void {
  if (
    turnContext &&
    threadId &&
    !hasCurrentRelay &&
    isCodexAppServerLiveThreadProtected(client, threadId)
  ) {
    throw new AgentHarnessPreflightError(
      "Protected Codex continuation requires a current parent-local inference relay; the native thread is claimed by active work.",
    );
  }
}
