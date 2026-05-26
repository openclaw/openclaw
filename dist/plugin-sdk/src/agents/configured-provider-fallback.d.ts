import type { OpenClawConfig } from "../config/types.js";
type ProviderModelRef = {
    provider: string;
    model: string;
};
export declare function resolveConfiguredProviderFallback(params: {
    cfg: Pick<OpenClawConfig, "models">;
    defaultProvider: string;
    defaultModel?: string;
}): ProviderModelRef | null;
export {};
