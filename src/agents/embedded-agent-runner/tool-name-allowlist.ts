/**
 * Builds session tool allowlists from registered and core tool names.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AgentTool } from "../runtime/index.js";
import type { ClientToolDefinition } from "./run/params.js";

/**
 * OpenClaw built-in tools that remain present in the embedded runtime even when
 * OpenClaw routes execution through custom tool definitions.
 */
export const AGENT_RESERVED_TOOL_NAMES = ["bash", "edit", "find", "grep", "ls", "read", "write"];

function addName(names: Set<string>, value: unknown): void {
  const trimmed = normalizeOptionalString(value);
  if (trimmed) {
    names.add(trimmed);
  }
}

export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = collectRegisteredToolNames(params.tools);
  for (const tool of params.clientTools ?? []) {
    addName(names, tool.function?.name);
  }
  return names;
}

export function collectRegisteredToolNames(tools: Array<{ name?: string }>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    addName(names, tool.name);
  }
  return names;
}

export function collectCoreBuiltinToolNames(
  tools: Array<{ name?: string }>,
  options?: { isPluginTool?: (tool: { name?: string }) => boolean },
): Set<string> {
  return collectRegisteredToolNames(tools.filter((tool) => !options?.isPluginTool?.(tool)));
}

export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
