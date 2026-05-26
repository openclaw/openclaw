import { U as WebSearchProviderPlugin } from "./types-core-DxqEkbXr.js";
import { t as CreateWebSearchProviderContractFieldsOptions } from "./provider-web-search-contract-fields-Dg3j1LeQ.js";

//#region src/plugin-sdk/provider-web-search-contract.d.ts
type CreateWebSearchProviderSelectionOptions = CreateWebSearchProviderContractFieldsOptions & {
  selectionPluginId?: string;
};
declare function createWebSearchProviderContractFields(options: CreateWebSearchProviderSelectionOptions): Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> & Partial<Pick<WebSearchProviderPlugin, "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue">>;
//#endregion
export { createWebSearchProviderContractFields as t };