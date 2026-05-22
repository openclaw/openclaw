import type { ModelsProviderData } from "openclaw/plugin-sdk/models-provider-runtime";
export declare function createModelsProviderData(entries: Record<string, string[]>, opts?: {
    defaultProviderOrder?: "insertion" | "sorted";
}): ModelsProviderData;
