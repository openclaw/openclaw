import type { ModelDefinitionConfig, OpenClawConfig } from "../config/types.js";
type FacadeModule = {
    applyLitellmConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    applyLitellmProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    buildLitellmModelDefinition: () => ModelDefinitionConfig;
    LITELLM_BASE_URL: string;
    LITELLM_DEFAULT_MODEL_ID: string;
    LITELLM_DEFAULT_MODEL_REF: string;
};
export declare const applyLitellmConfig: FacadeModule["applyLitellmConfig"];
export declare const applyLitellmProviderConfig: FacadeModule["applyLitellmProviderConfig"];
export declare const buildLitellmModelDefinition: FacadeModule["buildLitellmModelDefinition"];
export declare const LITELLM_BASE_URL: FacadeModule["LITELLM_BASE_URL"];
export declare const LITELLM_DEFAULT_MODEL_ID: FacadeModule["LITELLM_DEFAULT_MODEL_ID"];
export declare const LITELLM_DEFAULT_MODEL_REF: FacadeModule["LITELLM_DEFAULT_MODEL_REF"];
export {};
