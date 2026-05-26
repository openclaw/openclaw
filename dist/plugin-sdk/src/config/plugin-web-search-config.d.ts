type PluginWebSearchConfigCarrier = {
    plugins?: {
        entries?: Record<string, {
            config?: unknown;
        }>;
    };
};
export declare function resolvePluginWebSearchConfig(config: PluginWebSearchConfigCarrier | undefined, pluginId: string): Record<string, unknown> | undefined;
export {};
