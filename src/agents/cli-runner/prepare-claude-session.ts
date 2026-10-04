import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import { resolveSkillEnvOverridesFromSnapshot } from "../../skills/runtime/env-overrides.js";
import type { SkillSnapshot } from "../../skills/types.js";
import {
  claudeCliSessionTranscriptHasContent,
  claudeCliSessionTranscriptHasOrphanedToolUse,
} from "../command/attempt-execution.helpers.js";
import { resolveClaudeChildTranscriptRoot } from "./child-env.js";
import { getCliLiveSessionGeneration } from "./cli-live-session-registry.js";
import { resolveCliSessionId } from "./cli-run-recovery.js";
import { isClaudeCliBackendId } from "./helpers.js";
import type { CliReusableSession } from "./types.js";

type PreparedBackendForTranscriptRoot = Pick<
  Parameters<typeof resolveClaudeChildTranscriptRoot>[0]["preparedBackend"],
  "env" | "secretInput"
>;

export async function prepareClaudeCliSession(params: {
  backendReusableCliSession: CliReusableSession;
  provider: string;
  isControlOperation: boolean;
  nodeClaudePlacement: boolean;
  backendId: string;
  backend: CliBackendConfig;
  preparedBackend: PreparedBackendForTranscriptRoot;
  config: OpenClawConfig;
  skillsSnapshot?: SkillSnapshot;
  cwd: string;
  agentAccountId?: string;
  agentId: string;
  authProfileId?: string;
  sessionId?: string;
  sessionKey?: string;
  hasTranscriptContent: typeof claudeCliSessionTranscriptHasContent;
  hasOrphanedToolUse: typeof claudeCliSessionTranscriptHasOrphanedToolUse;
}): Promise<{
  reusableCliSession: CliReusableSession;
  managedClaudeLiveSessionGeneration?: string;
}> {
  const candidateClaudeCliSessionId =
    resolveCliSessionId(params.backendReusableCliSession)?.trim() || undefined;
  // Control operations keep the exact native session they were asked to mutate.
  // Ordinary-turn transcript recovery must not turn them into fresh sessions.
  const hasClaudeCliCandidate =
    !params.isControlOperation &&
    !params.nodeClaudePlacement &&
    candidateClaudeCliSessionId !== undefined &&
    isClaudeCliBackendId(params.provider);
  // Judge reuse under the root the upcoming child selects, not a previous root.
  const claudeCliTranscriptRoot = hasClaudeCliCandidate
    ? await resolveClaudeChildTranscriptRoot({
        provider: params.provider,
        backend: params.backend,
        preparedBackend: params.preparedBackend,
        skillEnv: resolveSkillEnvOverridesFromSnapshot({
          snapshot: params.skillsSnapshot,
          config: params.config,
        }),
        remote: false,
        cwd: params.cwd,
      })
    : undefined;
  const claudeCliTranscriptMissing =
    hasClaudeCliCandidate &&
    !(await params.hasTranscriptContent({
      sessionId: candidateClaudeCliSessionId,
      workspaceDir: params.cwd,
      projectsRoot: claudeCliTranscriptRoot,
    }));
  const managedClaudeLiveSessionGeneration =
    claudeCliTranscriptMissing &&
    params.backendId === "claude-cli" &&
    "liveSession" in params.backend &&
    params.backend.liveSession === "claude-stdio" &&
    params.backend.output === "jsonl" &&
    params.backend.input === "stdin"
      ? getCliLiveSessionGeneration({
          backendId: params.backendId,
          agentAccountId: params.agentAccountId,
          agentId: params.agentId,
          authProfileId: params.authProfileId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
        })
      : undefined;
  const hasManagedClaudeLiveSession = Boolean(managedClaudeLiveSessionGeneration);
  const claudeCliTranscriptOrphanedToolUse =
    hasClaudeCliCandidate &&
    !claudeCliTranscriptMissing &&
    (await params.hasOrphanedToolUse({
      sessionId: candidateClaudeCliSessionId,
      workspaceDir: params.cwd,
      projectsRoot: claudeCliTranscriptRoot,
    }));
  const claudeCliInvalidatedReason: "missing-transcript" | "orphaned-tool-use" | undefined =
    claudeCliTranscriptMissing && !hasManagedClaudeLiveSession
      ? "missing-transcript"
      : claudeCliTranscriptOrphanedToolUse
        ? "orphaned-tool-use"
        : undefined;
  const reusableCliSession: CliReusableSession = claudeCliInvalidatedReason
    ? { mode: "invalidate", invalidatedReason: claudeCliInvalidatedReason }
    : params.backendReusableCliSession;

  return {
    reusableCliSession,
    ...(managedClaudeLiveSessionGeneration ? { managedClaudeLiveSessionGeneration } : {}),
  };
}
