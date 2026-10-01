import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import type { ResolvedConversationCapabilityProfile } from "../conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "../conversation-tool-policy-pipeline.js";
import { buildDeclaredToolAllowlistContext } from "../tool-policy-declared-context.js";
import {
  applyToolPolicyPipeline,
  type ToolPolicyFilterEvent,
  type ToolPolicyPipelineStep,
} from "../tool-policy-pipeline.js";
import { collectExplicitDenylist } from "../tool-policy.js";
import type { AnyAgentTool } from "../tools/common.js";

// Reuse core tool construction's server-verified capability profile: group/sender
// policy can widen access, so model-controlled input must never supply it.
type FinalEffectiveToolPolicyParams = {
  // Filter only added MCP/LSP tools; core wrapping has already lost the WeakMap
  // metadata needed to safely rerun its policy pipeline.
  bundledTools: AnyAgentTool[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  metadataSnapshot?: PluginMetadataSnapshot;
  conversationCapabilityProfile: ResolvedConversationCapabilityProfile;
  warn: (message: string) => void;
  onFilter?: (event: ToolPolicyFilterEvent) => void;
};

export function applyFinalEffectiveToolPolicy(
  params: FinalEffectiveToolPolicyParams,
): AnyAgentTool[] {
  if (params.bundledTools.length === 0) {
    return params.bundledTools;
  }
  const capabilityProfile = params.conversationCapabilityProfile;
  const { trustedGroup } = capabilityProfile.policy;
  // Resolve here for warnings and to strip caller-only group metadata before
  // this pass; resolveGroupToolPolicy re-checks internally for all callers.
  if (trustedGroup.dropped) {
    params.warn(
      "effective tool policy: dropping caller-provided groupId that does not match session-derived group context",
    );
  }
  const policies = resolveConversationToolPolicies({ capabilityProfile });
  // Core tools are absent from this subset but already validated. Suppress only
  // their unavailable warnings; the pipeline still reports unknown entries.
  const pipelineSteps: ToolPolicyPipelineStep[] = buildConversationToolPolicyPipelineSteps({
    capabilityProfile,
    policies,
    includeRuntimeToolPolicy: false,
  }).map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true }));
  return applyToolPolicyPipeline({
    tools: params.bundledTools,
    toolMeta: (tool) => getPluginToolMeta(tool),
    warn: params.warn,
    steps: pipelineSteps,
    onFilter: params.onFilter,
    declaredToolAllowlist: buildDeclaredToolAllowlistContext({
      config: params.config,
      workspaceDir: params.workspaceDir,
      metadataSnapshot: params.metadataSnapshot,
      toolDenylist: collectExplicitDenylist(pipelineSteps.map((step) => step.policy)),
    }),
  });
}
