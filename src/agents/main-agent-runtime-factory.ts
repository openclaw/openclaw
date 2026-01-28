import type { ClawdbrainConfig } from "../config/config.js";
import { createSdkAgentRuntime } from "./claude-agent-sdk/sdk-agent-runtime.js";
import { loadSessionHistoryForSdk } from "./claude-agent-sdk/sdk-session-history.js";
import type { SdkConversationTurn } from "./claude-agent-sdk/sdk-runner.types.js";
import type { AgentRuntime } from "./agent-runtime.js";
import { createClawdbrainCodingTools } from "./pi-tools.js";
import type { AnyAgentTool } from "./tools/common.js";
import { resolveSandboxContext } from "./sandbox.js";
import type { SandboxContext } from "./sandbox.js";

export type MainAgentRuntimeKind = "pi" | "sdk";

export function resolveMainAgentRuntimeKind(config?: ClawdbrainConfig): MainAgentRuntimeKind {
  const configured = config?.agents?.main?.runtime ?? config?.agents?.defaults?.runtime;
  return configured === "sdk" ? "sdk" : "pi";
}

export type CreateSdkMainAgentRuntimeParams = {
  config?: ClawdbrainConfig;
  sessionKey?: string;
  sessionFile: string;
  workspaceDir: string;
  agentDir?: string;
  abortSignal?: AbortSignal;

  // Message + threading context for tool policy + routing.
  messageProvider?: string;
  agentAccountId?: string;
  messageTo?: string;
  messageThreadId?: string | number;
  groupId?: string | null;
  groupChannel?: string | null;
  groupSpace?: string | null;
  spawnedBy?: string | null;
  senderId?: string | null;
  senderName?: string | null;
  senderUsername?: string | null;
  senderE164?: string | null;
  currentChannelId?: string;
  currentThreadTs?: string;
  replyToMode?: "off" | "first" | "all";
  hasRepliedRef?: { value: boolean };

  // Optional overrides for testing / callers that already resolved these.
  sandbox?: SandboxContext | null;
  tools?: AnyAgentTool[];
  conversationHistory?: SdkConversationTurn[];
};

export async function createSdkMainAgentRuntime(
  params: CreateSdkMainAgentRuntimeParams,
): Promise<AgentRuntime> {
  const sandbox =
    params.sandbox ??
    (await resolveSandboxContext({
      config: params.config,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
    }));

  const tools =
    params.tools ??
    createClawdbrainCodingTools({
      config: params.config,
      sandbox,
      workspaceDir: params.workspaceDir,
      sessionKey: params.sessionKey,
      agentDir: params.agentDir,
      abortSignal: params.abortSignal,
      messageProvider: params.messageProvider,
      agentAccountId: params.agentAccountId,
      messageTo: params.messageTo,
      messageThreadId: params.messageThreadId,
      groupId: params.groupId,
      groupChannel: params.groupChannel,
      groupSpace: params.groupSpace,
      spawnedBy: params.spawnedBy,
      senderId: params.senderId,
      senderName: params.senderName,
      senderUsername: params.senderUsername,
      senderE164: params.senderE164,
      currentChannelId: params.currentChannelId,
      currentThreadTs: params.currentThreadTs,
      replyToMode: params.replyToMode,
      hasRepliedRef: params.hasRepliedRef,
    });

  const conversationHistory =
    params.conversationHistory ??
    loadSessionHistoryForSdk({
      sessionFile: params.sessionFile,
    });

  const sdkCfg = params.config?.agents?.main?.sdk;

  return createSdkAgentRuntime({
    tools: tools as AnyAgentTool[],
    conversationHistory,
    hooksEnabled: sdkCfg?.hooksEnabled ?? true,
    sdkOptions: sdkCfg?.options,
  });
}
