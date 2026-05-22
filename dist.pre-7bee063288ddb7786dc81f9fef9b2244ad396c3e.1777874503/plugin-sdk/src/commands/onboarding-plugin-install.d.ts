import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginPackageInstall } from "../plugins/manifest.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export type OnboardingPluginInstallEntry = {
    pluginId: string;
    label: string;
    install: PluginPackageInstall;
};
export type OnboardingPluginInstallStatus = "installed" | "skipped" | "failed" | "timed_out";
export type OnboardingPluginInstallResult = {
    cfg: OpenClawConfig;
    installed: boolean;
    pluginId: string;
    status: OnboardingPluginInstallStatus;
};
export declare function ensureOnboardingPluginInstalled(params: {
    cfg: OpenClawConfig;
    entry: OnboardingPluginInstallEntry;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    workspaceDir?: string;
    promptInstall?: boolean;
    autoConfirmSingleSource?: boolean;
}): Promise<OnboardingPluginInstallResult>;
