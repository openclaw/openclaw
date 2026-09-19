import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { wrapToolWithGatewayCallerIdentity } from "./tools/gateway-caller-context.js";

/** Carries the coding surface's prepared policy and requesting route into plugin delegation. */
export function createCodingToolsGatewayCaller(params: {
  options?: OpenClawCodingToolsOptions;
  agentId?: string;
  sessionKey?: string;
  accountId?: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
}) {
  const { options, agentId, sessionKey, capabilityProfile } = params;
  const identity =
    options && agentId && sessionKey?.trim()
      ? {
          agentId,
          sessionKey: sessionKey.trim(),
          assertToolAllowed: (toolName: string) => {
            if (!isConversationToolAllowed(capabilityProfile, toolName)) {
              throw new Error(`${toolName} is not allowed by this conversation's tool policy`);
            }
          },
          ...(options.abortSignal ? { approvalSignals: [options.abortSignal] } : {}),
          turnSourceChannel: resolveGatewayMessageChannel(
            options.messageChannel ?? options.messageProvider,
          ),
          turnSourceTo:
            options.currentMessagingTarget ?? options.currentChannelId ?? options.messageTo,
          turnSourceAccountId: params.accountId,
          turnSourceThreadId: options.currentThreadTs ?? options.messageThreadId,
        }
      : undefined;
  return (tool: Parameters<typeof wrapToolWithGatewayCallerIdentity>[0]) =>
    wrapToolWithGatewayCallerIdentity(tool, identity);
}
