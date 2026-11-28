import os from "node:os";
import type { ChatType } from "../channels/chat-type.js";
import type { InternalSessionEntry, SessionDeliveryState } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareActiveNodeContext } from "../infra/active-node-context.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../infra/os-summary.js";
import { settleCurrentReadPreparations } from "../shared/current-read-authority.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import {
  resolveRuntimeChannelPromptContext,
  resolveSessionPromptRoute,
} from "./runtime-capabilities.js";
import { detectRuntimeShell } from "./shell-utils.js";
import type { SpawnRequesterConversationSource } from "./spawn-requester-origin.js";
import { buildSystemPromptParams, resolveSystemPromptRepoRoot } from "./system-prompt-params.js";

export async function resolveAgentRuntimePrompt(params: {
  config?: OpenClawConfig;
  agentId: string;
  workspaceDir?: string;
  cwd?: string;
  preparedRepoRoot?: string | null;
  preparedGitCoauthorPrompt?: string | null;
  preparedSessionEntry?: InternalSessionEntry;
  sessionPromptDelivery?: SessionDeliveryState;
  sessionKey?: string;
  sessionId?: string;
  model: string;
  channel?: string;
  accountId?: string | null;
  requester?: SpawnRequesterConversationSource;
  chatType?: ChatType;
  requesterProfileId?: string;
  remoteWorkspace?: boolean;
  /** Blind spawned child: the rendered prompt omits its model, identity and workspace path. */
  blind?: boolean;
}) {
  const promptRoute = resolveSessionPromptRoute({
    sessionDelivery: params.sessionPromptDelivery ?? params.preparedSessionEntry?.delivery,
    channel: params.channel,
    accountId: params.accountId,
    requester: params.requester,
    chatType: params.chatType,
  });
  const channelPromptContext = resolveRuntimeChannelPromptContext({
    cfg: params.config,
    channel: promptRoute.channel,
    accountId: promptRoute.accountId,
    requester: promptRoute.requester,
  });
  const { runtimeChannel, runtimeCapabilities } = channelPromptContext;
  const defaultModel = resolveDefaultModelForAgent({
    cfg: params.config ?? {},
    agentId: params.agentId,
  });
  const [, preparedGitCoauthorPrompt, host] = await settleCurrentReadPreparations([
    prepareActiveNodeContext(params.requesterProfileId),
    Object.hasOwn(params, "preparedGitCoauthorPrompt")
      ? params.preparedGitCoauthorPrompt
      : resolveSessionGitCoauthorPrompt({
          config: params.config,
          agentId: params.agentId,
          sessionKey: params.sessionKey,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        }),
    params.remoteWorkspace ? "" : getMachineDisplayName(),
  ] as const);
  const systemPromptParams = buildSystemPromptParams({
    config: params.config,
    agentId: params.agentId,
    workspaceDir: params.workspaceDir,
    cwd: params.cwd,
    ...(params.remoteWorkspace
      ? { preparedRepoRoot: null }
      : Object.hasOwn(params, "preparedRepoRoot")
        ? { preparedRepoRoot: params.preparedRepoRoot }
        : { preparedRepoRoot: await resolveSystemPromptRepoRoot(params) }),
    preparedGitCoauthorPrompt,
    preparedSessionEntry: params.preparedSessionEntry,
    requesterProfileId: params.requesterProfileId,
    runtime: {
      sessionKey: params.sessionKey,
      sessionId: params.sessionId,
      host,
      os: params.remoteWorkspace ? "" : resolveRuntimeOsLabel(),
      arch: params.remoteWorkspace ? "" : os.arch(),
      node: params.remoteWorkspace ? "" : process.version,
      model: params.model,
      defaultModel: defaultModel && `${defaultModel.provider}/${defaultModel.model}`,
      shell: params.remoteWorkspace ? undefined : detectRuntimeShell(),
      channel: runtimeChannel,
      chatType: promptRoute.chatType,
      capabilities: runtimeCapabilities,
      customInlineButtonHint: channelPromptContext.customInlineButtonHint,
      blind: params.blind,
    },
  });

  return {
    ...systemPromptParams,
    ...channelPromptContext,
    runtimeChannel: normalizeMessageChannel(params.channel),
  };
}
