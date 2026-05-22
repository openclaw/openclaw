import type { CliBackendConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveRuntimeCliBackends } from "../plugins/cli-backends.runtime.js";
import { resolvePluginSetupCliBackend } from "../plugins/setup-registry.js";
import type { CliBackendAuthEpochMode, CliBundleMcpMode, CliBackendPlugin, CliBackendNativeToolMode, PluginTextTransforms } from "../plugins/types.js";
type CliBackendsDeps = {
    resolvePluginSetupCliBackend: typeof resolvePluginSetupCliBackend;
    resolveRuntimeCliBackends: typeof resolveRuntimeCliBackends;
};
export type ResolvedCliBackend = {
    id: string;
    config: CliBackendConfig;
    bundleMcp: boolean;
    bundleMcpMode?: CliBundleMcpMode;
    pluginId?: string;
    transformSystemPrompt?: CliBackendPlugin["transformSystemPrompt"];
    textTransforms?: PluginTextTransforms;
    defaultAuthProfileId?: string;
    authEpochMode?: CliBackendAuthEpochMode;
    prepareExecution?: CliBackendPlugin["prepareExecution"];
    resolveExecutionArgs?: CliBackendPlugin["resolveExecutionArgs"];
    nativeToolMode?: CliBackendNativeToolMode;
};
type ResolvedCliBackendLiveTest = {
    defaultModelRef?: string;
    defaultImageProbe: boolean;
    defaultMcpProbe: boolean;
    dockerNpmPackage?: string;
    dockerBinaryName?: string;
};
export declare function resolveCliBackendLiveTest(provider: string): ResolvedCliBackendLiveTest | null;
export declare function resolveCliBackendConfig(provider: string, cfg?: OpenClawConfig, options?: {
    agentId?: string;
}): ResolvedCliBackend | null;
export declare const __testing: {
    resetDepsForTest(): void;
    setDepsForTest(deps: Partial<CliBackendsDeps>): void;
};
export {};
