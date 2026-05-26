import { s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/xai/model-definitions.d.ts
declare const XAI_BASE_URL = "https://api.x.ai/v1";
declare const XAI_DEFAULT_IMAGE_MODEL = "grok-imagine-image";
declare const XAI_IMAGE_MODELS: readonly ["grok-imagine-image", "grok-imagine-image-quality"];
declare const XAI_DEFAULT_CONTEXT_WINDOW = 1000000;
declare const XAI_DEFAULT_MAX_TOKENS = 64000;
declare const XAI_DEFAULT_MODEL_ID = "grok-4.3";
declare const XAI_DEFAULT_MODEL_REF = "xai/grok-4.3";
declare function isRetiredXaiBuiltinModelId(modelId: string): boolean;
declare function buildXaiModelDefinition(): ModelDefinitionConfig;
declare function buildXaiCatalogModels(): ModelDefinitionConfig[];
declare function resolveXaiCatalogEntry(modelId: string): ModelDefinitionConfig | undefined;
//#endregion
export { XAI_DEFAULT_MODEL_ID as a, buildXaiCatalogModels as c, resolveXaiCatalogEntry as d, XAI_DEFAULT_MAX_TOKENS as i, buildXaiModelDefinition as l, XAI_DEFAULT_CONTEXT_WINDOW as n, XAI_DEFAULT_MODEL_REF as o, XAI_DEFAULT_IMAGE_MODEL as r, XAI_IMAGE_MODELS as s, XAI_BASE_URL as t, isRetiredXaiBuiltinModelId as u };