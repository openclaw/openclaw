import type { AgentTool } from "@mariozechner/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
type AnyAgentTool = AgentTool;
export declare function splitSdkTools(options: {
    tools: AnyAgentTool[];
    sandboxEnabled: boolean;
}): {
    builtInTools: AnyAgentTool[];
    customTools: ReturnType<typeof toToolDefinitions>;
};
export {};
