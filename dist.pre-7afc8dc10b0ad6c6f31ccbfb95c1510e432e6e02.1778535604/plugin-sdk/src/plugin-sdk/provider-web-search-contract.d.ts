import type { WebSearchCredentialResolutionSource, WebSearchProviderSetupContext, WebSearchProviderPlugin, WebSearchProviderToolDefinition, WebSearchProviderToolExecutionContext } from "../plugins/types.js";
import { type CreateWebSearchProviderContractFieldsOptions } from "./provider-web-search-contract-fields.js";
export { getScopedCredentialValue, getTopLevelCredentialValue, mergeScopedSearchConfig, resolveProviderWebSearchPluginConfig, setScopedCredentialValue, setProviderWebSearchPluginConfigValue, setTopLevelCredentialValue, } from "../agents/tools/web-search-provider-config.js";
export { enablePluginInConfig } from "./provider-enable-config.js";
export type { WebSearchCredentialResolutionSource, WebSearchProviderSetupContext, WebSearchProviderPlugin, WebSearchProviderToolDefinition, WebSearchProviderToolExecutionContext, };
export type { CreateWebSearchProviderContractFieldsOptions, WebSearchProviderConfiguredCredential, WebSearchProviderContractCredential, WebSearchProviderContractFields, } from "./provider-web-search-contract-fields.js";
type CreateWebSearchProviderSelectionOptions = CreateWebSearchProviderContractFieldsOptions & {
    selectionPluginId?: string;
};
export declare function createWebSearchProviderContractFields(options: CreateWebSearchProviderSelectionOptions): Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> & Partial<Pick<WebSearchProviderPlugin, "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue">>;
