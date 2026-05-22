import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
type FacadeModule = {
    applyOpenrouterConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    applyOpenrouterProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    buildOpenrouterProvider: () => ModelProviderConfig;
    OPENROUTER_DEFAULT_MODEL_REF: string;
};
export declare const applyOpenrouterConfig: FacadeModule["applyOpenrouterConfig"];
export declare const applyOpenrouterProviderConfig: FacadeModule["applyOpenrouterProviderConfig"];
export declare const buildOpenrouterProvider: FacadeModule["buildOpenrouterProvider"];
export declare const OPENROUTER_DEFAULT_MODEL_REF: FacadeModule["OPENROUTER_DEFAULT_MODEL_REF"];
export {};
