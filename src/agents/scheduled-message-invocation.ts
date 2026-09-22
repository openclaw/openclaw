import { getRuntimeConfigSnapshot } from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { logWarn } from "../logger.js";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import {
  resolveConversationCapabilityProfile,
  type ResolvedConversationCapabilityProfile,
} from "./conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "./conversation-tool-policy-pipeline.js";
import type { ScheduledToolPolicyContext } from "./scheduled-tool-policy.js";
import { applyToolPolicyPipeline } from "./tool-policy-pipeline.js";
import type { DeclaredToolAllowlistContext, ToolPolicyLike } from "./tool-policy.js";

/** Admit each new invocation against published policy without changing an accepted invocation. */
export function createScheduledMessageInvocationAdmission(params: {
  config?: OpenClawConfig;
  isAllowed: (config: OpenClawConfig) => boolean;
}): () => OpenClawConfig {
  let cached: { config: OpenClawConfig; allowed: boolean } | undefined;
  return () => {
    const config = getRuntimeConfigSnapshot() ?? params.config;
    if (!config) {
      throw new Error("Scheduled message tools require an active runtime configuration.");
    }
    if (cached?.config !== config) {
      cached = { config, allowed: params.isAllowed(config) };
    }
    if (!cached.allowed) {
      throw new Error("Scheduled message invocation is not allowed by the current tool policy.");
    }
    return config;
  };
}

/** Reuse the assembled embedded catalog and resource ceilings for prospective message policy. */
export function createEmbeddedMessageInvocationPolicy(params: {
  config?: OpenClawConfig;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  runtimeProfileAlsoAllow: string[];
  toolSearchControlAllowlist: string[];
  scheduledToolPolicy?: ScheduledToolPolicyContext;
  pluginMetadataSnapshot?: Parameters<
    typeof resolveConversationCapabilityProfile
  >[0]["pluginMetadataSnapshot"];
  ownerOnlyCoreToolPolicy?: ToolPolicyLike;
  catalog: () => {
    tools: AnyAgentTool[];
    declaredToolAllowlist?: DeclaredToolAllowlistContext;
    unavailableCoreToolReason?: string;
  };
  isAvailable: () => boolean;
}) {
  const policies = resolveConversationToolPolicies({
    capabilityProfile: params.capabilityProfile,
    additionalProfileAllow: params.runtimeProfileAlsoAllow,
    additionalPolicyAllow: params.toolSearchControlAllowlist,
  });
  const filter = (currentProfile = params.capabilityProfile): AnyAgentTool[] => {
    const currentPolicies =
      currentProfile === params.capabilityProfile
        ? policies
        : resolveConversationToolPolicies({
            capabilityProfile: currentProfile,
            additionalProfileAllow: params.runtimeProfileAlsoAllow,
            additionalPolicyAllow: params.toolSearchControlAllowlist,
          });
    const { tools, declaredToolAllowlist, unavailableCoreToolReason } = params.catalog();
    return applyToolPolicyPipeline({
      tools,
      toolMeta: (tool) => getPluginToolMeta(tool),
      warn: logWarn,
      steps: buildConversationToolPolicyPipelineSteps({
        capabilityProfile: currentProfile,
        policies: {
          ...currentPolicies,
          // Resource and inherited ceilings belong to the assembled turn.
          groupPolicy: policies.groupPolicy,
          senderPolicy: policies.senderPolicy,
          sandboxPolicy: policies.sandboxPolicy,
          subagentPolicy: policies.subagentPolicy,
          runtimeToolPolicy: policies.runtimeToolPolicy,
          inheritedToolPolicy: policies.inheritedToolPolicy,
        },
        additionalStepsAfterSandbox: [
          {
            policy: params.ownerOnlyCoreToolPolicy,
            label: "gateway sender owner-only tools",
            unavailableCoreToolReason,
          },
        ],
        includeRuntimeToolPolicy: true,
        unavailableCoreToolReason,
      }),
      declaredToolAllowlist,
    });
  };
  return {
    filter,
    admit: createScheduledMessageInvocationAdmission({
      config: params.config,
      isAllowed: (config) => {
        const profile = params.capabilityProfile;
        const currentProfile =
          config === params.config
            ? profile
            : resolveConversationCapabilityProfile({
                ...profile.conversation,
                config,
                agentId: profile.policy.agentId,
                sessionKey: profile.policy.sessionKey,
                agentAccountId: profile.serviceIdentity.accountId,
                modelProvider: profile.model.provider,
                modelId: profile.model.id,
                senderIsOwner: profile.sender.isOwner,
                scheduledToolPolicy: params.scheduledToolPolicy,
                runtimePluginToolGrant: profile.policy.runtimePluginToolGrant,
                pluginMetadataSnapshot: params.pluginMetadataSnapshot,
              });
        return (
          params.isAvailable() && filter(currentProfile).some((tool) => tool.name === "message")
        );
      },
    }),
  };
}
