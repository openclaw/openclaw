import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import type { PluginHookAgentContext } from "../../plugins/hook-types.js";
import type { RunCliAgentParams } from "./types.js";

export function buildCliPromptBuildHookContext(
  params: RunCliAgentParams,
  prepared: { agentId: string; workspaceDir: string; modelId: string },
): PluginHookAgentContext {
  return {
    runId: params.runId,
    // Reuse the host-owned run trace. A new trace here would break source proofs.
    trace: getActiveDiagnosticTraceContext(),
    agentId: prepared.agentId,
    sessionKey: params.sessionKey,
    sessionId: params.sessionId,
    workspaceDir: prepared.workspaceDir,
    modelProviderId: params.provider,
    modelId: prepared.modelId,
    trigger: params.trigger,
    ...(params.trigger === "user" && params.senderId && params.chatId
      ? {
          requester: {
            senderId: params.senderId,
            conversationId: params.chatId,
            ...(params.chatType ? { chatType: params.chatType } : {}),
            ...(params.messageChannel ? { channel: params.messageChannel } : {}),
            ...(params.agentAccountId ? { accountId: params.agentAccountId } : {}),
            ...(params.senderIsOwner !== undefined ? { senderIsOwner: params.senderIsOwner } : {}),
          },
        }
      : {}),
    inputProvenance: params.inputProvenance,
    ...buildAgentHookContextChannelFields(params),
  };
}
