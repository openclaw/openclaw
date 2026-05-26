import { type ConfiguredAgentHarnessRuntimeOptions } from "../../../agents/harness-runtimes.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { PluginPackageInstall } from "../../../plugins/manifest.js";
export type ConfiguredRuntimePluginInstallCandidate = {
    pluginId: string;
    label: string;
    npmSpec?: string;
    clawhubSpec?: string;
    trustedSourceLinkedOfficialInstall?: boolean;
    defaultChoice?: PluginPackageInstall["defaultChoice"];
};
export declare const CONFIGURED_RUNTIME_PLUGIN_INSTALL_CANDIDATES: readonly ConfiguredRuntimePluginInstallCandidate[];
export declare function resolveConfiguredRuntimePluginInstallCandidate(runtimeId: string): ConfiguredRuntimePluginInstallCandidate | undefined;
export declare function collectConfiguredRuntimePluginIds(cfg: OpenClawConfig, env: NodeJS.ProcessEnv, options?: ConfiguredAgentHarnessRuntimeOptions): string[];
