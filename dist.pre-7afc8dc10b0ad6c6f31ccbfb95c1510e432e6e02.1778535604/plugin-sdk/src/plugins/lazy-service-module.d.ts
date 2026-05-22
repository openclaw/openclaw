type LazyServiceModule = Record<string, unknown>;
export type LazyPluginServiceHandle = {
    stop: () => Promise<void>;
};
export declare function defaultLoadOverrideModule(specifier: string, importModule?: (specifier: string) => Promise<LazyServiceModule>): Promise<LazyServiceModule>;
export declare function startLazyPluginServiceModule(params: {
    skipEnvVar?: string;
    overrideEnvVar?: string;
    validateOverrideSpecifier?: (specifier: string) => string;
    loadDefaultModule: () => Promise<LazyServiceModule>;
    loadOverrideModule?: (specifier: string) => Promise<LazyServiceModule>;
    startExportNames: string[];
    stopExportNames?: string[];
}): Promise<LazyPluginServiceHandle | null>;
export {};
