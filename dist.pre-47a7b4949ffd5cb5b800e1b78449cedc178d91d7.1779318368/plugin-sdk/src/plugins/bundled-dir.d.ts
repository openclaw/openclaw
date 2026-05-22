export type SourceCheckoutDependencyDiagnostic = {
    source: string;
    message: string;
};
export declare function areBundledPluginsDisabled(env?: NodeJS.ProcessEnv): boolean;
export declare function resolveSourceCheckoutDependencyDiagnostic(env?: NodeJS.ProcessEnv): SourceCheckoutDependencyDiagnostic | null;
export declare function resolveBundledPluginsDir(env?: NodeJS.ProcessEnv): string | undefined;
export declare function setBundledPluginsDirOverrideForTest(dir: string | undefined): void;
