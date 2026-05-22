import type { ModelProviderConfig, OpenClawConfig } from "../config/types.js";
type FacadeModule = {
    applyXiaomiConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    applyXiaomiProviderConfig: (cfg: OpenClawConfig) => OpenClawConfig;
    buildXiaomiProvider: () => ModelProviderConfig;
    XIAOMI_DEFAULT_MODEL_ID: string;
    XIAOMI_DEFAULT_MODEL_REF: string;
};
export declare const applyXiaomiConfig: FacadeModule["applyXiaomiConfig"];
export declare const applyXiaomiProviderConfig: FacadeModule["applyXiaomiProviderConfig"];
export declare const buildXiaomiProvider: FacadeModule["buildXiaomiProvider"];
export declare const XIAOMI_DEFAULT_MODEL_ID: FacadeModule["XIAOMI_DEFAULT_MODEL_ID"];
export declare const XIAOMI_DEFAULT_MODEL_REF: FacadeModule["XIAOMI_DEFAULT_MODEL_REF"];
export {};
