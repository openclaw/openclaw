import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { applyGatewayToolPolicy } from "./gateway-tool-policy.js";
import { hasRestrictiveAllowPolicy, replaceWithEffectiveToolAllowlist } from "./tool-policy.js";

export type InheritedToolPolicyDefinition = Pick<AnyAgentTool, "name" | "parameters"> & {
  pluginMetadata?: { pluginId: string; policyGroups?: readonly string[] };
};

/** Record parent restrictions for future children without adding callable parent tools. */
export function captureChildToolAllowlist(params: {
  options?: InternalCodingToolsOptions;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  tools: AnyAgentTool[];
  inheritedToolAllowlist: string[];
  policyDefinitions: readonly InheritedToolPolicyDefinition[];
  includeOpenClawTools: boolean;
  isMemoryFlushRun: boolean;
}): void {
  const { options, capabilityProfile } = params;
  const captureAllowlist =
    capabilityProfile.policy.inheritancePolicies.some(hasRestrictiveAllowPolicy);
  const extraNames = options?.additionalInheritedToolNamesRef ?? [];
  extraNames.length = 0;
  // Factories can describe tools unavailable in this workspace. Children still
  // construct their own tools, constrained by this parent's policy ceiling.
  if (
    (captureAllowlist || options?.additionalInheritedToolNamesRef) &&
    params.includeOpenClawTools &&
    !params.isMemoryFlushRun
  ) {
    const permitted = filterToolsByMessageProvider(
      [...params.policyDefinitions],
      options?.toolPolicyMessageProvider ?? options?.messageProvider,
    ).filter(({ name, pluginMetadata }) =>
      isConversationToolAllowed(capabilityProfile, name, pluginMetadata),
    );
    extraNames.push(...applyGatewayToolPolicy(permitted, options?.config).map((tool) => tool.name));
  }
  // An empty native allowlist adds no allow restriction; deny rules still apply.
  if (captureAllowlist) {
    replaceWithEffectiveToolAllowlist(params.inheritedToolAllowlist, [
      ...params.tools,
      ...extraNames.map((name) => ({ name })),
    ]);
  }
}
