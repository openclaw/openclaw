import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { resolveOwnerOnlyToolPolicy } from "./owner-tool-policy.js";
import {
  getGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "./tools/gateway-caller-context.js";
import { prepareSessionPortalToolTarget } from "./tools/session-portal-target.js";

/** Prepare one caller's available capabilities and preserve its policy through delegation. */
export function prepareCodingToolsGatewayAccess(params: {
  options?: OpenClawCodingToolsOptions;
  agentId?: string;
  sessionKey?: string;
  accountId?: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  hasAutomationGrant?: boolean;
}) {
  const { options, agentId, sessionKey, capabilityProfile } = params;
  const operatorAuthority = getGatewayToolCallerIdentity()?.operatorAuthority;
  const sessionPortalTarget =
    options?.senderIsOwner === false && !options.sandbox?.enabled
      ? prepareSessionPortalToolTarget({ sessionKey, agentId, sessionId: options.sessionId })
      : undefined;
  const identity =
    options && agentId && sessionKey?.trim()
      ? {
          agentId,
          sessionKey: sessionKey.trim(),
          operatorAuthority,
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
  return {
    sessionPortalTarget,
    ownerOnlyCoreToolPolicy: resolveOwnerOnlyToolPolicy({
      senderIsOwner: options?.senderIsOwner,
      operatorAuthority,
      sessionPortalTarget,
      hasAutomationGrant: params.hasAutomationGrant,
    }),
    wrapGatewayCaller: (tool: Parameters<typeof wrapToolWithGatewayCallerIdentity>[0]) =>
      wrapToolWithGatewayCallerIdentity(tool, identity),
  };
}
