import path from "node:path";
import type { ChatType } from "../../channels/chat-type.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveUserPath } from "../../utils.js";
import { resolveAgentWorkspaceDir } from "../agent-scope-config.js";
import {
  makeBootstrapWarn,
  resolveBootstrapContextForRun,
  resolveBootstrapFilesForRun,
} from "../bootstrap-files.js";
import type { BootstrapContextMode } from "../bootstrap-files.js";
import type { BootstrapContextRunKind } from "../bootstrap-mode.js";
import { buildBootstrapContextForFiles } from "../embedded-agent-helpers/bootstrap.js";
import type { EmbeddedContextFile } from "../embedded-agent-helpers/context-file.js";
import { DEFAULT_AGENTS_FILENAME, type WorkspaceBootstrapFile } from "../workspace.js";

export async function resolveCliBootstrapContextForRun(params: {
  bootstrapWorkspaceDir?: string;
  workspaceDir: string;
  sessionLabel: string;
  config?: OpenClawConfig;
  sessionKey?: string;
  sessionId?: string;
  bootstrapUserProfileId?: string;
  chatType?: ChatType;
  agentId: string;
  contextMode?: BootstrapContextMode;
  runKind?: BootstrapContextRunKind;
  warn?: (message: string) => void;
}): Promise<{ bootstrapFiles: WorkspaceBootstrapFile[]; contextFiles: EmbeddedContextFile[] }> {
  const bootstrapWorkspaceDir =
    params.bootstrapWorkspaceDir ??
    resolveUserPath(resolveAgentWorkspaceDir(params.config ?? {}, params.agentId));
  const bootstrapWarn = makeBootstrapWarn({
    sessionLabel: params.sessionLabel,
    workspaceDir: bootstrapWorkspaceDir,
    warn: params.warn,
  });
  const bootstrapParams = {
    config: params.config,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    bootstrapUserProfileId: params.bootstrapUserProfileId,
    chatType: params.chatType,
    agentId: params.agentId,
    contextMode: params.contextMode,
    runKind: params.runKind,
    warn: bootstrapWarn,
  };
  const agentBootstrap = await resolveBootstrapContextForRun({
    ...bootstrapParams,
    workspaceDir: bootstrapWorkspaceDir,
  });
  if (path.resolve(bootstrapWorkspaceDir) === path.resolve(params.workspaceDir)) {
    return agentBootstrap;
  }

  const executionAgentsPath = path.join(path.resolve(params.workspaceDir), DEFAULT_AGENTS_FILENAME);
  const executionProjectFiles = (
    await resolveBootstrapFilesForRun({
      ...bootstrapParams,
      workspaceDir: params.workspaceDir,
    })
  )
    .filter(
      (file) =>
        file.name === DEFAULT_AGENTS_FILENAME &&
        !file.missing &&
        path.resolve(file.path) === executionAgentsPath,
    )
    .map((file) => ({
      ...file,
      origin: { kind: "execution-project" as const, rootPath: params.workspaceDir },
    }));
  if (executionProjectFiles.length === 0) {
    return agentBootstrap;
  }

  const bootstrapFiles = [...agentBootstrap.bootstrapFiles, ...executionProjectFiles];
  return {
    bootstrapFiles,
    contextFiles: buildBootstrapContextForFiles(bootstrapFiles, {
      config: params.config,
      agentId: params.agentId,
      warn: bootstrapWarn,
    }),
  };
}
