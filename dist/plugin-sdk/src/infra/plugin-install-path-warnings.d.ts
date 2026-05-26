import type { PluginInstallRecord } from "../config/types.plugins.js";
type PluginInstallPathIssue = {
    kind: "custom-path" | "missing-path";
    pluginId: string;
    path: string;
};
export declare function detectPluginInstallPathIssue(params: {
    pluginId: string;
    install: PluginInstallRecord | null | undefined;
}): Promise<PluginInstallPathIssue | null>;
export declare function formatPluginInstallPathIssue(params: {
    issue: PluginInstallPathIssue;
    pluginLabel: string;
    defaultInstallCommand: string;
    repoInstallCommand?: string | null;
    formatCommand?: (command: string) => string;
}): string[];
export {};
