import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
export declare const CODEX_RUNTIME_PLUGIN_ID = "codex";
export type CodexRuntimePluginInstallResult = {
    cfg: OpenClawConfig;
    required: boolean;
    installed: boolean;
    status?: "installed" | "skipped" | "failed" | "timed_out";
};
export declare function selectedModelShouldEnsureCodexRuntimePlugin(params: {
    cfg: OpenClawConfig;
    model?: string;
}): boolean;
export declare function ensureCodexRuntimePluginForModelSelection(params: {
    cfg: OpenClawConfig;
    model?: string;
    prompter: WizardPrompter;
    runtime: RuntimeEnv;
    workspaceDir?: string;
}): Promise<CodexRuntimePluginInstallResult>;
export declare function repairCodexRuntimePluginInstallForModelSelection(params: {
    cfg: OpenClawConfig;
    model?: string;
    env?: NodeJS.ProcessEnv;
}): Promise<{
    required: boolean;
    changes: string[];
    warnings: string[];
}>;
