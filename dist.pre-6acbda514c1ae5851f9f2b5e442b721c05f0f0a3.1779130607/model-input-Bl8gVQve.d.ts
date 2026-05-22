import { g as AgentToolModelConfig, p as AgentModelConfig } from "./types.models-DPSsoV9Y.js";

//#region src/config/model-input.d.ts
type AgentModelInput = AgentModelConfig | AgentToolModelConfig;
declare function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined;
declare function resolveAgentModelFallbackValues(model?: AgentModelInput): string[];
//#endregion
export { resolveAgentModelPrimaryValue as n, resolveAgentModelFallbackValues as t };