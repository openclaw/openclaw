import os from "node:os";
import type { ChatType } from "../channels/chat-type.js";
import type { InternalSessionEntry, SessionDeliveryState } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareActiveNodeContext } from "../infra/active-node-context.js";
import { getMachineDisplayName } from "../infra/machine-name.js";
import { resolveRuntimeOsLabel } from "../infra/os-summary.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { normalizeMessageChannel } from "../utils/message-channel-normalize.js";
import { resolveSessionGitCoauthorPrompt } from "./git-coauthor-prompt.js";
import { resolveDefaultModelForAgent } from "./model-selection.js";
import { resolveRuntimeChannelPromptContext } from "./runtime-capabilities.js";
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
  const delivery = params.sessionPromptDelivery ?? params.preparedSessionEntry?.delivery;
  const external = delivery?.kind === "external" ? delivery : undefined;
  // Presentation follows the session; current-turn routing and authority stay separate.
  const promptChannel = external
    ? external.context.channel
    : delivery?.kind === "internal"
      ? INTERNAL_MESSAGE_CHANNEL
      : delivery
        ? undefined
        : params.channel;
  const channelPromptContext = resolveRuntimeChannelPromptContext({
    cfg: params.config,
    channel: promptChannel,
    accountId: external ? external.context.accountId : params.accountId,
    requester: external
      ? { agentTo: external.context.to, agentThreadId: external.context.threadId }
      : params.requester,
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
        : { preparedRepoRoot: await resolveSystemPromptRepoRoot(params) }),
    preparedGitCoauthorPrompt,
    preparedSessionEntry: params.preparedSessionEntry,
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
      chatType: external ? external.origin.chatType : params.chatType,
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
