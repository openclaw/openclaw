export declare function safePluginInstallFileName(input: string): string;
export declare function encodePluginInstallDirName(pluginId: string): string;
export declare function validatePluginId(pluginId: string): string | null;
export declare function matchesExpectedPluginId(params: {
    expectedPluginId?: string;
    pluginId: string;
    manifestPluginId?: string;
    npmPluginId: string;
}): boolean;
export declare function resolveDefaultPluginExtensionsDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveDefaultPluginNpmDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolveDefaultPluginGitDir(env?: NodeJS.ProcessEnv, homedir?: () => string): string;
export declare function resolvePluginInstallDir(pluginId: string, extensionsDir?: string): string;
