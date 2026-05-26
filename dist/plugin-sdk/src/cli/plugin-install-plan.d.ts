import type { BundledPluginSource } from "../plugins/bundled-sources.js";
type BundledLookup = (params: {
    kind: "pluginId" | "npmSpec";
    value: string;
}) => BundledPluginSource | undefined;
type OfficialExternalPluginLookup = (pluginId: string) => {
    pluginId: string;
    npmSpec?: string;
    expectedIntegrity?: string;
} | undefined;
type OfficialExternalPackageLookup = (packageName: string) => {
    pluginId: string;
    npmSpec?: string;
    expectedIntegrity?: string;
} | undefined;
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
export declare function resolveOfficialExternalInstallPlanBeforeNpm(params: {
    rawSpec: string;
    findOfficialExternalPlugin: OfficialExternalPluginLookup;
}): {
    pluginId: string;
    npmSpec: string;
    expectedIntegrity?: string;
} | null;
export declare function resolveOfficialExternalNpmPackageTrust(params: {
    npmSpec: string;
    findOfficialExternalPackage: OfficialExternalPackageLookup;
}): {
    pluginId: string;
    expectedIntegrity?: string;
    trustedSourceLinkedOfficialInstall: true;
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
