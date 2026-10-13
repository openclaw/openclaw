import { normalizeConversationReadInvocationOrigin } from "../channels/plugins/conversation-read-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  assertMemoryAudienceCurrent,
  assertMemoryAudienceSession,
} from "../plugins/memory-audience.js";
import { normalizeDeliveryContext } from "../utils/delivery-context.shared.js";
import { resolveAgentWorkspaceDir, resolveSessionAgentIds } from "./agent-scope.js";
import { modelKey } from "./model-ref-shared.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import { resolveWorkspaceRoot } from "./workspace-dir.js";

export type OpenClawPluginToolOptions = Pick<
  OpenClawToolsOptions,
  | "agentSessionKey"
  | "runSessionKey"
  | "runId"
  | "assertInvocationCurrent"
  | "assertInputCommitAllowed"
  | "agentChannel"
  | "agentAccountId"
  | "agentTo"
  | "currentMessagingTarget"
  | "currentChannelId"
  | "agentThreadId"
  | "nativeChannelId"
  | "messageActionTurnCapability"
  | "agentDir"
  | "workspaceDir"
  | "config"
  | "fsPolicy"
  | "modelProvider"
  | "modelId"
  | "requesterSenderId"
  | "senderIsOwner"
  | "memoryAudience"
  | "memoryFlush"
  | "conversationReadOrigin"
  | "requesterAgentIdOverride"
  | "sessionId"
  | "conversationRecall"
  | "oneShotCliRun"
  | "sandboxBrowserBridgeUrl"
  | "allowHostBrowserControl"
  | "sandboxed"
  | "allowGatewaySubagentBinding"
  | "toolBindings"
> & { activeProjectKeys?: readonly string[] };

export function resolveOpenClawPluginToolInputs(params: {
  options?: OpenClawPluginToolOptions;
  resolvedConfig?: OpenClawConfig;
  runtimeConfig?: OpenClawConfig;
  getRuntimeConfig?: () => OpenClawConfig | undefined;
}) {
  const { options, resolvedConfig, runtimeConfig, getRuntimeConfig } = params;
  const sessionKey = options?.runSessionKey ?? options?.agentSessionKey;
  if (options?.memoryAudience) {
    assertMemoryAudienceSession(options.memoryAudience, sessionKey);
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    sessionKey,
    config: resolvedConfig,
    agentId: options?.requesterAgentIdOverride,
  });
  const inferredWorkspaceDir =
    options?.workspaceDir || !resolvedConfig
      ? undefined
      : resolveAgentWorkspaceDir(resolvedConfig, sessionAgentId);
  const workspaceDir = resolveWorkspaceRoot(options?.workspaceDir ?? inferredWorkspaceDir);
  const modelProvider = options?.modelProvider?.trim();
  const modelId = options?.modelId?.trim();
  const activeModel =
    modelProvider || modelId
      ? {
          ...(modelProvider ? { provider: modelProvider } : {}),
          ...(modelId ? { modelId } : {}),
          ...(modelProvider && modelId ? { modelRef: modelKey(modelProvider, modelId) } : {}),
        }
      : undefined;
  // Delivery context is normalized once here so plugin tools receive the same
  // channel/account/thread shape as gateway-delivered agent tools.
  const deliveryContext = normalizeDeliveryContext({
    channel: options?.agentChannel,
    to: options?.agentTo ?? options?.currentMessagingTarget ?? options?.currentChannelId,
    accountId: options?.agentAccountId,
    threadId: options?.agentThreadId,
  });

  return {
    context: {
      config: options?.config,
      runtimeConfig,
      getRuntimeConfig,
      assertInputCommitAllowed: options?.assertInputCommitAllowed,
      fsPolicy: options?.fsPolicy,
      workspaceDir,
      agentDir: options?.agentDir,
      agentId: sessionAgentId,
      sessionKey,
      sessionId: options?.sessionId,
      toolBindings: options?.toolBindings,
      activeProjectKeys: options?.activeProjectKeys,
      conversationRecall: options?.conversationRecall,
      activeModel,
      browser: {
        sandboxBridgeUrl: options?.sandboxBrowserBridgeUrl,
        allowHostControl: options?.allowHostBrowserControl,
      },
      messageChannel: options?.agentChannel,
      agentAccountId: options?.agentAccountId,
      deliveryContext,
      nativeChannelId: options?.nativeChannelId,
      requesterSenderId: options?.requesterSenderId ?? undefined,
      senderIsOwner: options?.senderIsOwner,
      memoryAudience: options?.memoryAudience,
      memoryFlush: options?.memoryFlush,
      assertMemoryAudienceCurrent: options?.memoryAudience
        ? () => assertMemoryAudienceCurrent(options.memoryAudience!)
        : undefined,
      conversationReadOrigin: normalizeConversationReadInvocationOrigin(
        options?.conversationReadOrigin,
      ),
      sandboxed: options?.sandboxed,
      oneShotCliRun: options?.oneShotCliRun,
    },
    allowGatewaySubagentBinding: options?.allowGatewaySubagentBinding,
  };
}
