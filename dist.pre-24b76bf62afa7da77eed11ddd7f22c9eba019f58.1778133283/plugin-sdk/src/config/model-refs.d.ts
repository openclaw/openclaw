export type ConfiguredModelRef = {
    path: string;
    value: string;
};
export declare const AGENT_MODEL_CONFIG_KEYS: readonly ["model", "imageModel", "imageGenerationModel", "videoGenerationModel", "musicGenerationModel", "pdfModel"];
export declare function collectConfiguredModelRefs(config: unknown, options?: {
    includeChannelModelOverrides?: boolean;
}): ConfiguredModelRef[];
