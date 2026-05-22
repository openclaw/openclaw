import { type PluginModuleLoaderFactory } from "../../plugins/plugin-module-loader-cache.js";
export declare function setChannelPluginModuleLoaderFactoryForTest(factory?: PluginModuleLoaderFactory): void;
export declare function resolveExistingPluginModulePath(rootDir: string, specifier: string): string;
export declare function loadChannelPluginModule(params: {
    modulePath: string;
    rootDir: string;
    boundaryRootDir?: string;
    boundaryLabel?: string;
}): unknown;
