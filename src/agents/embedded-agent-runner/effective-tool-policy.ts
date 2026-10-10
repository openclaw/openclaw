import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { getPluginToolMeta } from "../../plugins/tool-metadata.js";
import {
  buildSafeToolName,
  normalizeReservedToolNames,
  safeToolNameGlob,
  TOOL_NAME_SEPARATOR,
} from "../agent-bundle-mcp-names.js";
import type { McpToolCatalogDiagnostic } from "../agent-bundle-mcp-types.js";
import type { ResolvedConversationCapabilityProfile } from "../conversation-capability-profile.js";
import {
  buildConversationToolPolicyPipelineSteps,
  resolveConversationToolPolicies,
} from "../conversation-tool-policy-pipeline.js";
import { buildDeclaredToolAllowlistContext } from "../tool-policy-declared-context.js";
import { policiesAdmitToolNamespace } from "../tool-policy-match.js";
import { applyToolPolicyPipeline, type ToolPolicyFilterEvent } from "../tool-policy-pipeline.js";
import {
  collectExplicitDenylist,
  expandPolicyWithPluginGroups,
  readToolAllowlistIntersection,
  type ToolPolicyLike,
} from "../tool-policy.js";
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
  const pipelineSteps = buildConversationToolPolicyPipelineSteps({
    capabilityProfile,
    policies,
    includeRuntimeToolPolicy: false,
  }).map((step) => Object.assign({}, step, { suppressUnavailableCoreToolWarning: true }));
  return applyToolPolicyPipeline({
    tools: params.bundledTools,
    toolMeta: getPluginToolMeta,
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

/**
 * Allow/deny layers one boundary applies to bundle MCP tools, as data a later
 * boundary can carry: layers must be judged together, since each one alone can
 * admit a different tool of a server while their intersection admits none.
 */
export function buildBundleMcpPolicyLayers(params: {
  conversationCapabilityProfile?: ResolvedConversationCapabilityProfile;
  toolsAllow?: string[];
  /** Names other tools already hold; `buildSafeToolName` renames an MCP tool that collides. */
  reservedToolNames?: readonly string[];
}): ToolPolicyLike[] {
  const capabilityProfile = params.conversationCapabilityProfile;
  const allowlist = params.toolsAllow;
  const restrictions = allowlist ? (readToolAllowlistIntersection(allowlist) ?? [allowlist]) : [];
  return [
    // `applyEmbeddedAttemptToolsAllow` runs first for real bundle tools: it
    // intersects independent restrictions and reads an empty one as "no tools",
    // where a pipeline layer's empty allow list means allow-all.
    ...restrictions.map((allow) => (allow.length > 0 ? { allow } : { deny: ["*"] })),
    ...(capabilityProfile
      ? buildConversationToolPolicyPipelineSteps({
          capabilityProfile,
          policies: resolveConversationToolPolicies({ capabilityProfile }),
          includeRuntimeToolPolicy: false,
        }).flatMap((step) => step.policy ?? [])
      : []),
    // A failed server's tool whose safe name is already taken would have come
    // out renamed (`-2`), so an exact allow of the taken name admits none of it.
    ...(params.reservedToolNames ? [{ deny: [...params.reservedToolNames] }] : []),
  ];
}

/**
 * Whether some tool of a failed bundle MCP server could still reach the model. A
 * failed catalog load leaves its tool names unknown, so every gate healthy
 * discovery applies is judged together over the server namespace: the effective
 * policy layers (`layers`, including names other tools already hold, around which
 * a colliding MCP tool is renamed), the server's own `toolFilter`, and the
 * session's exact-name denials. Session `mcpServers` overrides need no gate here:
 * `loadSessionMcpConfig` drops unselected servers before a runtime, and so a
 * diagnostic, can exist for them.
 */
export function createBundleMcpServerPolicyMatcher(
  layers: readonly ToolPolicyLike[],
  reservedToolNames?: readonly string[],
): (
  diagnostic: Pick<McpToolCatalogDiagnostic, "safeServerName" | "toolFilter" | "deniedToolNames">,
) => boolean {
  const reservedNames = normalizeReservedToolNames(reservedToolNames);
  return ({ safeServerName, toolFilter, deniedToolNames }) => {
    // The failed server materialized no tools, so its namespace stands in for
    // the `bundle-mcp` plugin id every MCP tool carries: `bundle-mcp` and
    // `group:plugins` entries then expand as they do for a healthy server.
    const prefix = `${safeServerName}${TOOL_NAME_SEPARATOR}`;
    const namespaceTools = [`${prefix}*`];
    const groups = { all: namespaceTools, byPlugin: new Map([["bundle-mcp", namespaceTools]]) };
    // Healthy discovery applies the server's tool filter, then the session's
    // exact-name denials, to raw names first; here they are one more layer over
    // the safe names those raw names become, judged with the rest so no layer
    // admits a tool alone. An empty `include` restricts nothing. An exact raw name
    // has one known safe name, collision suffix (`-2`) for an already-taken name
    // included; only a `*` pattern stands for names the failed load left unknown.
    const toExact = (name: string) =>
      buildSafeToolName({ serverName: safeServerName, toolName: name, reservedNames });
    const toGlob = (pattern: string) =>
      pattern.includes("*") ? safeToolNameGlob(safeServerName, pattern) : toExact(pattern);
    return policiesAdmitToolNamespace(prefix, [
      ...layers.map((policy) => expandPolicyWithPluginGroups(policy, groups)),
      {
        allow: toolFilter?.include?.map(toGlob),
        deny: [...(toolFilter?.exclude ?? []).map(toGlob), ...(deniedToolNames ?? []).map(toExact)],
      },
    ]);
  };
}
