import os from "node:os";
import type { ChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareActiveNodeContext } from "../infra/active-node-context.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../infra/os-summary.js";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolveRuntimeChannelPromptContext } from "./runtime-capabilities.js";
import { detectRuntimeShell } from "./shell-utils.js";
import { buildSystemPromptParams } from "./system-prompt-params.js";

export async function resolveAgentRuntimePrompt(params: {
  config?: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  cwd?: string;
  preparedRepoRoot?: string | null;
  preparedGitCoauthorPrompt?: string | null;
  sessionKey?: string;
  sessionId?: string;
  model: string;
  channel?: string;
  accountId?: string | null;
  chatType?: ChatType;
  requesterProfileId?: string;
  remoteWorkspace?: boolean;
}) {
  const channelPromptContext = resolveRuntimeChannelPromptContext({
    cfg: params.config,
    channel: params.channel,
    accountId: params.accountId,
  });
  const { runtimeChannel, runtimeCapabilities } = channelPromptContext;
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  await prepareActiveNodeContext(params.requesterProfileId);
  const preparedGitCoauthorPrompt = Object.hasOwn(params, "preparedGitCoauthorPrompt")
    ? params.preparedGitCoauthorPrompt
    : await resolveSessionGitCoauthorPrompt({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      });
  const systemPromptParams = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    ...(params.remoteWorkspace
      ? { preparedRepoRoot: null }
      : Object.hasOwn(params, "preparedRepoRoot")
        ? { preparedRepoRoot: params.preparedRepoRoot }
        : {}),
    preparedGitCoauthorPrompt,
    requesterProfileId: params.requesterProfileId,
    runtime: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      host: params.remoteWorkspace ? "" : await getMachineDisplayName(),
      os: params.remoteWorkspace ? "" : resolveRuntimeOsLabel(),
      arch: params.remoteWorkspace ? "" : os.arch(),
      node: params.remoteWorkspace ? "" : process.version,
      model: params.model,
      defaultModel: `${defaultModel.provider}/${defaultModel.model}`,
      shell: params.remoteWorkspace ? undefined : detectRuntimeShell(),
      channel: runtimeChannel,
      chatType: params.chatType,
      capabilities: runtimeCapabilities,
    },
  });

  return {
    ...systemPromptParams,
    ...channelPromptContext,
  };
}
