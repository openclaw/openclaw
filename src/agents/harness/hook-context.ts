/**
 * Builds plugin hook context metadata for native agent harness events.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { DiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
<<<<<<< HEAD
import { buildAgentHookContextIdentityFields } from "../../plugins/hook-agent-context.js";
import type {
  PluginHookAgentContext,
  PluginHookChannelContext,
=======
import type {
  PluginHookAgentContext,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  PluginHookContextWindowSource,
} from "../../plugins/hook-types.js";

/**
 * Input facts used to build the agent portion of plugin hook events.
 *
 * Only stable run/session/model facts are forwarded to plugin hooks; config remains a local
 * construction input so hooks do not accidentally depend on mutable raw configuration.
 */
export type AgentHarnessHookContext = {
<<<<<<< HEAD
  runId?: string;
=======
  runId: string;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  trace?: DiagnosticTraceContext;
  jobId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  workspaceDir?: string;
  modelProviderId?: string;
  modelId?: string;
  messageProvider?: string;
<<<<<<< HEAD
=======
  channel?: string;
  chatId?: string;
  senderId?: string;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  trigger?: string;
  channelId?: string;
  contextTokenBudget?: number;
  contextWindowSource?: PluginHookContextWindowSource;
  contextWindowReferenceTokens?: number;
  config?: OpenClawConfig;
<<<<<<< HEAD
  senderId?: string;
  chatId?: string;
  channel?: string;
  channelContext?: PluginHookChannelContext;
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
};

/** Builds the sparse hook context object passed to agent harness plugin hooks. */
export function buildAgentHookContext(params: AgentHarnessHookContext): PluginHookAgentContext {
  return {
<<<<<<< HEAD
    ...(params.runId ? { runId: params.runId } : {}),
=======
    runId: params.runId,
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ...(params.trace ? { trace: params.trace } : {}),
    ...(params.jobId ? { jobId: params.jobId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    ...(params.modelProviderId ? { modelProviderId: params.modelProviderId } : {}),
    ...(params.modelId ? { modelId: params.modelId } : {}),
    ...(params.messageProvider ? { messageProvider: params.messageProvider } : {}),
    ...(params.channel ? { channel: params.channel } : {}),
<<<<<<< HEAD
=======
    ...(params.chatId ? { chatId: params.chatId } : {}),
    ...(params.senderId ? { senderId: params.senderId } : {}),
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(params.channelId ? { channelId: params.channelId } : {}),
    ...(params.contextTokenBudget ? { contextTokenBudget: params.contextTokenBudget } : {}),
    ...(params.contextWindowSource ? { contextWindowSource: params.contextWindowSource } : {}),
    ...(params.contextWindowReferenceTokens
      ? { contextWindowReferenceTokens: params.contextWindowReferenceTokens }
      : {}),
<<<<<<< HEAD
    ...buildAgentHookContextIdentityFields({
      trigger: params.trigger,
      senderId: params.senderId,
      chatId: params.chatId,
      channelContext: params.channelContext,
    }),
=======
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
  };
}
