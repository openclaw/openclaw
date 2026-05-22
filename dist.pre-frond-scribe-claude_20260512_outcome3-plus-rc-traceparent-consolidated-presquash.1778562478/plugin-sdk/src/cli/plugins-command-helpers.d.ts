import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginLogger } from "../plugins/types.js";
import { type RuntimeEnv } from "../runtime.js";
export declare const quietPluginJsonLogger: PluginLogger;
export declare function resolveFileNpmSpecToLocalPath(raw: string): {
    ok: true;
    path: string;
} | {
    ok: false;
    error: string;
} | null;
export declare function applySlotSelectionForPlugin(config: OpenClawConfig, pluginId: string): {
    config: OpenClawConfig;
    warnings: string[];
};
export declare function createPluginInstallLogger(runtime?: RuntimeEnv): {
    info: (msg: string) => void;
    warn: (msg: string) => void;
};
export declare function createHookPackInstallLogger(runtime?: RuntimeEnv): {
    info: (msg: string) => void;
    warn: (msg: string) => void;
};
export declare function enableInternalHookEntries(config: OpenClawConfig, hookNames: string[]): OpenClawConfig;
export declare function formatPluginInstallWithHookFallbackError(pluginError: string, hookError: string): string;
export declare function logHookPackRestartHint(runtime?: RuntimeEnv): void;
export declare function logSlotWarnings(warnings: string[], runtime?: RuntimeEnv): void;
export declare function parseNpmPrefixSpec(raw: string): string | null;
