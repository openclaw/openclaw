export type ConfiguredModelRef = {
    path: string;
    value: string;
};
export declare const AGENT_MODEL_CONFIG_KEYS: readonly ["model", "imageModel", "imageGenerationModel", "videoGenerationModel", "musicGenerationModel", "pdfModel"];
export declare function collectConfiguredModelRefs(config: unknown, options?: {
    includeChannelModelOverrides?: boolean;
}): ConfiguredModelRef[];
export declare function collectConfiguredModelRefValues(config: unknown, options?: {
    includeChannelModelOverrides?: boolean;
}): string[];
export declare function extractProviderFromModelRef(value: string): string | null;
