import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { type CommandSecretResolutionMode } from "./command-secret-gateway.js";
export declare function resolveCommandConfigWithSecrets<TConfig extends OpenClawConfig>(params: {
    config: TConfig;
    commandName: string;
    targetIds: Set<string>;
    mode?: CommandSecretResolutionMode;
    allowedPaths?: Set<string>;
    runtime?: RuntimeEnv;
    autoEnable?: boolean;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    resolvedConfig: TConfig;
    effectiveConfig: TConfig;
    diagnostics: string[];
}>;
