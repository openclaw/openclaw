//#region src/plugin-sdk/provider-enable-config.d.ts
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
type PluginEnableResult<TConfig extends ProviderEnableConfigCarrier> = {
  config: TConfig;
  enabled: boolean;
  reason?: string;
};
/**
 * Provider contract surfaces only ever enable provider plugins, so they do not
 * need the built-in channel normalization path from plugins/enable.ts.
 */
declare function enablePluginInConfig<TConfig extends ProviderEnableConfigCarrier>(cfg: TConfig, pluginId: string): PluginEnableResult<TConfig>;
//#endregion
export { enablePluginInConfig as t };