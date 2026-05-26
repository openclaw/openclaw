import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ConfiguredAgentHarnessRuntimeOptions = {
    includeEnvRuntime?: boolean;
    includeImplicitRuntimePreferences?: boolean;
    includeLegacyAgentRuntimes?: boolean;
};
export declare function collectConfiguredAgentHarnessRuntimes(config: OpenClawConfig, env: NodeJS.ProcessEnv, options?: ConfiguredAgentHarnessRuntimeOptions): string[];
