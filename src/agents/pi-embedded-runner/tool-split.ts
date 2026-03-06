import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  // Snapshot and freeze both output arrays to prevent concurrent code paths
  // from mutating the tool registry during async tool execution (#27205).
  const { tools } = options;
  const customTools = toToolDefinitions(tools);
  return {
    builtInTools: Object.freeze([] as AnyAgentTool[]) as unknown as AnyAgentTool[],
    customTools: Object.freeze(customTools) as unknown as ReturnType<typeof toToolDefinitions>,
  };
}
