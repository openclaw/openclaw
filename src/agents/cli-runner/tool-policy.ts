import type { CliBundleMcpMode } from "../../plugins/cli-backend.types.js";
import { normalizeToolPolicyName } from "../tool-policy.js";

/** Transport prefix CLI harnesses use for loopback OpenClaw MCP tool names. */
const OPENCLAW_MCP_TOOL_PREFIX = "mcp__openclaw__";
const GEMINI_OPENCLAW_MCP_TOOL_PREFIX = "mcp_openclaw_";

/**
 * Model-visible prefix for OpenClaw tools served over the bundle MCP bridge.
 * Claude Code names MCP tools `mcp__<server>__<tool>`, so a prompt that lists bare
 * gateway names asks the model to call tools that do not exist there.
 */
export function resolveOpenClawMcpToolNamePrefix(
  bundleMcpMode: CliBundleMcpMode | undefined,
): string | undefined {
  return bundleMcpMode === "claude-config-file" ? OPENCLAW_MCP_TOOL_PREFIX : undefined;
}

/** Strips the loopback MCP transport prefix so observers see gateway tool names. */
export function stripOpenClawMcpToolPrefix(toolName: string): string {
  return toolName.startsWith(OPENCLAW_MCP_TOOL_PREFIX)
    ? toolName.slice(OPENCLAW_MCP_TOOL_PREFIX.length)
    : toolName.startsWith(GEMINI_OPENCLAW_MCP_TOOL_PREFIX)
      ? toolName.slice(GEMINI_OPENCLAW_MCP_TOOL_PREFIX.length)
      : toolName;
}

/** Match provider-native names against the canonical tool hook and policy ids. */
export function normalizeCliToolName(toolName: string): string {
  return normalizeToolPolicyName(
    toolName.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z0-9])([A-Z])/g, "$1_$2"),
  );
}

/** Keeps only explicit runtime caps for backend-owned exact translation. */
export function resolveCliRuntimeToolsAllow(toolsAllow?: string[]): string[] | undefined {
  if (toolsAllow === undefined) {
    return undefined;
  }
  return toolsAllow.some((toolName) => normalizeToolPolicyName(toolName) === "*")
    ? undefined
    : toolsAllow;
}
