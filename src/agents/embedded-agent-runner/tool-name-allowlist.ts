/**
 * Builds session tool allowlists from registered and core tool names.
 */
import type { AgentTool } from "../runtime/index.js";
import type { ClientToolDefinition } from "./run/params.js";

/**
 * OpenClaw built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export const AGENT_RESERVED_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

function addName(names: Set<string>, value: unknown): void {
  if (typeof value !== "string") {
    return;
  }
  const trimmed = value.trim();
  if (trimmed) {
    names.add(trimmed);
  }
}

export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addName(names, readToolName(tool));
  }
  for (const tool of params.clientTools ?? []) {
    addName(names, readClientToolName(tool));
  }
  return names;
}

/**
 * Collect the exact tool names registered with the embedded agent for this session.
 */
export function collectRegisteredToolNames(tools: Array<{ name?: string }>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    addName(names, readToolName(tool));
  }
  return names;
}

export function collectCoreBuiltinToolNames(
  tools: Array<{ name?: string }>,
  options?: { isPluginTool?: (tool: { name?: string }) => boolean },
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (isPluginToolForAllowlist(tool, options?.isPluginTool)) {
      continue;
    }
    addName(names, readToolName(tool));
  }
  return names;
}

export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}

function readToolName(tool: { name?: string }): string | undefined {
  try {
    return tool.name;
  } catch {
    return undefined;
  }
}

function readClientToolName(tool: ClientToolDefinition): string | undefined {
  try {
    return tool.function?.name;
  } catch {
    return undefined;
  }
}

function isPluginToolForAllowlist(
  tool: { name?: string },
  isPluginTool: ((tool: { name?: string }) => boolean) | undefined,
): boolean {
  if (!isPluginTool) {
    return false;
  }
  try {
    return isPluginTool(tool);
  } catch {
    return true;
  }
}
