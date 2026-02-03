import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { OpenClawConfig } from "../../config/config.js";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";

// We always pass tools via `customTools` so our policy filtering, sandbox integration,
// and extended toolset remain consistent across providers.
type AnyAgentTool = AgentTool;

export function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  config?: OpenClawConfig;
}): {
  builtInTools: AnyAgentTool[];
  customTools: ReturnType<typeof toToolDefinitions>;
} {
  const { tools, config } = options;
  return {
    builtInTools: [],
    customTools: toToolDefinitions(tools, config),
  };
}
