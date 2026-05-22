import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginCompatCode } from "./compat/registry.js";
import { type PluginCapabilityEntry, type PluginInspectShape } from "./inspect-shape.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { type PluginRegistrySnapshotDiagnostic, type PluginRegistrySnapshotSource } from "./plugin-registry.js";
import { type PluginRegistry } from "./registry.js";
import type { PluginHookName, PluginLogger } from "./types.js";
export type PluginStatusReport = PluginRegistry & {
    workspaceDir?: string;
};
export type PluginRegistryStatusReport = PluginStatusReport & {
    registrySource: PluginRegistrySnapshotSource;
    registryDiagnostics: readonly PluginRegistrySnapshotDiagnostic[];
};
export type { PluginCapabilityKind, PluginInspectShape } from "./inspect-shape.js";
export type PluginCompatibilityNotice = {
    pluginId: string;
    code: "legacy-before-agent-start" | "hook-only";
    compatCode: PluginCompatCode;
    severity: "warn" | "info";
    message: string;
};
export type PluginCompatibilitySummary = {
    noticeCount: number;
    pluginCount: number;
};
export type PluginInspectReport = {
    workspaceDir?: string;
    plugin: PluginRegistry["plugins"][number];
    shape: PluginInspectShape;
    capabilityMode: "none" | "plain" | "hybrid";
    capabilityCount: number;
    capabilities: PluginCapabilityEntry[];
    typedHooks: Array<{
        name: PluginHookName;
        priority?: number;
    }>;
    customHooks: Array<{
        name: string;
        events: string[];
    }>;
    tools: Array<{
        names: string[];
        optional: boolean;
    }>;
    commands: string[];
    cliCommands: string[];
    services: string[];
    gatewayDiscoveryServices: string[];
    gatewayMethods: string[];
    mcpServers: Array<{
        name: string;
        hasStdioTransport: boolean;
    }>;
    lspServers: Array<{
        name: string;
        hasStdioTransport: boolean;
    }>;
    httpRouteCount: number;
    bundleCapabilities: string[];
    diagnostics: PluginDiagnostic[];
    policy: {
        allowPromptInjection?: boolean;
        allowConversationAccess?: boolean;
        hookTimeoutMs?: number;
        hookTimeouts?: Record<string, number>;
        allowModelOverride?: boolean;
        allowedModels: string[];
        hasAllowedModelsConfig: boolean;
    };
    usesLegacyBeforeAgentStart: boolean;
    compatibility: PluginCompatibilityNotice[];
};
type PluginReportParams = {
    config?: OpenClawConfig;
    effectiveOnly?: boolean;
    onlyPluginIds?: readonly string[];
    workspaceDir?: string;
    /** Use an explicit env when plugin roots should resolve independently from process.env. */
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    resolvedConfig?: OpenClawConfig;
};
export declare function buildPluginRegistrySnapshotReport(params?: PluginReportParams): PluginRegistryStatusReport;
export declare function buildPluginSnapshotReport(params?: PluginReportParams): PluginStatusReport;
export declare function buildPluginDiagnosticsReport(params?: PluginReportParams): PluginStatusReport;
export declare function buildPluginInspectReport(params: {
    id: string;
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    report?: PluginStatusReport;
    resolvedConfig?: OpenClawConfig;
}): PluginInspectReport | null;
export declare function buildAllPluginInspectReports(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    report?: PluginStatusReport;
}): PluginInspectReport[];
export declare function buildPluginCompatibilityWarnings(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    report?: PluginStatusReport;
}): string[];
export declare function buildPluginCompatibilityNotices(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
    logger?: PluginLogger;
    report?: PluginStatusReport;
}): PluginCompatibilityNotice[];
export declare function buildPluginCompatibilitySnapshotNotices(params?: {
    config?: OpenClawConfig;
    workspaceDir?: string;
    env?: NodeJS.ProcessEnv;
}): PluginCompatibilityNotice[];
export declare function formatPluginCompatibilityNotice(notice: PluginCompatibilityNotice): string;
export declare function summarizePluginCompatibility(notices: PluginCompatibilityNotice[]): PluginCompatibilitySummary;
