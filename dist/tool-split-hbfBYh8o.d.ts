import { Di as HookContext } from "./types-Vx7Jq4_-2.js";
import { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { AgentTool } from "@earendil-works/pi-agent-core";

//#region src/agents/pi-tool-definition-adapter.d.ts
type AnyAgentTool$1 = AgentTool;
declare function toToolDefinitions(tools: AnyAgentTool$1[], hookContext?: HookContext): ToolDefinition[];
//#endregion
//#region src/agents/pi-embedded-runner/tool-split.d.ts
type AnyAgentTool = AgentTool;
declare function splitSdkTools(options: {
  tools: AnyAgentTool[];
  sandboxEnabled: boolean;
  toolHookContext?: HookContext;
}): {
  customTools: ReturnType<typeof toToolDefinitions>;
};
//#endregion
export { splitSdkTools as t };