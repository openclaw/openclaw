type ProviderPluginConfig = {
    enabled?: boolean;
};
type ProviderEnableConfigCarrier = {
    plugins?: {
        enabled?: boolean;
        deny?: string[];
        allow?: string[];
        entries?: Record<string, ProviderPluginConfig | undefined>;
    };
};
export type PluginEnableResult<TConfig extends ProviderEnableConfigCarrier> = {
    config: TConfig;
    enabled: boolean;
    reason?: string;
};
/**
 * Provider contract surfaces only ever enable provider plugins, so they do not
 * need the built-in channel normalization path from plugins/enable.ts.
 */
export declare function enablePluginInConfig<TConfig extends ProviderEnableConfigCarrier>(cfg: TConfig, pluginId: string): PluginEnableResult<TConfig>;
export {};
