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

/**
 * Collects the effective tool names visible to an embedded run.
 *
 * This may include client tools when they are passed directly, but callers can
 * omit them after Tool Search compaction so visible allowlists and replay
 * allowlists can intentionally diverge.
 */
export function collectAllowedToolNames(params: {
  tools: AgentTool[];
  clientTools?: ClientToolDefinition[];
}): Set<string> {
  const names = new Set<string>();
  for (const tool of params.tools) {
    addName(names, tool.name);
  }
  for (const tool of params.clientTools ?? []) {
    addName(names, tool.function?.name);
  }
  return names;
}

/**
 * Collects the exact custom-tool names registered with the embedded agent.
 *
 * Session allowlists use this narrower source so hidden catalog tools do not
 * appear as user-selectable tools while replay guards can still admit them.
 */
export function collectRegisteredToolNames(tools: Array<{ name?: string }>): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    addName(names, tool.name);
  }
  return names;
}

/**
 * Collects core built-in tool names before Tool Search/catalog compaction.
 *
 * Client tool conflict checks use this broader namespace so a hidden core tool
 * such as `exec` still blocks a client tool from taking the same name.
 */
export function collectCoreBuiltinToolNames(
  tools: Array<{ name?: string }>,
  options?: { isPluginTool?: (tool: { name?: string }) => boolean },
): Set<string> {
  const names = new Set<string>();
  for (const tool of tools) {
    if (options?.isPluginTool?.(tool)) {
      continue;
    }
    addName(names, tool.name);
  }
  return names;
}

/**
 * Converts a collected tool-name set into the stable array shape persisted on
 * agent sessions and prompt-cache-sensitive payloads.
 */
export function toSessionToolAllowlist(allowedToolNames: Iterable<string>): string[] {
  return [...new Set(allowedToolNames)].toSorted((a, b) => a.localeCompare(b));
}
