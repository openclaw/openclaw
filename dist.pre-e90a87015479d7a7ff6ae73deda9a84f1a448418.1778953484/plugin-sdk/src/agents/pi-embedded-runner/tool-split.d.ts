import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
type AnyAgentTool = AgentTool;
export declare function splitSdkTools(options: {
    tools: AnyAgentTool[];
    sandboxEnabled: boolean;
}): {
    customTools: ReturnType<typeof toToolDefinitions>;
};
export {};
