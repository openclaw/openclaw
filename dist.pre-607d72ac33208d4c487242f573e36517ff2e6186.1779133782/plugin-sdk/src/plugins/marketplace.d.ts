import type { InstallSafetyOverrides } from "./install-security-scan.js";
import { type InstallPluginResult } from "./install.js";
type MarketplaceLogger = {
    info?: (message: string) => void;
    warn?: (message: string) => void;
};
type MarketplaceEntrySource = {
    kind: "path";
    path: string;
} | {
    kind: "github";
    repo: string;
    path?: string;
    ref?: string;
} | {
    kind: "git";
    url: string;
    path?: string;
    ref?: string;
} | {
    kind: "git-subdir";
    url: string;
    path: string;
    ref?: string;
} | {
    kind: "url";
    url: string;
};
export type MarketplacePluginEntry = {
    name: string;
    version?: string;
    description?: string;
    source: MarketplaceEntrySource;
};
export type MarketplaceManifest = {
    name?: string;
    version?: string;
    plugins: MarketplacePluginEntry[];
};
export type MarketplacePluginListResult = {
    ok: true;
    manifest: MarketplaceManifest;
    sourceLabel: string;
} | {
    ok: false;
    error: string;
};
export type MarketplaceInstallResult = ({
    ok: true;
    marketplaceName?: string;
    marketplaceVersion?: string;
    marketplacePlugin: string;
    marketplaceSource: string;
    marketplaceEntryVersion?: string;
} & Extract<InstallPluginResult, {
    ok: true;
}>) | Extract<InstallPluginResult, {
    ok: false;
}>;
export type MarketplaceShortcutResolution = {
    ok: true;
    plugin: string;
    marketplaceName: string;
    marketplaceSource: string;
} | {
    ok: false;
    error: string;
} | null;
export declare function listMarketplacePlugins(params: {
    marketplace: string;
    logger?: MarketplaceLogger;
    timeoutMs?: number;
}): Promise<MarketplacePluginListResult>;
export declare function resolveMarketplaceInstallShortcut(raw: string): Promise<MarketplaceShortcutResolution>;
export declare function installPluginFromMarketplace(params: InstallSafetyOverrides & {
    marketplace: string;
    plugin: string;
    logger?: MarketplaceLogger;
    timeoutMs?: number;
    mode?: "install" | "update";
    extensionsDir?: string;
    dryRun?: boolean;
    expectedPluginId?: string;
}): Promise<MarketplaceInstallResult>;
export {};
