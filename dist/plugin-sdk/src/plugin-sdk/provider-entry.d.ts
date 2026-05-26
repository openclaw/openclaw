import { createProviderApiKeyAuthMethod } from "../plugins/provider-api-key-auth.js";
import type { ProviderPlugin, ProviderPluginCatalog, ProviderPluginWizardSetup } from "../plugins/types.js";
import type { OpenClawPluginApi, OpenClawPluginConfigSchema, OpenClawPluginDefinition } from "./plugin-entry.js";
import { buildSingleProviderApiKeyCatalog } from "./provider-catalog-shared.js";
type ApiKeyAuthMethodOptions = Parameters<typeof createProviderApiKeyAuthMethod>[0];
export type SingleProviderPluginApiKeyAuthOptions = Omit<ApiKeyAuthMethodOptions, "providerId" | "expectedProviders" | "wizard"> & {
    expectedProviders?: string[];
    wizard?: false | ProviderPluginWizardSetup;
};
export type SingleProviderPluginCatalogOptions = {
    buildProvider: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
    buildStaticProvider?: Parameters<typeof buildSingleProviderApiKeyCatalog>[0]["buildProvider"];
    allowExplicitBaseUrl?: boolean;
    run?: never;
    order?: never;
    staticRun?: never;
} | {
    run: ProviderPluginCatalog["run"];
    staticRun?: ProviderPluginCatalog["run"];
    order?: ProviderPluginCatalog["order"];
    buildProvider?: never;
    buildStaticProvider?: never;
    allowExplicitBaseUrl?: never;
};
export type SingleProviderPluginOptions = {
    id: string;
    name: string;
    description: string;
    /**
     * @deprecated Declare exclusive plugin kind in `openclaw.plugin.json` via
     * manifest `kind`. Runtime-entry `kind` remains only as a compatibility
     * fallback for older plugins.
     */
    kind?: OpenClawPluginDefinition["kind"];
    configSchema?: OpenClawPluginConfigSchema | (() => OpenClawPluginConfigSchema);
    provider?: {
        id?: string;
        label: string;
        docsPath: string;
        aliases?: string[];
        envVars?: string[];
        auth?: SingleProviderPluginApiKeyAuthOptions[];
        catalog: SingleProviderPluginCatalogOptions;
    } & Omit<ProviderPlugin, "id" | "label" | "docsPath" | "aliases" | "envVars" | "auth" | "catalog" | "staticCatalog">;
    register?: (api: OpenClawPluginApi) => void;
};
export declare function defineSingleProviderPluginEntry(options: SingleProviderPluginOptions): {
    id: string;
    name: string;
    description: string;
    configSchema: OpenClawPluginConfigSchema;
    register: NonNullable<OpenClawPluginDefinition["register"]>;
} & Pick<OpenClawPluginDefinition, "kind" | "nodeHostCommands" | "reload" | "securityAuditCollectors">;
export {};
