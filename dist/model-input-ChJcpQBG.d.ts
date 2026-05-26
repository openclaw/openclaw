import { p as AgentModelConfig } from "./types.models-CkWCv1xp.js";

//#region src/config/model-input.d.ts
declare function resolveAgentModelPrimaryValue(model?: AgentModelConfig): string | undefined;
declare function resolveAgentModelFallbackValues(model?: AgentModelConfig): string[];
//#endregion
export { resolveAgentModelPrimaryValue as n, resolveAgentModelFallbackValues as t };