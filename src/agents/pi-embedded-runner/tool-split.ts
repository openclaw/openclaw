import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

// Pi treats `tools` as the active tool allowlist, not as a built-in-only list.
// Register the OpenClaw implementations through `customTools`, then allow those
// same names so Pi does not filter them all out before the provider request.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: { tools: AnyAgentTool[]; sandboxEnabled: boolean }): {
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools } = options;
  return {
    customTools: toToolDefinitions(tools),
  };
}
