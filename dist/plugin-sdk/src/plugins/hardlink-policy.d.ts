import type { PluginOrigin } from "./plugin-origin.types.js";
export declare function isNixStorePluginRoot(rootDir: string, realpathCache?: Map<string, string>): boolean;
export declare function shouldRejectHardlinkedPluginFiles(params: {
    origin: PluginOrigin;
    rootDir: string;
    env?: NodeJS.ProcessEnv;
    realpathCache?: Map<string, string>;
}): boolean;
