import { z as WebSearchProviderPlugin } from "./types-core-xB6vnoi2.js";
import { t as CreateWebSearchProviderContractFieldsOptions } from "./provider-web-search-contract-fields-BOX2XXRH.js";

//#region src/plugin-sdk/provider-web-search-contract.d.ts
type CreateWebSearchProviderSelectionOptions = CreateWebSearchProviderContractFieldsOptions & {
  selectionPluginId?: string;
};
declare function createWebSearchProviderContractFields(options: CreateWebSearchProviderSelectionOptions): Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> & Partial<Pick<WebSearchProviderPlugin, "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue">>;
//#endregion
export { createWebSearchProviderContractFields as t };