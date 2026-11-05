import path from "node:path";
import { embeddedAgentLog, formatErrorMessage } from "openclaw/plugin-sdk/agent-harness-runtime";
import { resolveCodexAppServerVerifiedLocalHomeDir } from "./auth-start-options.js";
import { withCodexClientWorkspace } from "./client-runtime.js";
import {
  readCodexWorkspaceModelContext,
  type CodexNativeModelContext,
} from "./client-workspace-state.js";
import type { StartedCodexAttemptResources } from "./run-attempt-start.js";

/**
 * Codex records its base instructions and AGENTS.md injection only in its own rollout;
 * app-server responses expose neither. Undefined means no readable local record (or an
 * abandoned read), which leaves AGENTS.md unverified; it never fails the turn.
 */
export async function readCodexNativeModelContext(
  resources: StartedCodexAttemptResources,
  signal: AbortSignal,
): Promise<CodexNativeModelContext | undefined> {
  const { client, thread } = resources.state;
  try {
    const { appServer, agentDir } = resources.prompt.context.runtime.connection;
    const home = resolveCodexAppServerVerifiedLocalHomeDir(
      appServer,
      agentDir,
      client.getRuntimeIdentity()?.codexHome,
    );
    if (!home) {
      return undefined;
    }
    return await withCodexClientWorkspace(client, (state, maxCachedSessions) =>
      readCodexWorkspaceModelContext(
        client,
        state,
        path.join(home, "sessions"),
        thread.rolloutPath,
        thread.threadId,
        maxCachedSessions,
        signal,
      ),
    );
  } catch (error) {
    if (!signal.aborted) {
      embeddedAgentLog.debug("codex native model context unavailable for the context report", {
        threadId: thread.threadId,
        error: formatErrorMessage(error),
      });
    }
    return undefined;
  }
}
