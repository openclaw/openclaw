type ConfigSetMode = "value" | "json" | "ref_builder" | "provider_builder" | "batch";
type ConfigSetModeResolution = {
    ok: true;
    mode: ConfigSetMode;
} | {
    ok: false;
    error: string;
};
export declare function resolveConfigSetMode(params: {
    hasBatchMode: boolean;
    hasRefBuilderOptions: boolean;
    hasProviderBuilderOptions: boolean;
    strictJson: boolean;
}): ConfigSetModeResolution;
export {};
