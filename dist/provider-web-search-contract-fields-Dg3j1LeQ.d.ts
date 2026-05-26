import { U as WebSearchProviderPlugin } from "./types-core-DxqEkbXr.js";
//#region src/plugin-sdk/provider-web-search-contract-fields.d.ts
type WebSearchProviderContractCredential = {
  type: "none";
} | {
  type: "top-level";
} | {
  type: "scoped";
  scopeId: string;
};
type WebSearchProviderConfiguredCredential = {
  pluginId: string;
  field?: string;
};
type CreateWebSearchProviderContractFieldsOptions = {
  credentialPath: string;
  inactiveSecretPaths?: string[];
  searchCredential: WebSearchProviderContractCredential;
  configuredCredential?: WebSearchProviderConfiguredCredential;
};
type WebSearchProviderContractFields = Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> & Partial<Pick<WebSearchProviderPlugin, "getConfiguredCredentialValue" | "setConfiguredCredentialValue">>;
declare function createBaseWebSearchProviderContractFields(options: CreateWebSearchProviderContractFieldsOptions): WebSearchProviderContractFields;
//#endregion
export { createBaseWebSearchProviderContractFields as a, WebSearchProviderContractFields as i, WebSearchProviderConfiguredCredential as n, WebSearchProviderContractCredential as r, CreateWebSearchProviderContractFieldsOptions as t };