/**
 *
 * Keeps optional tool gating separate from tool construction so config and execution contracts decide exposure.
 */
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveEffectiveToolPolicy } from "./agent-tools.policy.js";
import { wrapToolWorkspaceRootGuardWithOptions } from "./agent-tools.read.js";
import { isPrimaryBootstrapRun } from "./bootstrap-routing.js";
import type { resolveConversationQuestionInputMode } from "./conversation-capability-profile.js";
import { resolveRequesterToolPolicies } from "./requester-tool-policy.js";
import { withPreparedSessionCapabilityRead } from "./subagents/spawn/subagent-session-store.js";
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

type ProgressCardToolRegistrationParams = {
  agentId?: string;
  sandboxAgentId?: string;
  agentSessionKey?: string;
  config?: OpenClawConfig;
  modelId?: string;
  modelProvider?: string;
  pluginToolDenylist?: string[];
  runtimeToolAllowlist?: string[];
};

export function prepareProgressCardToolForOpenClawTools(
  params: ProgressCardToolRegistrationParams,
) {
  return withPreparedSessionCapabilityRead(() =>
    shouldIncludeProgressCardToolForOpenClawTools(params),
  );
}

export function shouldIncludeProgressCardToolForOpenClawTools(
  params: ProgressCardToolRegistrationParams,
): boolean {
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
    agentId: params.sandboxAgentId ?? params.agentId,
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
  questionInputMode?: ReturnType<typeof resolveConversationQuestionInputMode>;
  listingClientCaps?: string[];
  config?: OpenClawConfig;
  agentSessionKey?: string;
  pluginToolDenylist?: string[];
};

export function shouldIncludePrimarySessionToolForOpenClawTools(
  toolName: "ask_user" | "secrets",
  params: PrimarySessionToolRegistrationParams,
): boolean {
  if (
    toolName === "ask_user" &&
    ((params.questionInputMode !== "native" && params.questionInputMode !== "buttons") ||
      params.listingClientCaps?.includes(GATEWAY_CLIENT_CAPS.NO_QUESTION_INPUT))
  ) {
    return false;
  }
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
