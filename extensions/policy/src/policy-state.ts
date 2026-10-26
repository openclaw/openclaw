import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import {
  isRecord,
  asNonArrayRecord,
  normalizeOptionalString as readString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import { scanPolicyRouting, type PolicyRoutingRules } from "./policy-routing.js";
import {
  scanPolicyAuthProfiles,
  scanPolicyDataHandling,
  scanPolicySecrets,
} from "./policy-state-data.js";
import { scanPolicyExecApprovals } from "./policy-state-exec-approvals.js";
import { scanPolicyGatewayExposure } from "./policy-state-gateway.js";
import {
  collectPolicyAgentContexts,
  collectPolicyConfiguredAgents,
  ocPathSegment,
  readBooleanPath,
} from "./policy-state-helpers.js";
import { scanPolicyIngress } from "./policy-state-ingress.js";
import { scanPolicySandboxPosture } from "./policy-state-sandbox.js";
import {
  AGENT_WORKSPACE_POLICY_TOOLS,
  readStringArray,
  scanPolicyToolPosture,
} from "./policy-state-tool-posture.js";
import { scanPolicyTools } from "./policy-state-tools.js";
import {
  RESERVED_CHANNEL_CONFIG_KEYS,
  type PolicyAgentWorkspaceEvidence,
  type PolicyEvidence,
  type PolicyChannelEvidence,
  type PolicyEvidenceBuilder,
  type PolicyMcpServerEvidence,
  type PolicyModelProviderEvidence,
  type PolicyModelRefEvidence,
  type PolicyNetworkEvidence,
} from "./policy-state-types.js";
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
  const channels: readonly PolicyChannelEvidence[] = Object.entries(asNonArrayRecord(cfg.channels))
    .filter(([id]) => !RESERVED_CHANNEL_CONFIG_KEYS.has(id))
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: PolicyEvidenceBuilder<PolicyChannelEvidence> = {
        id,
        provider: id,
        source: `oc://openclaw.config/channels/${id}`,
      };
      if (isRecord(value) && typeof value.enabled === "boolean") {
        entry.enabled = value.enabled;
      }
      return entry;
    });
  const mcpServers: readonly PolicyMcpServerEvidence[] = Object.entries(
    asNonArrayRecord(asNonArrayRecord(cfg.mcp).servers),
  )
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, value]) => {
      const entry: PolicyEvidenceBuilder<PolicyMcpServerEvidence> = {
        id,
        transport: mcpServerTransport(value),
        source: `oc://openclaw.config/mcp/servers/${ocPathSegment(id)}`,
      };
      if (isRecord(value)) {
        if (typeof value.command === "string") {
          entry.command = value.command;
        }
        if (typeof value.url === "string") {
          entry.url = redactMcpUrlForEvidence(value.url);
        }
      }
      return entry;
    });
  const modelProviders: readonly PolicyModelProviderEvidence[] = Object.keys(
    asNonArrayRecord(asNonArrayRecord(cfg.models).providers),
  )
    .toSorted((a, b) => a.localeCompare(b))
    .map((id) => ({
      id: normalizeProviderId(id),
      source: `oc://openclaw.config/models/providers/${id}`,
    }));
  const refs: PolicyModelRefEvidence[] = [];
  if (isRecord(cfg.agents)) {
    collectModelRefsFromRecord(refs, cfg.agents, "oc://openclaw.config/agents");
    collectModelRefsFromAgentAllowlist(refs, cfg.agents);
  }
  const modelRefs: readonly PolicyModelRefEvidence[] = refs.toSorted(
    (a, b) => a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
  const network: readonly PolicyNetworkEvidence[] = (
    [
      ["browser-private-network", "browser/ssrfPolicy/dangerouslyAllowPrivateNetwork"],
      ["browser-private-network-legacy", "browser/ssrfPolicy/allowPrivateNetwork"],
      ["web-fetch-private-network", "tools/web/fetch/ssrfPolicy/dangerouslyAllowPrivateNetwork"],
      ["web-fetch-private-network-legacy", "tools/web/fetch/ssrfPolicy/allowPrivateNetwork"],
      [
        "web-fetch-rfc2544-benchmark-range",
        "tools/web/fetch/ssrfPolicy/allowRfc2544BenchmarkRange",
      ],
      ["web-fetch-ipv6-unique-local-range", "tools/web/fetch/ssrfPolicy/allowIpv6UniqueLocalRange"],
    ] as const
  ).flatMap(([id, path]) => {
    const value = readBooleanPath(cfg, path.split("/"));
    return value === undefined ? [] : [{ id, source: `oc://openclaw.config/${path}`, value }];
  });
  return {
    channels,
    mcpServers,
    modelProviders,
    modelRefs,
    network,
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

function mcpServerTransport(value: unknown): PolicyMcpServerEvidence["transport"] {
  if (!isRecord(value)) {
    return "unknown";
  }
  if (typeof value.command === "string") {
    return "stdio";
  }
  if (value.transport === "sse" || value.transport === "streamable-http") {
    return value.transport;
  }
  if (typeof value.url === "string") {
    return "streamable-http";
  }
  return "unknown";
}

function redactMcpUrlForEvidence(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "[redacted-url]";
  }
}

function collectModelRefsFromValue(
  refs: PolicyModelRefEvidence[],
  value: unknown,
  source: string,
): void {
  if (typeof value === "string") {
    pushModelRef(refs, value, source);
    return;
  }
  if (!isRecord(value)) {
    return;
  }
  if (typeof value.primary === "string") {
    pushModelRef(refs, value.primary, `${source}/primary`);
  }
  if (Array.isArray(value.fallbacks)) {
    for (const [index, fallback] of value.fallbacks.entries()) {
      if (typeof fallback === "string") {
        pushModelRef(refs, fallback, `${source}/fallbacks/#${index}`);
      }
    }
  }
}

function collectModelRefsFromRecord(
  refs: PolicyModelRefEvidence[],
  value: Record<string, unknown>,
  source: string,
): void {
  for (const [key, child] of Object.entries(value)) {
    const childPath = `${source}/${key}`;
    if (isModelSettingKey(key)) {
      collectModelRefsFromValue(refs, child, childPath);
      continue;
    }
    if (Array.isArray(child)) {
      for (const [index, item] of child.entries()) {
        if (isRecord(item)) {
          collectModelRefsFromRecord(refs, item, `${childPath}/#${index}`);
        }
      }
      continue;
    }
    if (isRecord(child)) {
      collectModelRefsFromRecord(refs, child, childPath);
    }
  }
}

function collectModelRefsFromAgentAllowlist(
  refs: PolicyModelRefEvidence[],
  agents: Record<string, unknown>,
): void {
  const defaults = agents.defaults;
  if (isRecord(defaults) && isRecord(defaults.models)) {
    collectModelRefsFromModelMap(
      refs,
      defaults.models,
      "oc://openclaw.config/agents/defaults/models",
    );
  }

  for (const configured of collectPolicyConfiguredAgents(agents)) {
    const agent = configured.value;
    if (!isRecord(agent.models)) {
      continue;
    }
    collectModelRefsFromModelMap(refs, agent.models, `${configured.sourceBase}/models`);
  }
}

function collectModelRefsFromModelMap(
  refs: PolicyModelRefEvidence[],
  models: Record<string, unknown>,
  source: string,
): void {
  for (const ref of Object.keys(models)) {
    pushModelRef(refs, ref, `${source}/${ocPathSegment(ref)}`);
  }
}

function isModelSettingKey(key: string): boolean {
  return key === "model" || key.endsWith("Model");
}

function pushModelRef(refs: PolicyModelRefEvidence[], ref: string, source: string): void {
  const trimmed = ref.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash >= trimmed.length - 1) {
    return;
  }
  refs.push({
    ref,
    provider: normalizeProviderId(trimmed.slice(0, slash)),
    model: trimmed.slice(slash + 1),
    source,
  });
}
