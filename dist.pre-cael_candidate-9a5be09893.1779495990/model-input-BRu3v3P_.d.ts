import { g as AgentModelConfig, y as AgentToolModelConfig } from "./types.models-ChAkWQv6.js";

//#region src/config/model-input.d.ts
type AgentModelInput = AgentModelConfig | AgentToolModelConfig;
declare function resolveAgentModelPrimaryValue(model?: AgentModelInput): string | undefined;
declare function resolveAgentModelFallbackValues(model?: AgentModelInput): string[];
//#endregion
export { resolveAgentModelPrimaryValue as n, resolveAgentModelFallbackValues as t };