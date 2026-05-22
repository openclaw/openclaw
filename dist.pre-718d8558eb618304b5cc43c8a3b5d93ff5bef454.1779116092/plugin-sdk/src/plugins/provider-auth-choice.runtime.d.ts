type ResolveProviderPluginChoice = typeof import("./provider-wizard.js").resolveProviderPluginChoice;
type RunProviderModelSelectedHook = typeof import("./provider-wizard.js").runProviderModelSelectedHook;
type ResolvePluginProviders = typeof import("./providers.runtime.js").resolvePluginProviders;
type ResolvePluginSetupProvider = typeof import("./setup-registry.js").resolvePluginSetupProvider;
export declare function resolveProviderPluginChoice(...args: Parameters<ResolveProviderPluginChoice>): ReturnType<ResolveProviderPluginChoice>;
export declare function runProviderModelSelectedHook(...args: Parameters<RunProviderModelSelectedHook>): ReturnType<RunProviderModelSelectedHook>;
export declare function resolvePluginProviders(...args: Parameters<ResolvePluginProviders>): ReturnType<ResolvePluginProviders>;
export declare function resolvePluginSetupProvider(...args: Parameters<ResolvePluginSetupProvider>): ReturnType<ResolvePluginSetupProvider>;
export {};
