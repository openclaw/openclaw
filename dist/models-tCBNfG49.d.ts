import { f as ModelProviderDeclarationConfig, s as ModelDefinitionConfig } from "./types.models-tqxsISRc.js";
//#region extensions/qwen/models.d.ts
declare const QWEN_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
declare const QWEN_GLOBAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
declare const QWEN_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
declare const QWEN_STANDARD_CN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
declare const QWEN_STANDARD_GLOBAL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
declare const QWEN_DEFAULT_MODEL_ID = "qwen3.5-plus";
declare const QWEN_36_PLUS_MODEL_ID = "qwen3.6-plus";
declare const QWEN_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
declare const QWEN_DEFAULT_MODEL_REF = "qwen/qwen3.5-plus";
declare const QWEN_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig>;
declare function isQwenCodingPlanBaseUrl(baseUrl: string | undefined): boolean;
declare function isQwen36PlusSupportedBaseUrl(baseUrl: string | undefined): boolean;
declare function buildQwenModelCatalogForBaseUrl(baseUrl: string | undefined): ReadonlyArray<ModelDefinitionConfig>;
declare function isNativeQwenBaseUrl(baseUrl: string | undefined): boolean;
declare function applyQwenNativeStreamingUsageCompat(provider: ModelProviderDeclarationConfig): ModelProviderDeclarationConfig;
declare function buildQwenModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig;
declare function buildQwenDefaultModelDefinition(): ModelDefinitionConfig;
/** @deprecated Use QWEN_BASE_URL. */
declare const MODELSTUDIO_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
/** @deprecated Use QWEN_GLOBAL_BASE_URL. */
declare const MODELSTUDIO_GLOBAL_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
/** @deprecated Use QWEN_CN_BASE_URL. */
declare const MODELSTUDIO_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
/** @deprecated Use QWEN_STANDARD_CN_BASE_URL. */
declare const MODELSTUDIO_STANDARD_CN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
/** @deprecated Use QWEN_STANDARD_GLOBAL_BASE_URL. */
declare const MODELSTUDIO_STANDARD_GLOBAL_BASE_URL = "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";
/** @deprecated Use QWEN_DEFAULT_MODEL_ID. */
declare const MODELSTUDIO_DEFAULT_MODEL_ID = "qwen3.5-plus";
/** @deprecated Use QWEN_DEFAULT_COST. */
declare const MODELSTUDIO_DEFAULT_COST: {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};
/** @deprecated Use qwen/${QWEN_DEFAULT_MODEL_ID}. */
declare const MODELSTUDIO_DEFAULT_MODEL_REF = "modelstudio/qwen3.5-plus";
/** @deprecated Use QWEN_MODEL_CATALOG. */
declare const MODELSTUDIO_MODEL_CATALOG: readonly ModelDefinitionConfig[];
declare const isNativeModelStudioBaseUrl: typeof isNativeQwenBaseUrl;
declare const applyModelStudioNativeStreamingUsageCompat: typeof applyQwenNativeStreamingUsageCompat;
declare const buildModelStudioModelDefinition: typeof buildQwenModelDefinition;
declare const buildModelStudioDefaultModelDefinition: typeof buildQwenDefaultModelDefinition;
//#endregion
export { isQwenCodingPlanBaseUrl as A, buildModelStudioModelDefinition as C, isNativeModelStudioBaseUrl as D, buildQwenModelDefinition as E, isNativeQwenBaseUrl as O, buildModelStudioDefaultModelDefinition as S, buildQwenModelCatalogForBaseUrl as T, QWEN_MODEL_CATALOG as _, MODELSTUDIO_DEFAULT_MODEL_REF as a, applyModelStudioNativeStreamingUsageCompat as b, MODELSTUDIO_STANDARD_CN_BASE_URL as c, QWEN_BASE_URL as d, QWEN_CN_BASE_URL as f, QWEN_GLOBAL_BASE_URL as g, QWEN_DEFAULT_MODEL_REF as h, MODELSTUDIO_DEFAULT_MODEL_ID as i, isQwen36PlusSupportedBaseUrl as k, MODELSTUDIO_STANDARD_GLOBAL_BASE_URL as l, QWEN_DEFAULT_MODEL_ID as m, MODELSTUDIO_CN_BASE_URL as n, MODELSTUDIO_GLOBAL_BASE_URL as o, QWEN_DEFAULT_COST as p, MODELSTUDIO_DEFAULT_COST as r, MODELSTUDIO_MODEL_CATALOG as s, MODELSTUDIO_BASE_URL as t, QWEN_36_PLUS_MODEL_ID as u, QWEN_STANDARD_CN_BASE_URL as v, buildQwenDefaultModelDefinition as w, applyQwenNativeStreamingUsageCompat as x, QWEN_STANDARD_GLOBAL_BASE_URL as y };