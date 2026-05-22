import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { PluginManifestChannelConfig, PluginManifestContracts, PluginPackageInstall } from "./manifest.js";
type ManifestKey = typeof MANIFEST_KEY;
export type OfficialExternalProviderAuthChoice = {
    method?: string;
    choiceId?: string;
    choiceLabel?: string;
    choiceHint?: string;
    assistantPriority?: number;
    assistantVisibility?: "visible" | "manual-only";
    groupId?: string;
    groupLabel?: string;
    groupHint?: string;
    optionKey?: string;
    cliFlag?: string;
    cliOption?: string;
    cliDescription?: string;
    onboardingScopes?: readonly ("text-inference" | "image-generation")[];
};
export type OfficialExternalProviderCatalogProvider = {
    id?: string;
    name?: string;
    docs?: string;
    categories?: readonly string[];
    authChoices?: readonly OfficialExternalProviderAuthChoice[];
};
export type OfficialExternalWebSearchProvider = {
    id?: string;
    label?: string;
    hint?: string;
    onboardingScopes?: readonly "text-inference"[];
    requiresCredential?: boolean;
    credentialLabel?: string;
    envVars?: readonly string[];
    placeholder?: string;
    signupUrl?: string;
    docsUrl?: string;
    credentialPath?: string;
    autoDetectOrder?: number;
};
export type OfficialExternalPluginCatalogManifest = {
    plugin?: {
        id?: string;
        label?: string;
    };
    channel?: {
        id?: string;
        label?: string;
    };
    providers?: readonly OfficialExternalProviderCatalogProvider[];
    webSearchProviders?: readonly OfficialExternalWebSearchProvider[];
    install?: PluginPackageInstall;
    contracts?: PluginManifestContracts;
    channelConfigs?: Record<string, PluginManifestChannelConfig>;
};
export type OfficialExternalPluginCatalogEntry = {
    name?: string;
    version?: string;
    description?: string;
    source?: string;
    kind?: string;
} & Partial<Record<ManifestKey, OfficialExternalPluginCatalogManifest>>;
export declare function getOfficialExternalPluginCatalogManifest(entry: OfficialExternalPluginCatalogEntry): OfficialExternalPluginCatalogManifest | undefined;
export declare function resolveOfficialExternalPluginId(entry: OfficialExternalPluginCatalogEntry): string | undefined;
export declare function resolveOfficialExternalPluginLabel(entry: OfficialExternalPluginCatalogEntry): string;
export declare function resolveOfficialExternalPluginInstall(entry: OfficialExternalPluginCatalogEntry): PluginPackageInstall | null;
export declare function listOfficialExternalPluginCatalogEntries(): OfficialExternalPluginCatalogEntry[];
export declare function listOfficialExternalChannelCatalogEntries(): OfficialExternalPluginCatalogEntry[];
export declare function listOfficialExternalProviderCatalogEntries(): OfficialExternalPluginCatalogEntry[];
export declare function getOfficialExternalPluginCatalogEntry(pluginId: string): OfficialExternalPluginCatalogEntry | undefined;
export declare function getOfficialExternalPluginCatalogEntryForPackage(packageName: string | undefined): OfficialExternalPluginCatalogEntry | undefined;
export {};
