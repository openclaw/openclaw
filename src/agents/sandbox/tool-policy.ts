import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { ToolAllowDenyPolicyConfig } from "../../config/types.tools.js";
import { resolveAgentConfig } from "../agent-scope-config.js";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../glob-pattern.js";
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";
import { DEFAULT_TOOL_ALLOW, DEFAULT_TOOL_DENY } from "./constants.js";
import {
  SANDBOX_DEFAULT_TOOL_ALLOW,
  type SandboxToolPolicy,
  type SandboxToolPolicyResolved,
  type SandboxToolPolicySource,
} from "./types.js";

function pickConfiguredList(
  field: keyof ToolAllowDenyPolicyConfig,
  agent?: ToolAllowDenyPolicyConfig,
  global?: ToolAllowDenyPolicyConfig,
): {
  values?: string[];
  source: SandboxToolPolicySource;
} {
  const key = `tools.sandbox.tools.${field}`;
  for (const [source, values] of [
    ["agent", agent?.[field]],
    ["global", global?.[field]],
  ] as const) {
    if (Array.isArray(values)) {
      return {
        values,
        source: { source, key: source === "agent" ? `agents.entries.*.${key}` : key },
      };
    }
  }
  return {
    values: undefined,
    source: { source: "default", key },
  };
}

function mergeAllowlist(
  base: string[] | undefined,
  extra: string[] | undefined,
  defaultAllow: readonly string[],
): string[] {
  // Preserve the existing sandbox meaning of `allow: []` => allow all.
  if (base?.length === 0) {
    return [];
  }
  const resolved = base ?? defaultAllow;
  return extra?.length ? uniqueStrings([...resolved, ...extra]) : [...resolved];
}

function pickAllowSource(params: {
  allow: SandboxToolPolicySource;
  allowDefined: boolean;
  alsoAllow?: SandboxToolPolicySource;
}): SandboxToolPolicySource {
  for (const source of ["agent", "global"] as const) {
    if (params.allowDefined && params.allow.source === source) {
      return params.allow;
    }
    if (params.alsoAllow?.source === source) {
      return params.alsoAllow;
    }
  }
  return params.allow;
}

function filterDefaultDenyForExplicitAllows(params: {
  deny: string[];
  explicitAllowPatterns: string[];
}): string[] {
  if (params.explicitAllowPatterns.length === 0) {
    return [...params.deny];
  }
  const allowPatterns = compileGlobPatterns({
    raw: expandToolGroups(params.explicitAllowPatterns),
    normalize: normalizeToolPolicyName,
  });
  if (allowPatterns.length === 0) {
    return [...params.deny];
  }
  return params.deny.filter(
    (toolName) => !matchesAnyGlobPattern(normalizeToolPolicyName(toolName), allowPatterns),
  );
}

function expandResolvedPolicy(policy: SandboxToolPolicy) {
  let expandedDeny = expandToolGroups(policy.deny ?? []);
  let expandedAllow = expandToolGroups(policy.allow ?? []);
  const denyPatterns = compileGlobPatterns({
    raw: expandedDeny,
    normalize: normalizeToolPolicyName,
  });
  // Shipped sandbox denies are security boundaries. Keep the old spelling
  // fail-closed until Doctor rewrites it, without restoring a runtime alias.
  if (
    matchesAnyGlobPattern("image", denyPatterns) &&
    !matchesAnyGlobPattern("view_image", denyPatterns)
  ) {
    expandedDeny = [...expandedDeny, "view_image"];
  }
  const expandedDenyLower = expandedDeny.map(normalizeLowercaseStringOrEmpty);
  const expandedAllowLower = expandedAllow.map(normalizeLowercaseStringOrEmpty);

  // `view_image` is essential for multimodal workflows; keep the existing sandbox
  // behavior that auto-includes it for explicit allowlists unless it is denied.
  if (
    expandedAllow.length > 0 &&
    !expandedDenyLower.includes("view_image") &&
    !expandedAllowLower.includes("view_image")
  ) {
    expandedAllow = [...expandedAllow, "view_image"];
  }

  return {
    allow: expandedAllow,
    deny: expandedDeny,
  };
}

export function classifyToolAgainstSandboxToolPolicy(name: string, policy?: SandboxToolPolicy) {
  if (!policy) {
    return {
      blockedByDeny: false,
      blockedByAllow: false,
    };
  }

  const normalized = normalizeToolPolicyName(name);
  const deny = compileGlobPatterns({
    raw: expandToolGroups(policy.deny ?? []),
    normalize: normalizeToolPolicyName,
  });
  const blockedByDeny = matchesAnyGlobPattern(normalized, deny);
  const allow = compileGlobPatterns({
    raw: expandToolGroups(policy.allow ?? []),
    normalize: normalizeToolPolicyName,
  });
  const blockedByAllow =
    !blockedByDeny && allow.length > 0 && !matchesAnyGlobPattern(normalized, allow);
  return {
    blockedByDeny,
    blockedByAllow,
  };
}

export function isToolAllowed(policy: SandboxToolPolicy, name: string) {
  const { blockedByDeny, blockedByAllow } = classifyToolAgainstSandboxToolPolicy(name, policy);
  return !blockedByDeny && !blockedByAllow;
}

export function resolveSandboxToolPolicyForAgent(
  cfg?: OpenClawConfig,
  agentId?: string,
  options?: { containedToolNames?: readonly string[] },
): SandboxToolPolicyResolved {
  const agentConfig = cfg && agentId ? resolveAgentConfig(cfg, agentId) : undefined;
  const agentPolicy = agentConfig?.tools?.sandbox?.tools;
  const globalPolicy = cfg?.tools?.sandbox?.tools;

  const allowConfig = pickConfiguredList("allow", agentPolicy, globalPolicy);
  const alsoAllowConfig = pickConfiguredList("alsoAllow", agentPolicy, globalPolicy);
  const denyConfig = pickConfiguredList("deny", agentPolicy, globalPolicy);

  const explicitAllowPatterns = uniqueStrings([
    ...(allowConfig.values ?? []),
    ...(alsoAllowConfig.values ?? []),
  ]);

  // Host-bound tools that operate inside this placement are sandbox capabilities.
  // Change defaults only; configured allow/deny lists retain their normal authority.
  const containedTools = new Set(options?.containedToolNames);
  const defaultAllow = uniqueStrings([...DEFAULT_TOOL_ALLOW, ...containedTools]);
  const resolvedAllow = mergeAllowlist(allowConfig.values, alsoAllowConfig.values, defaultAllow);
  const resolvedDeny =
    denyConfig.values !== undefined
      ? [...denyConfig.values]
      : filterDefaultDenyForExplicitAllows({
          deny: DEFAULT_TOOL_DENY.filter((name) => !containedTools.has(name)),
          explicitAllowPatterns,
        });

  const expanded = expandResolvedPolicy({
    allow: resolvedAllow,
    deny: resolvedDeny,
  });

  return {
    ...expanded,
    ...(allowConfig.values === undefined ? { [SANDBOX_DEFAULT_TOOL_ALLOW]: expanded.allow } : {}),
    sources: {
      allow: pickAllowSource({
        allow: allowConfig.source,
        allowDefined: allowConfig.values !== undefined,
        alsoAllow: alsoAllowConfig.source,
      }),
      deny: denyConfig.source,
    },
  };
}
