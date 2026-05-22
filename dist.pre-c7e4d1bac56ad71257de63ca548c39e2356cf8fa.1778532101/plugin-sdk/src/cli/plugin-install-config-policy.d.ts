import type { Command } from "commander";
type PluginInstallInvalidConfigPolicy = "deny" | "allow-plugin-recovery";
export type PluginInstallRequestContext = {
    rawSpec: string;
    normalizedSpec: string;
    resolvedPath?: string;
    marketplace?: string;
    bundledPluginId?: string;
    allowInvalidConfigRecovery?: boolean;
};
type PluginInstallRequestResolution = {
    ok: true;
    request: PluginInstallRequestContext;
} | {
    ok: false;
    error: string;
};
export declare function resolvePluginInstallRequestContext(params: {
    rawSpec: string;
    marketplace?: string;
}): PluginInstallRequestResolution;
export declare function resolvePluginInstallPreactionRequest(params: {
    actionCommand: Command;
    commandPath: string[];
    argv: string[];
}): PluginInstallRequestContext | null;
export declare function resolvePluginInstallInvalidConfigPolicy(request: PluginInstallRequestContext | null): PluginInstallInvalidConfigPolicy;
export {};
