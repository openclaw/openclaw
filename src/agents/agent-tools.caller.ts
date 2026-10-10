import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import { resolveGatewayMessageChannel } from "../utils/message-channel.js";
import { bindAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { rewrapToolWithBeforeToolCallHook } from "./agent-tools.before-tool-call.wrapper.js";
import type { OpenClawCodingToolsOptions } from "./agent-tools.options.js";
import { isToolWrappedWithBeforeToolCallHook } from "./before-tool-call-metadata.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { captureDelegatedToolPolicyAssertion } from "./delegated-tool-policy.js";
import { createToolPolicyMatcher } from "./tool-policy-match.js";
import { buildPluginToolGroups, expandPolicyWithPluginGroups } from "./tool-policy.js";
import { wrapToolWithGatewayCallerIdentity } from "./tools/gateway-caller-context.js";

/** Carries the coding surface's prepared policy and requesting route into plugin delegation. */
export function createCodingToolsGatewayCaller(params: {
  options?: OpenClawCodingToolsOptions;
  agentId?: string;
  sessionKey?: string;
  accountId?: string;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  sessionEventToolsAllow?: readonly string[];
}) {
  const { options, agentId, sessionKey, capabilityProfile } = params;
  const delegatedPolicy = capabilityProfile.policy.delegatedToolPolicy;
  if (delegatedPolicy && !options?.config) {
    throw new Error("Delegated execution requires its source configuration.");
  }
  const assertDelegationCurrent = options?.config
    ? captureDelegatedToolPolicyAssertion(options.config, delegatedPolicy)
    : undefined;
  const allowedWithoutDelegation = (tool: Parameters<typeof getPluginToolMeta>[0]) =>
    createToolPolicyMatcher(
      expandPolicyWithPluginGroups(
        capabilityProfile.policy.inheritedToolPolicyForSpawn,
        buildPluginToolGroups({ tools: [tool], toolMeta: getPluginToolMeta }),
      ),
    )(tool.name);
  const settleBatch =
    capabilityProfile.policy.requesterPolicySource === "completion-handoff"
      ? options?.trustedInternalHandoff?.settleBatch
      : undefined;
  const identity =
    options && agentId && sessionKey?.trim()
      ? {
          agentId,
          sessionKey: sessionKey.trim(),
          sessionEventToolsAllow: params.sessionEventToolsAllow,
          sessionEventSettings: { permissionMode: options.sessionPermissionPolicy?.mode },
          ...(options.sourceReplyDeliveryMode === "message_tool_only"
            ? { sessionEventDelivery: false as const }
            : {}),
          // The existing source fence rechecks this after tool preparation and at final I/O.
          receiptAuthority: settleBatch?.isCurrent,
          receiptAdmissions: settleBatch?.receiptAdmission
            ? [settleBatch.receiptAdmission]
            : undefined,
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
  return (tool: Parameters<typeof wrapToolWithGatewayCallerIdentity>[0]) => {
    if (!identity || !assertDelegationCurrent || allowedWithoutDelegation(tool)) {
      return wrapToolWithGatewayCallerIdentity(tool, identity);
    }
    const guarded = bindAgentToolSourceExecutionGuard(tool, assertDelegationCurrent);
    // The generic hook fence covers preparation/approval waits; receipt authority
    // also reaches command launch and filesystem final I/O inside the tool.
    return wrapToolWithGatewayCallerIdentity(
      isToolWrappedWithBeforeToolCallHook(guarded)
        ? rewrapToolWithBeforeToolCallHook(guarded)
        : guarded,
      {
        ...identity,
        receiptAuthority: () => {
          assertDelegationCurrent();
          return identity.receiptAuthority?.() ?? true;
        },
      },
    );
  };
}
