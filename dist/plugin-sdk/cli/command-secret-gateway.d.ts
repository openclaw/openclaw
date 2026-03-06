import type { OpenClawConfig } from "../config/config.js";
type ResolveCommandSecretsResult = {
    resolvedConfig: OpenClawConfig;
    diagnostics: string[];
};
export declare function resolveCommandSecretRefsViaGateway(params: {
    config: OpenClawConfig;
    commandName: string;
    targetIds: Set<string>;
}): Promise<ResolveCommandSecretsResult>;
export {};
