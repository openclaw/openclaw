import { filterToolsByMessageProvider } from "./agent-tools.message-provider-policy.js";
import type { InternalCodingToolsOptions } from "./agent-tools.options.js";
import type { AnyAgentTool } from "./agent-tools.types.js";
import { resolveAutomationsRunScope } from "./automations-run-scope.js";
import type { ResolvedConversationCapabilityProfile } from "./conversation-capability-profile.js";
import { isConversationToolAllowed } from "./conversation-tool-policy-pipeline.js";
import { applyGatewayToolPolicy } from "./gateway-tool-policy.js";
import { hasRestrictiveAllowPolicy, replaceWithEffectiveToolAllowlist } from "./tool-policy.js";
import { AUTOMATIONS_TOOL_NAME } from "./tools/automations-tool-name.js";
import { getGatewayToolCallerIdentity } from "./tools/gateway-caller-context.js";
import { githubPublishToolDefinition } from "./tools/github-publish-tool.js";

function hasSelfScopedAutomations(options?: InternalCodingToolsOptions): boolean {
  // Native controllers can retain the admitted caller before projecting its run into options.
  return Boolean(
    resolveAutomationsRunScope(options).selfJobId ??
    resolveAutomationsRunScope(getGatewayToolCallerIdentity()).selfJobId,
  );
}

/** A parent's self-only grant is not a grant to work it creates. */
export function childToolDenylist(
  options: InternalCodingToolsOptions | undefined,
  requesterToolDenylist: string[],
  capabilityProfile: ResolvedConversationCapabilityProfile,
): string[] {
  return requesterToolDenylist.concat(
    capabilityProfile.policy.inheritedToolPolicyForSpawn?.deny ?? [],
    hasSelfScopedAutomations(options) ? [AUTOMATIONS_TOOL_NAME] : [],
  );
}

/** Record parent restrictions for future children without adding callable parent tools. */
export function captureChildToolAllowlist(params: {
  options?: InternalCodingToolsOptions;
  capabilityProfile: ResolvedConversationCapabilityProfile;
  tools: AnyAgentTool[];
  inheritedToolAllowlist: string[];
  includeOpenClawTools: boolean;
  isMemoryFlushRun: boolean;
}): void {
  const { options, capabilityProfile } = params;
  const captureAllowlist =
    capabilityProfile.policy.inheritancePolicies.some(hasRestrictiveAllowPolicy);
  const extraNames = options?.additionalInheritedToolNamesRef ?? [];
  extraNames.length = 0;
  // A parent may have no repository while its child receives a worktree.
  // Preserve publication only when the parent's policy permits it; the
  // child's tool assembly checks its own repository.
  if (
    (captureAllowlist || options?.additionalInheritedToolNamesRef) &&
    params.includeOpenClawTools &&
    !params.isMemoryFlushRun &&
    options?.githubPublicationAvailable === false
  ) {
    const permitted = filterToolsByMessageProvider(
      [githubPublishToolDefinition],
      options?.toolPolicyMessageProvider ?? options?.messageProvider,
    ).filter(({ name }) => isConversationToolAllowed(capabilityProfile, name));
    extraNames.push(...applyGatewayToolPolicy(permitted, options?.config).map((tool) => tool.name));
  }
  // An empty native allowlist adds no allow restriction; deny rules still apply.
  if (captureAllowlist) {
    const tools = hasSelfScopedAutomations(options)
      ? params.tools.filter((tool) => tool.name !== AUTOMATIONS_TOOL_NAME)
      : params.tools;
    replaceWithEffectiveToolAllowlist(params.inheritedToolAllowlist, [
      ...tools,
      ...extraNames.map((name) => ({ name })),
    ]);
  }
}
