import {
  asNonArrayRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { scanPolicyRouting, type PolicyRoutingRules } from "./policy-routing.js";
import {
  scanPolicyChannels,
  scanPolicyMcpServers,
  scanPolicyModelProviders,
  scanPolicyModelRefs,
  scanPolicyNetwork,
} from "./policy-state-core.js";
import {
  scanPolicyAuthProfiles,
  scanPolicyDataHandling,
  scanPolicySecrets,
} from "./policy-state-data.js";
import { scanPolicyExecApprovals } from "./policy-state-exec-approvals.js";
import { scanPolicyGatewayExposure } from "./policy-state-gateway.js";
import { collectPolicyAgentContexts } from "./policy-state-helpers.js";
import { scanPolicyIngress } from "./policy-state-ingress.js";
import { scanPolicySandboxPosture } from "./policy-state-sandbox.js";
import {
  AGENT_WORKSPACE_POLICY_TOOLS,
  readStringArray,
  scanPolicyToolPosture,
} from "./policy-state-tool-posture.js";
import { scanPolicyTools } from "./policy-state-tools.js";
import type { PolicyAgentWorkspaceEvidence, PolicyEvidence } from "./policy-state-types.js";
import { toolListCoversTool } from "./tool-policy-conformance.js";

function scanPolicyAgentWorkspace(
  cfg: Record<string, unknown>,
): readonly PolicyAgentWorkspaceEvidence[] {
  const entries: PolicyAgentWorkspaceEvidence[] = [];
  for (const context of collectPolicyAgentContexts(cfg, "defaults")) {
    const explicitSandboxMode = readString(context.sandbox.mode);
    const inheritedSandboxMode = readString(context.inheritedSandbox.mode);
    const sandboxMode = explicitSandboxMode ?? inheritedSandboxMode ?? "off";
    const sandboxModeCoversAgentMain = sandboxMode === "all";
    const sandboxModeSource =
      explicitSandboxMode !== undefined
        ? `${context.workspaceSourceBase}/sandbox/mode`
        : "oc://openclaw.config/agents/defaults/sandbox/mode";
    const explicitWorkspaceAccess = readString(context.sandbox.workspaceAccess);
    const inheritedWorkspaceAccess = readString(context.inheritedSandbox.workspaceAccess);
    entries.push({
      id: `${context.id}-workspace-access`,
      kind: "workspaceAccess",
      source:
        explicitWorkspaceAccess !== undefined
          ? `${context.workspaceSourceBase}/sandbox/workspaceAccess`
          : "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
      scope: context.scope,
      ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
      value: explicitWorkspaceAccess ?? inheritedWorkspaceAccess ?? "none",
      sandboxMode,
      sandboxModeSource,
      sandboxEnabled: sandboxModeCoversAgentMain,
      explicit: explicitWorkspaceAccess !== undefined,
    });

    const localSandboxToolDeny = configuredSandboxToolDenyEntries(context.tools);
    const inheritedSandboxToolDeny = configuredSandboxToolDenyEntries(context.inheritedTools);
    const denySources = [
      {
        entries: readStringArray(context.tools.deny),
        source: `${context.toolsSourceBase}/deny`,
      },
      {
        entries: readStringArray(context.inheritedTools.deny),
        source: "oc://openclaw.config/tools/deny",
      },
      ...(sandboxModeCoversAgentMain
        ? [
            localSandboxToolDeny !== undefined
              ? {
                  entries: localSandboxToolDeny,
                  source: `${context.toolsSourceBase}/sandbox/tools/deny`,
                }
              : {
                  entries: inheritedSandboxToolDeny ?? [],
                  source: "oc://openclaw.config/tools/sandbox/tools/deny",
                },
          ]
        : []),
    ];
    for (const tool of AGENT_WORKSPACE_POLICY_TOOLS) {
      const match = denySources.find((entry) => toolListCoversTool(entry.entries, tool));
      entries.push({
        id: `${context.id}-tool-${tool}`,
        kind: "toolDeny",
        source: match?.source ?? `${context.toolsSourceBase}/deny`,
        scope: context.scope,
        ...(context.agentId === undefined ? {} : { agentId: context.agentId }),
        tool,
        denied: match !== undefined,
        explicit: match !== undefined,
      });
    }
  }
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function configuredSandboxToolDenyEntries(
  tools: Record<string, unknown>,
): readonly string[] | undefined {
  const sandbox = asNonArrayRecord(tools.sandbox);
  const sandboxTools = asNonArrayRecord(sandbox.tools);
  return Array.isArray(sandboxTools.deny) ? readStringArray(sandboxTools.deny) : undefined;
}

type PolicyEvidenceOptions = {
  readonly toolsRaw?: string;
  readonly includeIngress?: boolean;
  readonly includeGatewayExposure?: boolean;
  readonly includeAgentWorkspace?: boolean;
  readonly includeDataHandling?: boolean;
  readonly includeToolPosture?: boolean;
  readonly includeSandboxPosture?: boolean;
  readonly includeSecrets?: boolean;
  readonly includeAuthProfiles?: boolean;
  readonly execApprovalsRaw?: string | null;
  readonly includeExecApprovals?: boolean;
  readonly routing?: PolicyRoutingRules;
};

export function collectPolicyEvidence(
  cfg: Record<string, unknown>,
  options: PolicyEvidenceOptions = {},
): PolicyEvidence {
  return {
    channels: scanPolicyChannels(cfg),
    mcpServers: scanPolicyMcpServers(cfg),
    modelProviders: scanPolicyModelProviders(cfg),
    modelRefs: scanPolicyModelRefs(cfg),
    network: scanPolicyNetwork(cfg),
    ...(options.includeIngress === false ? {} : { ingress: scanPolicyIngress(cfg) }),
    ...(options.includeGatewayExposure === false
      ? {}
      : { gatewayExposure: scanPolicyGatewayExposure(cfg) }),
    ...(options.includeAgentWorkspace === false
      ? {}
      : { agentWorkspace: scanPolicyAgentWorkspace(cfg) }),
    ...(options.includeDataHandling === false ? {} : { dataHandling: scanPolicyDataHandling(cfg) }),
    ...(options.includeToolPosture === false ? {} : { toolPosture: scanPolicyToolPosture(cfg) }),
    ...(options.includeSandboxPosture === false
      ? {}
      : { sandboxPosture: scanPolicySandboxPosture(cfg) }),
    ...(options.includeSecrets === false ? {} : { secrets: scanPolicySecrets(cfg) }),
    ...(options.includeAuthProfiles === false ? {} : { authProfiles: scanPolicyAuthProfiles(cfg) }),
    ...(options.includeExecApprovals === false || options.execApprovalsRaw === undefined
      ? {}
      : {
          execApprovals:
            options.execApprovalsRaw === null
              ? []
              : scanPolicyExecApprovals(options.execApprovalsRaw),
        }),
    ...(options.routing === undefined ? {} : { routing: scanPolicyRouting(cfg, options.routing) }),
    ...(options.toolsRaw === undefined ? {} : { tools: scanPolicyTools(options.toolsRaw) }),
  };
}

export { createPolicyAttestation, policyDocumentHash } from "./policy-state-attestation.js";
export type {
  PolicyAgentWorkspaceEvidence,
  PolicyAuthProfileEvidence,
  PolicyDataHandlingEvidence,
  PolicyEvidence,
  PolicyExecApprovalEvidence,
  PolicyIngressEvidence,
  PolicySandboxPostureEvidence,
  PolicyToolPostureEvidence,
} from "./policy-state-types.js";
