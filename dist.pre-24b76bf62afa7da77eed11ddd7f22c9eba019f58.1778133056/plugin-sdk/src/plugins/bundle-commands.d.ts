import type { OpenClawConfig } from "../config/types.openclaw.js";
export type ClaudeBundleCommandSpec = {
    pluginId: string;
    rawName: string;
    description: string;
    promptTemplate: string;
    sourceFilePath: string;
};
export declare function loadEnabledClaudeBundleCommands(params: {
    workspaceDir: string;
    cfg?: OpenClawConfig;
}): ClaudeBundleCommandSpec[];
