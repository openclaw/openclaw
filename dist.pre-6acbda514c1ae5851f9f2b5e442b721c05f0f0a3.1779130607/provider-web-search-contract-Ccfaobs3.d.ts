import { U as WebSearchProviderPlugin } from "./types-core-CmalkDje.js";
import { t as CreateWebSearchProviderContractFieldsOptions } from "./provider-web-search-contract-fields-D_EogIvt.js";

//#region src/plugin-sdk/provider-web-search-contract.d.ts
type CreateWebSearchProviderSelectionOptions = CreateWebSearchProviderContractFieldsOptions & {
  selectionPluginId?: string;
};
declare function createWebSearchProviderContractFields(options: CreateWebSearchProviderSelectionOptions): Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> & Partial<Pick<WebSearchProviderPlugin, "applySelectionConfig" | "getConfiguredCredentialValue" | "setConfiguredCredentialValue">>;
//#endregion
export { createWebSearchProviderContractFields as t };