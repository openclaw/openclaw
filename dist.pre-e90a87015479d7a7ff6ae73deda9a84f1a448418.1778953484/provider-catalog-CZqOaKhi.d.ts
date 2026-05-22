import { l as ModelProviderConfig } from "./types.models-DfLOOuHc.js";
//#region extensions/anthropic-vertex/provider-catalog.d.ts
declare const ANTHROPIC_VERTEX_DEFAULT_MODEL_ID = "claude-sonnet-4-6";
declare function buildAnthropicVertexProvider(params?: {
  env?: NodeJS.ProcessEnv;
}): ModelProviderConfig;
//#endregion
export { buildAnthropicVertexProvider as n, ANTHROPIC_VERTEX_DEFAULT_MODEL_ID as t };