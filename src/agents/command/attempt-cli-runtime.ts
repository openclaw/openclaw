/**
 * Selects the CLI execution provider for one agent attempt.
 */
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveSessionPinnedHarnessId } from "../../sessions/agent-harness-session-key.js";
import { resolveCliRuntimeExecutionProvider } from "../model-runtime-aliases.js";
import { isCliProvider } from "../model-selection.js";

/** A session runtime override wins unless the pinned harness locks it; otherwise config decides. */
export function resolveAttemptCliRuntime(params: {
  isRawModelRun: boolean;
  providerOverride: string;
  modelOverride: string;
  cfg: OpenClawConfig;
  sessionEntry: SessionEntry | undefined;
  sessionAgentId: string;
  agentHarnessRuntimeOverride?: string;
  authProfileId?: string;
}) {
  const { isRawModelRun } = params;
  const sessionRuntimeOverride = isRawModelRun ? undefined : params.agentHarnessRuntimeOverride;
  const pinnedHarnessId = isRawModelRun
    ? undefined
    : resolveSessionPinnedHarnessId(params.sessionEntry);
  const locksSessionRuntimeOverride =
    pinnedHarnessId !== undefined && sessionRuntimeOverride === pinnedHarnessId;
  const sessionCliRuntime =
    sessionRuntimeOverride &&
    !locksSessionRuntimeOverride &&
    isCliProvider(sessionRuntimeOverride, params.cfg)
      ? sessionRuntimeOverride
      : undefined;
  const configuredCliRuntime =
    !isRawModelRun && !sessionRuntimeOverride
      ? resolveCliRuntimeExecutionProvider({
          provider: params.providerOverride,
          cfg: params.cfg,
          agentId: params.sessionAgentId,
          modelId: params.modelOverride,
          authProfileId: params.authProfileId,
        })
      : undefined;
  const cliExecutionProvider = isRawModelRun
    ? params.providerOverride
    : (sessionCliRuntime ?? configuredCliRuntime ?? params.providerOverride);
  const isCliExecutionProvider = sessionRuntimeOverride
    ? sessionCliRuntime !== undefined
    : isCliProvider(cliExecutionProvider, params.cfg);
  return { sessionRuntimeOverride, pinnedHarnessId, cliExecutionProvider, isCliExecutionProvider };
}
