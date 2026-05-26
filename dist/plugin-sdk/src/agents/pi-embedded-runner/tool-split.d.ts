import type { AgentTool } from "@earendil-works/pi-agent-core";
import { toToolDefinitions } from "../pi-tool-definition-adapter.js";
import type { HookContext } from "../pi-tools.before-tool-call.js";
type AnyAgentTool = AgentTool;
export declare function splitSdkTools(options: {
    tools: AnyAgentTool[];
    sandboxEnabled: boolean;
    toolHookContext?: HookContext;
}): {
    customTools: ReturnType<typeof toToolDefinitions>;
};
export {};
