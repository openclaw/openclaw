import type { ClawdbotConfig } from "../config/config.js";
import { resolveAgentConfig, resolveAgentIdFromSessionKey } from "./agent-scope.js";
import type { AnyAgentTool } from "./pi-tools.types.js";
import type { SandboxToolPolicy } from "./sandbox.js";
import { expandToolGroups, normalizeToolName } from "./tool-policy.js";

const DEFAULT_SUBAGENT_TOOL_DENY = [
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
];

export function resolveSubagentToolPolicy(cfg?: ClawdbotConfig): SandboxToolPolicy {
  const configured = cfg?.tools?.subagents?.tools;
  const deny = [
    ...DEFAULT_SUBAGENT_TOOL_DENY,
    ...(Array.isArray(configured?.deny) ? configured.deny : []),
  ];
  const allow = Array.isArray(configured?.allow) ? configured.allow : undefined;
  return { allow, deny };
}

export function isToolAllowedByPolicyName(name: string, policy?: SandboxToolPolicy): boolean {
  if (!policy) return true;
  const deny = new Set(expandToolGroups(policy.deny));
  const allowRaw = expandToolGroups(policy.allow);
  const allow = allowRaw.length > 0 ? new Set(allowRaw) : null;
  const normalized = normalizeToolName(name);
  if (deny.has(normalized)) return false;
  if (allow) {
    if (allow.has(normalized)) return true;
    if (normalized === "apply_patch" && allow.has("exec")) return true;
    return false;
  }
  return true;
}

export function filterToolsByPolicy(tools: AnyAgentTool[], policy?: SandboxToolPolicy) {
  if (!policy) return tools;
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy));
}

export function resolveEffectiveToolPolicy(params: {
  config?: ClawdbotConfig;
  sessionKey?: string;
}) {
  const agentId = params.sessionKey ? resolveAgentIdFromSessionKey(params.sessionKey) : undefined;
  const agentConfig =
    params.config && agentId ? resolveAgentConfig(params.config, agentId) : undefined;
  const agentTools = agentConfig?.tools;
  const hasAgentToolPolicy =
    Array.isArray(agentTools?.allow) ||
    Array.isArray(agentTools?.deny) ||
    typeof agentTools?.profile === "string";
  const globalTools = params.config?.tools;
  const profile = agentTools?.profile ?? globalTools?.profile;
  return {
    agentId,
    policy: hasAgentToolPolicy ? agentTools : globalTools,
    profile,
  };
}

export function isToolAllowedByPolicies(
  name: string,
  policies: Array<SandboxToolPolicy | undefined>,
) {
  return policies.every((policy) => isToolAllowedByPolicyName(name, policy));
}
