import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import type { SandboxContext } from "./sandbox.js";

/**
 * Resolve the conversation capability profile for a coding-tools build.
 *
 * Prefer the already-resolved sandbox context policy. Recomputing from
 * sessionKey/config can lose the real sandbox agent when callers pass a
 * legacy alias like `main` instead of an agent session key.
 */
export function resolveCodingToolsCapabilityProfile(params: {
  options?: OpenClawCodingToolsOptions;
  sandbox?: SandboxContext;
}): ResolvedConversationCapabilityProfile {
  const { options, sandbox } = params;
  return (
    options?.conversationCapabilityProfile ??
    resolveConversationCapabilityProfile({
      config: options?.config,
      sessionKey: options?.sessionKey,
      runSessionKey: options?.runSessionKey,
      sessionId: options?.sessionId,
      runId: options?.runId,
      agentId: options?.policyAgentId ?? options?.agentId,
      agentDir: options?.agentDir,
      agentAccountId: options?.agentAccountId,
      messageProvider: options?.messageProvider,
      messageChannel: options?.messageChannel,
      chatType: options?.chatType,
      messageTo: options?.messageTo,
      messageThreadId: options?.messageThreadId,
      conversationToolPolicy: options?.conversationToolPolicy,
      currentChannelId: options?.currentChannelId,
      currentMessagingTarget: options?.currentMessagingTarget,
      currentThreadTs: options?.currentThreadTs,
      currentMessageId: options?.currentMessageId,
      groupId: options?.groupId,
      groupChannel: options?.groupChannel,
      groupSpace: options?.groupSpace,
      memberRoleIds: options?.memberRoleIds,
      spawnedBy: options?.spawnedBy,
      senderId: options?.senderId,
      senderName: options?.senderName,
      senderUsername: options?.senderUsername,
      senderE164: options?.senderE164,
      senderIsOwner: options?.senderIsOwner,
      modelProvider: options?.modelProvider,
      modelId: options?.modelId,
      modelApi: options?.modelApi,
      modelContextWindowTokens: options?.modelContextWindowTokens,
      modelHasVision: options?.modelHasVision,
      workspaceDir: options?.workspaceDir,
      cwd: options?.cwd,
      spawnWorkspaceDir: options?.spawnWorkspaceDir,
      skillsSnapshot: options?.skillsSnapshot,
      sandboxToolPolicy: sandbox?.tools,
      runtimeToolAllowlist: options?.runtimeToolAllowlist,
      runtimePluginToolGrant: options?.runtimePluginToolGrant,
      inheritRuntimeToolAllowlist: options?.inheritRuntimeToolAllowlist,
      inputProvenance: options?.inputProvenance,
      trustedInternalHandoff: options?.trustedInternalHandoff,
      scheduledToolPolicy: options?.scheduledToolPolicy,
      pluginMetadataSnapshot: options?.preparedModelRuntime?.metadataSnapshot,
    })
  );
}
