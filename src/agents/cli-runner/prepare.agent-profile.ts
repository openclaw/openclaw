import type { ChatType } from "../../channels/chat-type.js";
import type { ModelSizeClass } from "../../config/types.models.js";
import { resolveAgentProfile } from "../agent-profiles.js";
import { prepareAgentProfileWorkspaceContext } from "../agent-profiles/workspace-context.js";
import { makeBootstrapWarn, resolveBootstrapContextForRun } from "../bootstrap-files.js";
import { resolveContextSerialization } from "../context-serialization/resolve.js";
import { cliBackendLog } from "./log.js";
import type { RunCliAgentParams } from "./types.js";

/**
 * Selects the Agent Profile for a CLI run and loads its bootstrap context, applying the
 * profile's workspace budget when the profile declares one.
 */
export async function prepareCliAgentProfileContext(args: {
  params: RunCliAgentParams;
  skipsTurnPrefix: boolean;
  sessionAgentId: string;
  sessionLabel: string;
  modelSizeClass: ModelSizeClass | undefined;
  workspaceDir: string;
  bootstrapWorkspaceDir: string;
  runtimeChatType: ChatType | undefined;
}) {
  const { params, sessionAgentId, bootstrapWorkspaceDir } = args;
  const resolvedProfile = resolveAgentProfile({
    config: params.config,
    agentId: sessionAgentId,
    sessionKey: params.sessionKey,
    modelSizeClass: args.modelSizeClass,
  });
  const warn = makeBootstrapWarn({
    sessionLabel: args.sessionLabel,
    workspaceDir: bootstrapWorkspaceDir,
    warn: (message) => cliBackendLog.warn(message),
  });
  const resolvedBootstrap = args.skipsTurnPrefix
    ? { bootstrapFiles: [], contextFiles: [] }
    : await resolveBootstrapContextForRun({
        workspaceDir: bootstrapWorkspaceDir,
        executionWorkspaceDir: params.sessionEntry?.sessionRoot ?? args.workspaceDir,
        config: params.config,
        sessionKey: params.sessionKey,
        sessionId: params.sessionId,
        bootstrapUserProfileId: params.bootstrapUserProfileId,
        chatType: args.runtimeChatType,
        agentId: sessionAgentId,
        contextMode: params.bootstrapContextMode,
        runKind: params.bootstrapContextRunKind,
        warn,
      });
  const profileContext = args.skipsTurnPrefix
    ? undefined
    : await prepareAgentProfileWorkspaceContext({
        resolvedProfile,
        bootstrapFiles: resolvedBootstrap.bootstrapFiles,
        config: params.config,
        agentId: sessionAgentId,
        warn,
      });
  return {
    resolvedProfile,
    agentProfileReport: {
      id: resolvedProfile.profile.id,
      selectionSource: resolvedProfile.selectionSource,
    },
    contextSerialization: resolveContextSerialization({ resolvedProfile }),
    bootstrapFiles: profileContext?.bootstrapFiles ?? resolvedBootstrap.bootstrapFiles,
    bootstrapSourceFiles: profileContext?.sourceFiles ?? resolvedBootstrap.bootstrapFiles,
    resolvedContextFiles: profileContext?.contextFiles ?? resolvedBootstrap.contextFiles,
    workspaceContextReport: profileContext?.report,
  };
}
