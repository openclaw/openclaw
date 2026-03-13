import type { OpenClawConfig } from "../config/config.js";
type ResolveCommandSecretsResult = {
    resolvedConfig: OpenClawConfig;
    diagnostics: string[];
    targetStatesByPath: Record<string, CommandSecretTargetState>;
    hadUnresolvedTargets: boolean;
};
export type CommandSecretResolutionMode = "strict" | "summary" | "operational_readonly";
export type CommandSecretTargetState = "resolved_gateway" | "resolved_local" | "inactive_surface" | "unresolved";
export declare function resolveCommandSecretRefsViaGateway(params: {
    config: OpenClawConfig;
    commandName: string;
    targetIds: Set<string>;
    mode?: CommandSecretResolutionMode;
}): Promise<ResolveCommandSecretsResult>;
export {};
