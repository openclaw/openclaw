/**
 * OpenClaw-owned tool registration filters.
 *
 * Keeps optional tool gating separate from tool construction so config and execution contracts decide exposure.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { wrapToolWorkspaceRootGuardWithOptions } from "./agent-tools.read.js";
import { isPrimaryBootstrapRun } from "./bootstrap-routing.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import type { ToolFsPolicy } from "./tool-fs-policy.js";
import {
  isRuntimeToolAllowed,
  isToolAllowedByPolicies,
  isToolAllowedByPolicyName,
} from "./tool-policy-match.js";
import {
  expandShippedCoreToolPolicyNames,
  mergeAlsoAllowPolicy,
  resolveToolProfilePolicy,
  type ToolPolicyLike,
} from "./tool-policy.js";
import type { AnyAgentTool } from "./tools/common.js";

function expandProgressCardPolicyNames(
  policy: ToolPolicyLike | undefined,
): ToolPolicyLike | undefined {
  return policy
    ? {
        allow: expandShippedCoreToolPolicyNames(policy.allow),
        deny: expandShippedCoreToolPolicyNames(policy.deny),
      }
    : undefined;
}

/** Wraps the nodes tool with a workspace-only output-path guard when policy requires it. */
export function applyNodesToolWorkspaceGuard(
  nodesToolBase: AnyAgentTool,
  options: {
    fsPolicy?: ToolFsPolicy;
    sandboxContainerWorkdir?: string;
    sandboxRoot?: string;
    workspaceDir: string;
  },
): AnyAgentTool {
  if (options.fsPolicy?.workspaceOnly !== true) {
    return nodesToolBase;
  }
  return wrapToolWorkspaceRootGuardWithOptions(
    nodesToolBase,
    options.sandboxRoot ?? options.fsPolicy.root ?? options.workspaceDir,
    {
      containerWorkdir: options.sandboxContainerWorkdir,
      normalizeGuardedPathParams: true,
      pathParamKeys: ["outPath"],
    },
  );
}

/** Decides whether progress_card should be included in the assembled OpenClaw tool set. */
export function shouldIncludeProgressCardToolForOpenClawTools(params: {
  agentId?: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  modelId?: string;
  modelProvider?: string;
  pluginToolDenylist?: string[];
  runtimeToolAllowlist?: string[];
}): boolean {
  // `tools.updatePlan` is the shipped kill switch for the replacement progress_card tool.
  if (params.config?.tools?.updatePlan === false) {
    return false;
  }
  if (
    !isToolAllowedByPolicyName("progress_card", {
      deny: expandShippedCoreToolPolicyNames(params.pluginToolDenylist),
    }) ||
    !isRuntimeToolAllowed("progress_card", params.runtimeToolAllowlist)
  ) {
    return false;
  }
  const effective = resolveEffectiveToolPolicy({
    config: params.config,
    sessionKey: params.agentSessionKey,
    agentId: params.agentId,
    modelProvider: params.modelProvider,
    modelId: params.modelId,
  });
  const profilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.profile),
    effective.profileAlsoAllow,
  );
  const providerProfilePolicy = mergeAlsoAllowPolicy(
    resolveToolProfilePolicy(effective.providerProfile),
    effective.providerProfileAlsoAllow,
  );
  return isToolAllowedByPolicies(
    "progress_card",
    [
      profilePolicy,
      providerProfilePolicy,
      effective.globalPolicy,
      effective.globalProviderPolicy,
      effective.agentPolicy,
      effective.agentProviderPolicy,
      resolveRequesterToolPolicies({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.agentSessionKey,
        senderPolicyMode: "never",
      }).subagentPolicy,
    ].map(expandProgressCardPolicyNames),
  );
}

type PrimarySessionToolRegistrationParams = {
  config?: OpenClawConfig;
  agentSessionKey?: string;
  pluginToolDenylist?: string[];
};

export function shouldIncludePrimarySessionToolForOpenClawTools(
  toolName: "ask_user" | "secrets",
  params: PrimarySessionToolRegistrationParams,
): boolean {
  const sessionKey = params.agentSessionKey?.trim();
  if (!sessionKey) {
    return false;
  }
  const deny = uniqueStrings([
    ...(params.config?.tools?.deny ?? []),
    ...(params.pluginToolDenylist ?? []),
  ]);
  return isPrimaryBootstrapRun(sessionKey) && isToolAllowedByPolicyName(toolName, { deny });
}
