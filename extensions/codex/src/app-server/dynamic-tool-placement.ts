import { normalizeCodexDynamicToolName } from "./dynamic-tool-profile.js";
import {
  CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
  CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
  CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
} from "./shell-dynamic-tools.js";

const CODEX_DISABLED_NATIVE_SHELL_DYNAMIC_TOOLS = new Set([
  "exec",
  "process",
  "sandbox_exec",
  "sandbox_process",
  CODEX_GATEWAY_EXEC_DYNAMIC_TOOL_NAME,
  CODEX_GATEWAY_PROCESS_DYNAMIC_TOOL_NAME,
  CODEX_NODE_EXEC_DYNAMIC_TOOL_NAME,
]);

/** Keeps replacement shell tools direct even when model metadata mandates Codex Code Mode. */
export function placeDisabledNativeShellToolsInDirectNamespace<
  T extends { name: string; catalogMode?: string },
>(tools: T[], nativeToolSurfaceEnabled: boolean | undefined): T[] {
  if (nativeToolSurfaceEnabled !== false) {
    return tools;
  }
  for (const tool of tools) {
    if (CODEX_DISABLED_NATIVE_SHELL_DYNAMIC_TOOLS.has(normalizeCodexDynamicToolName(tool.name))) {
      // Runtime tools can carry non-enumerable policy metadata and prototype behavior.
      // Preserve the prepared object identity while changing only its Codex catalog placement.
      tool.catalogMode = "direct-only";
    }
  }
  return tools;
}
