import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { hasAuthorizationPolicies } from "../../plugins/authorization-policy.js";
import { normalizeToolName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
export const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";

type CliAuthorizationToolAvailability = {
  native: [];
  mcp: string[];
};

function intersectPolicyManagedMcpTools(
  requested: CliAuthorizationToolAvailability | undefined,
): string[] {
  if (!requested) {
    return [`${OPENCLAW_MCP_TOOL_PREFIX}*`];
  }
  if (!Array.isArray(requested.mcp)) {
    return [];
  }
  const names = new Set<string>();
  for (const entry of requested.mcp) {
    if (typeof entry !== "string") {
      continue;
    }
    const trimmed = entry.trim();
    if (trimmed === `${OPENCLAW_MCP_TOOL_PREFIX}*`) {
      return [trimmed];
    }
    const name = trimmed.slice(OPENCLAW_MCP_TOOL_PREFIX.length);
    if (trimmed.startsWith(OPENCLAW_MCP_TOOL_PREFIX) && name && !name.includes("*")) {
      names.add(trimmed);
    }
  }
  return [...names];
}

/** Resolves exact CLI availability, intersecting policy-active runs with the loopback surface. */
export function resolveCliAuthorizationToolAvailability(
  config: OpenClawConfig,
  requested?: CliAuthorizationToolAvailability,
): CliAuthorizationToolAvailability | undefined {
  try {
    if (!hasAuthorizationPolicies(undefined, config, "tool.call")) {
      return requested;
    }
  } catch {
    // Policy discovery is itself part of the boundary. Unknown means restricted.
  }
  return {
    native: [],
    mcp: intersectPolicyManagedMcpTools(requested),
  };
}

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName;
}

/**
 * Derives the loopback MCP grant allowlist from a selectable-backend MCP
 * permission list. Wildcards keep the full session-scoped surface; entries for
 * other MCP servers are not loopback-governed and drop out. A non-wildcard
 * list that leaves no loopback names fails closed (empty allowlist).
 */
export function resolveLoopbackToolsAllowFromMcpPermissions(
  mcp: readonly string[] | undefined,
): string[] | undefined {
  if (!mcp) {
    return undefined;
  }
  if (mcp.some((entry) => entry.trim() === "*")) {
    throw new Error("bare MCP wildcard cannot be isolated to the OpenClaw loopback server");
  }
  const names = new Set<string>();
  for (const entry of mcp) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed === `${OPENCLAW_MCP_TOOL_PREFIX}*`) {
      return undefined;
    }
    if (trimmed.startsWith("mcp__") && !trimmed.startsWith(OPENCLAW_MCP_TOOL_PREFIX)) {
      continue;
    }
    const name = normalizeToolName(stripOpenClawMcpToolPrefix(trimmed));
    if (name) {
      names.add(name);
    }
  }
  return [...names];
}

/** CLI backends cannot enforce runtime caps; keep only real restrictions. */
export function resolveCliRuntimeToolsAllow(
  toolsAllow?: string[],
  toolsAllowIsDefault?: boolean,
): string[] | undefined {
  if (toolsAllow === undefined || toolsAllowIsDefault) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
