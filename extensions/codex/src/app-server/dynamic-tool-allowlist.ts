import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import {
  CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
  CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
  CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
} from "./shell-dynamic-tools.js";

/** Detects the wildcard marker after canonical Codex tool-name normalization. */
export function hasWildcardCodexToolsAllow(toolsAllow: readonly string[]): boolean {
  return toolsAllow.some((name) => normalizeCodexDynamicToolName(name) === "*");
}

/** Applies a normalized allowlist while retaining only explicitly carried tool instances. */
export function filterCodexDynamicToolsForAllowlist<T extends { name: string }>(
  tools: T[],
  toolsAllow?: string[],
  preserveTools?: ReadonlySet<T>,
): T[] {
  if (!toolsAllow) {
    return tools;
  }
  if (toolsAllow.length === 0) {
    return [];
  }
  if (hasWildcardCodexToolsAllow(toolsAllow)) {
    return tools;
  }
  const allowSet = new Set(
    toolsAllow.map((name) => normalizeCodexDynamicToolName(name)).filter(Boolean),
  );
  return tools.filter((tool) => {
    if (preserveTools?.has(tool)) {
      return true;
    }
    const normalized = normalizeCodexDynamicToolName(tool.name);
    return (
      allowSet.has(normalized) ||
      (normalized === "sandbox_exec" && allowSet.has("exec")) ||
      (normalized === "sandbox_process" && (allowSet.has("exec") || allowSet.has("process"))) ||
      (normalized === CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME && allowSet.has("exec")) ||
      (normalized === CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME &&
        (allowSet.has("exec") || allowSet.has("process"))) ||
      (normalized === CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME && allowSet.has("exec"))
    );
  });
}
