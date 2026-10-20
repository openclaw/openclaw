import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { OpenClawToolsOptions } from "./openclaw-tools.types.js";
import type { AnyAgentTool } from "./tools/common.js";
import {
  createConversationsListTool,
  createConversationsSendTool,
  createConversationsTurnTool,
} from "./tools/conversation-tools.js";
import { createGatewayTool } from "./tools/gateway-tool.js";
import { createOpenClawDelegateToolsForRun } from "./tools/openclaw-delegate-tool.js";
import { createPersonalInstructionsTool } from "./tools/personal-instructions-tool.js";
import { createPluginsTool } from "./tools/plugins-tool.js";
import { createPresenceTool } from "./tools/presence-tool.js";
import { createSessionsSendTool } from "./tools/sessions-send-tool.js";

/** Gateway-owned operations are not standalone embedded-host capabilities. */
export function createHostedGatewayTools(
  embedded: boolean,
  sessionAgentId: string,
  options?: OpenClawToolsOptions,
  preparedDelegateTools?: AnyAgentTool[],
  personalInstructionsEnabled = false,
): AnyAgentTool[] {
  if (embedded) {
    return [];
  }
  return [
    createPresenceTool({ runId: options?.runId }),
    createGatewayTool({
      allowConfigReads: options?.gatewayConfigReadAllowed === true,
      senderIsOwner: options?.senderIsOwner,
      requesterSenderId: options?.requesterSenderId,
    }),
    createPluginsTool({
      sessionId: options?.sessionId,
      runId: options?.runId,
      onYield: options?.onYield,
    }),
    ...(preparedDelegateTools ?? createOpenClawDelegateToolsForRun({ ...options, sessionAgentId })),
    ...(personalInstructionsEnabled ? [createPersonalInstructionsTool(sessionAgentId)] : []),
  ];
}

export function createHostedConversationTools(
  options: OpenClawToolsOptions | undefined,
  sessionAgentId: string,
  sessionConfig: OpenClawConfig | undefined,
): AnyAgentTool[] {
  return [
    ...[createConversationsListTool, createConversationsSendTool, createConversationsTurnTool].map(
      (createTool) =>
        createTool({
          ...options,
          agentId: sessionAgentId,
          agentSessionId: options?.sessionId,
        }),
    ),
    // Keep the in-process caller so materialized agent roots retain their creation stamp.
    createSessionsSendTool({
      ...options,
      requesterTurnRunId: options?.runId,
      agentId: sessionAgentId,
      // Match sessions_spawn: spawned children record the durable run
      // session as spawnedBy, so the parent check must use the same key.
      agentSessionKey: options?.runSessionKey ?? options?.agentSessionKey,
      agentSessionId: options?.sessionId,
      requesterOrigin: {
        channel: options?.agentChannel,
        accountId: options?.agentAccountId,
        to: options?.currentMessagingTarget ?? options?.currentChannelId ?? options?.agentTo,
        threadId: options?.currentThreadTs ?? options?.agentThreadId,
      },
      config: sessionConfig,
    }),
  ];
}
