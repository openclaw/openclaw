// Policy plugin agent workspace evidence.
import {
  asNonArrayRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { collectPolicyAgentContexts, type PolicyAgentContext } from "./policy-state-helpers.js";
import { AGENT_WORKSPACE_POLICY_TOOLS, readStringArray } from "./policy-state-tool-posture.js";
import type { PolicyAgentWorkspaceEvidence } from "./policy-state-types.js";
import { toolListCoversTool } from "./tool-policy-conformance.js";

export function scanPolicyAgentWorkspace(
  cfg: Record<string, unknown>,
): readonly PolicyAgentWorkspaceEvidence[] {
  const entries: PolicyAgentWorkspaceEvidence[] = [];
  for (const context of collectPolicyAgentContexts(cfg, "defaults")) {
    pushAgentWorkspaceEvidence(entries, context);
  }
  return entries.toSorted((a, b) => a.source.localeCompare(b.source) || a.id.localeCompare(b.id));
}

function pushAgentWorkspaceEvidence(
  entries: PolicyAgentWorkspaceEvidence[],
  params: PolicyAgentContext<"defaults">,
): void {
  const explicitSandboxMode = readString(params.sandbox.mode);
  const inheritedSandboxMode = readString(params.inheritedSandbox.mode);
  const sandboxMode = explicitSandboxMode ?? inheritedSandboxMode ?? "off";
  const sandboxModeCoversAgentMain = sandboxMode === "all";
  const sandboxModeSource =
    explicitSandboxMode !== undefined
      ? `${params.workspaceSourceBase}/sandbox/mode`
      : "oc://openclaw.config/agents/defaults/sandbox/mode";
  const explicitWorkspaceAccess = readString(params.sandbox.workspaceAccess);
  const inheritedWorkspaceAccess = readString(params.inheritedSandbox.workspaceAccess);
  entries.push({
    id: `${params.id}-workspace-access`,
    kind: "workspaceAccess",
    source:
      explicitWorkspaceAccess !== undefined
        ? `${params.workspaceSourceBase}/sandbox/workspaceAccess`
        : "oc://openclaw.config/agents/defaults/sandbox/workspaceAccess",
    scope: params.scope,
    ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
    value: explicitWorkspaceAccess ?? inheritedWorkspaceAccess ?? "none",
    sandboxMode,
    sandboxModeSource,
    sandboxEnabled: sandboxModeCoversAgentMain,
    explicit: explicitWorkspaceAccess !== undefined,
  });

  const denySources = agentWorkspaceToolDenySources(params, sandboxModeCoversAgentMain);
  for (const tool of AGENT_WORKSPACE_POLICY_TOOLS) {
    const match = denySources.find((entry) => toolListCoversTool(entry.entries, tool));
    entries.push({
      id: `${params.id}-tool-${tool}`,
      kind: "toolDeny",
      source: match?.source ?? `${params.toolsSourceBase}/deny`,
      scope: params.scope,
      ...(params.agentId === undefined ? {} : { agentId: params.agentId }),
      tool,
      denied: match !== undefined,
      explicit: match !== undefined,
    });
  }
}

function agentWorkspaceToolDenySources(
  params: {
    readonly tools: Record<string, unknown>;
    readonly inheritedTools: Record<string, unknown>;
    readonly toolsSourceBase: string;
  },
  sandboxModeCoversAgentMain: boolean,
) {
  const localSandboxToolDeny = configuredSandboxToolDenyEntries(params.tools);
  const inheritedSandboxToolDeny = configuredSandboxToolDenyEntries(params.inheritedTools);
  return [
    {
      entries: readStringArray(params.tools.deny),
      source: `${params.toolsSourceBase}/deny`,
    },
    {
      entries: readStringArray(params.inheritedTools.deny),
      source: "oc://openclaw.config/tools/deny",
    },
    ...(sandboxModeCoversAgentMain
      ? [
          localSandboxToolDeny !== undefined
            ? {
                entries: localSandboxToolDeny,
                source: `${params.toolsSourceBase}/sandbox/tools/deny`,
              }
            : {
                entries: inheritedSandboxToolDeny ?? [],
                source: "oc://openclaw.config/tools/sandbox/tools/deny",
              },
        ]
      : []),
  ];
}

function configuredSandboxToolDenyEntries(
  tools: Record<string, unknown>,
): readonly string[] | undefined {
  const sandbox = asNonArrayRecord(tools.sandbox);
  const sandboxTools = asNonArrayRecord(sandbox.tools);
  return Array.isArray(sandboxTools.deny) ? readStringArray(sandboxTools.deny) : undefined;
}
