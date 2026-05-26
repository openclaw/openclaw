import type { OpenClawConfig } from "../config/types.openclaw.js";
type SetupRegistryRuntimeModule = Pick<typeof import("./setup-registry.js"), "resolvePluginSetupCliBackend">;
type SetupCliBackendRuntimeEntry = {
    pluginId: string;
    backend: {
        id: string;
    };
};
type SetupCliBackendRuntimeLookupParams = {
    backend: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
};
export declare const __testing: {
    resetRuntimeState(): void;
    setRuntimeModuleForTest(module: SetupRegistryRuntimeModule | null | undefined): void;
};
export declare function resolvePluginSetupCliBackendRuntime(params: SetupCliBackendRuntimeLookupParams): SetupCliBackendRuntimeEntry | undefined;
export {};
