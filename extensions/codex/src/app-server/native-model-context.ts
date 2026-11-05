import path from "node:path";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerVerifiedLocalHomeDir } from "./auth-start-options.js";
import { withCodexClientWorkspace } from "./client-runtime.js";
import { readCodexWorkspaceModelContext } from "./client-workspace-state.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";

/**
 * Codex records its base instructions and AGENTS.md injection only in its own rollout;
 * app-server responses expose neither. A missing or unreadable local record leaves
 * AGENTS.md unverified and never fails the turn.
 */
export async function recordCodexNativeModelContext(
  resources: StartedCodexAttemptResources,
): Promise<void> {
  const { client, thread } = resources.state;
  try {
    const { appServer, agentDir } = resources.prompt.context.runtime.connection;
    const home = resolveCodexAppServerVerifiedLocalHomeDir(
      appServer,
      agentDir,
      client.getRuntimeIdentity()?.codexHome,
    );
    if (!home) {
      return;
    }
    const context = await withCodexClientWorkspace(client, (state, maxCachedSessions) =>
      readCodexWorkspaceModelContext(
        client,
        state,
        path.join(home, "sessions"),
        thread.rolloutPath,
        thread.threadId,
        maxCachedSessions,
      ),
    );
    resources.prompt.setNativeModelContext(context);
  } catch (error) {
    embeddedAgentLog.debug("codex native model context unavailable for the context report", {
      threadId: thread.threadId,
      error: formatErrorMessage(error),
    });
  }
}
