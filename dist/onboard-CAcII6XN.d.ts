import { i as OpenClawConfig } from "./types.openclaw-BLF4DJTX.js";
import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/litellm/onboard.d.ts
declare const LITELLM_BASE_URL = "http://localhost:4000";
declare const LITELLM_DEFAULT_MODEL_ID = "claude-opus-4-6";
declare const LITELLM_DEFAULT_MODEL_REF = "litellm/claude-opus-4-6";
declare function buildLitellmModelDefinition(): ModelDefinitionConfig;
declare function applyLitellmProviderConfig(cfg: OpenClawConfig): OpenClawConfig;
declare function applyLitellmConfig(cfg: OpenClawConfig): OpenClawConfig;
//#endregion
export { applyLitellmProviderConfig as a, applyLitellmConfig as i, LITELLM_DEFAULT_MODEL_ID as n, buildLitellmModelDefinition as o, LITELLM_DEFAULT_MODEL_REF as r, LITELLM_BASE_URL as t };