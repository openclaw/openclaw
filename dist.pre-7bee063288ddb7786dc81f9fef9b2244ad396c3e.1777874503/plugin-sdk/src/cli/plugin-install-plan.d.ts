import type { BundledPluginSource } from "../plugins/bundled-sources.js";
type BundledLookup = (params: {
    kind: "pluginId" | "npmSpec";
    value: string;
}) => BundledPluginSource | undefined;
export declare function resolveBundledInstallPlanForCatalogEntry(params: {
    pluginId: string;
    npmSpec: string;
    findBundledSource: BundledLookup;
}): {
    bundledSource: BundledPluginSource;
} | null;
export declare function resolveBundledInstallPlanBeforeNpm(params: {
    rawSpec: string;
    findBundledSource: BundledLookup;
}): {
    bundledSource: BundledPluginSource;
    warning: string;
} | null;
export declare function resolveBundledInstallPlanForNpmFailure(params: {
    rawSpec: string;
    code?: string;
    findBundledSource: BundledLookup;
}): {
    bundledSource: BundledPluginSource;
    warning: string;
} | null;
export {};
