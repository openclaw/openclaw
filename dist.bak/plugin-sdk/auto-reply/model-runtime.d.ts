import type { SessionEntry } from "../config/sessions.js";
export declare function formatProviderModelRef(providerRaw: string, modelRaw: string): string;
type ModelRef = {
    provider: string;
    model: string;
    label: string;
};
export declare function resolveSelectedAndActiveModel(params: {
    selectedProvider: string;
    selectedModel: string;
    sessionEntry?: Pick<SessionEntry, "modelProvider" | "model">;
}): {
    selected: ModelRef;
    active: ModelRef;
    activeDiffers: boolean;
};
export {};
