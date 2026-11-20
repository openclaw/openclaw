/**
 * Resolves the workspace files a direct compaction request sends to the model.
 *
 * The same Agent Profile workspace-context budget that bounds a live turn also
 * bounds this prompt, so a small-profile session cannot exceed its cap merely
 * because its transcript needed compaction.
 */
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveAgentProfile } from "../agent-profiles.js";
import { prepareAgentProfileWorkspaceContext } from "../agent-profiles/workspace-context.js";
import { resolveBootstrapContextForRun } from "../bootstrap-files.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import type { WorkspaceBootstrapFile } from "../workspace.js";

export type CompactionWorkspaceContext = {
  bootstrapFiles: WorkspaceBootstrapFile[];
  contextFiles: EmbeddedContextFile[];
};

export async function resolveCompactionWorkspaceContext(params: {
  config?: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
  sessionId: string;
  chatType?: ChatType;
  workspaceDir: string;
  provider?: string;
  modelId?: string;
  warn?: (message: string) => void;
}): Promise<CompactionWorkspaceContext> {
  const resolvedBootstrap = await resolveBootstrapContextForRun({
    workspaceDir: params.workspaceDir,
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    chatType: params.chatType,
    agentId: params.agentId,
    warn: params.warn,
  });
  const resolvedProfile = resolveAgentProfile({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const profileContext = await prepareAgentProfileWorkspaceContext({
    resolvedProfile,
    bootstrapFiles: resolvedBootstrap.bootstrapFiles,
    config: params.config,
    agentId: params.agentId,
    warn: params.warn,
  });
  return {
    bootstrapFiles: resolvedBootstrap.bootstrapFiles,
    contextFiles: profileContext?.contextFiles ?? resolvedBootstrap.contextFiles,
  };
}
