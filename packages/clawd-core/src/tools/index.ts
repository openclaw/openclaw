import type { AgentTool } from "@mariozechner/pi-agent-core";
import { codingTools } from "@mariozechner/pi-coding-agent";
import type { ClawdConfig } from "../config/types.js";
import {
  type BashToolDefaults,
  createBashTool,
  createProcessTool,
  type ProcessToolDefaults,
} from "./bash-tools.js";

type AnyAgentTool = AgentTool<any, unknown>;

function normalizeToolNames(list?: string[]) {
  if (!list) return [];
  return list.map((entry) => entry.trim().toLowerCase()).filter(Boolean);
}

type ToolPolicy = {
  allow?: string[];
  deny?: string[];
};

function filterToolsByPolicy(tools: AnyAgentTool[], policy?: ToolPolicy) {
  if (!policy) return tools;
  const deny = new Set(normalizeToolNames(policy.deny));
  const allowRaw = normalizeToolNames(policy.allow);
  const allow = allowRaw.length > 0 ? new Set(allowRaw) : null;
  return tools.filter((tool) => {
    const name = tool.name.toLowerCase();
    if (deny.has(name)) return false;
    if (allow) return allow.has(name);
    return true;
  });
}

export type ClawdToolsOptions = {
  bash?: BashToolDefaults & ProcessToolDefaults;
  config?: ClawdConfig;
};

/**
 * Create the core Clawd tools (file operations, bash, process management).
 * This is a simplified version without messaging providers.
 */
export function createClawdCodingTools(
  options?: ClawdToolsOptions,
): AnyAgentTool[] {
  const bashToolName = "bash";

  // Get base coding tools from pi-coding-agent (read, write, edit, grep, find, ls)
  const base = (codingTools as unknown as AnyAgentTool[]).filter((tool) => {
    // Remove the default bash tool - we'll add our own
    if (tool.name === bashToolName) return false;
    return true;
  });

  // Create bash and process tools
  const bashTool = createBashTool(options?.bash);
  const processTool = createProcessTool({
    cleanupMs: options?.bash?.cleanupMs,
  });

  const tools: AnyAgentTool[] = [
    ...base,
    bashTool as unknown as AnyAgentTool,
    processTool as unknown as AnyAgentTool,
  ];

  // Apply tool policy from config
  const filtered =
    options?.config?.agent?.tools &&
    (options.config.agent.tools.allow?.length ||
      options.config.agent.tools.deny?.length)
      ? filterToolsByPolicy(tools, options.config.agent.tools)
      : tools;

  return filtered;
}

export * from "./bash-tools.js";
export * from "./process-registry.js";
export * from "./shell-utils.js";
