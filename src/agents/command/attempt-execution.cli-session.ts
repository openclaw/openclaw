import { sanitizeForLog } from "../../../packages/terminal-core/src/ansi.js";
import type { CliSessionBinding, SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAuthorizedClaudeCliBinding } from "../cli-runner/child-env.js";
import { hasCliLiveSession } from "../cli-runner/cli-live-session-registry.js";
import { clearCliSessionInStore } from "../cli-session-store.js";
import {
  isClaudeCliProvider,
  claudeCliSessionTranscriptHasContent,
} from "./attempt-execution.helpers.js";

type MutableCliSessionStore = Pick<
  Parameters<typeof clearCliSessionInStore>[0],
  | "agentId"
  | "sessionKey"
  | "sessionStore"
  | "storePath"
  | "expectedSessionId"
  | "assertCommitAllowed"
>;

export async function prepareCliSessionBinding(params: {
  provider: string;
  sessionEntry: SessionEntry | undefined;
  config: OpenClawConfig;
  agentId: string;
  skillsSnapshot?: Parameters<typeof resolveAuthorizedClaudeCliBinding>[0]["skillsSnapshot"];
  cwd: string;
  cliSessionBinding?: CliSessionBinding;
  sessionId: string;
  sessionKey?: string;
  mutableCliSessionStore?: MutableCliSessionStore;
  warn: (message: string) => void;
}): Promise<SessionEntry | undefined> {
  if (params.sessionEntry?.execHost === "node") {
    return params.sessionEntry;
  }
  const authorizedBinding = isClaudeCliProvider(params.provider)
    ? resolveAuthorizedClaudeCliBinding({
        entry: params.sessionEntry,
        config: params.config,
        agentId: params.agentId,
        skillsSnapshot: params.skillsSnapshot,
        cwd: params.cwd,
      })
    : undefined;
  const hasManagedClaudeLiveSession = Boolean(
    isClaudeCliProvider(params.provider) &&
    params.cliSessionBinding?.sessionId &&
    hasCliLiveSession({
      backendId: params.provider,
      agentId: params.agentId,
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
    }),
  );
  if (
    !isClaudeCliProvider(params.provider) ||
    !params.cliSessionBinding?.sessionId ||
    (authorizedBinding &&
      (hasManagedClaudeLiveSession ||
        (await claudeCliSessionTranscriptHasContent({
          sessionId: authorizedBinding.sessionId,
          workspaceDir: params.cwd,
          projectsRoot: authorizedBinding.transcriptRoot,
        }))))
  ) {
    return params.sessionEntry;
  }

  params.warn(
    `cli session reset: provider=${sanitizeForLog(params.provider)} reason=transcript-missing sessionKey=${params.sessionKey ?? params.sessionId}`,
  );
  if (params.mutableCliSessionStore) {
    return (
      (await clearCliSessionInStore({
        provider: params.provider,
        ...params.mutableCliSessionStore,
      })) ?? params.sessionEntry
    );
  }
  return params.sessionEntry;
}
