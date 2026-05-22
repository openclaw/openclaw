import type { WebSearchProviderPlugin } from "../plugins/types.js";
export type WebSearchProviderContractCredential = {
    type: "none";
} | {
    type: "top-level";
} | {
    type: "scoped";
    scopeId: string;
};
export type WebSearchProviderConfiguredCredential = {
    pluginId: string;
    field?: string;
};
export type CreateWebSearchProviderContractFieldsOptions = {
    credentialPath: string;
    inactiveSecretPaths?: string[];
    searchCredential: WebSearchProviderContractCredential;
    configuredCredential?: WebSearchProviderConfiguredCredential;
};
export type WebSearchProviderContractFields = Pick<WebSearchProviderPlugin, "inactiveSecretPaths" | "getCredentialValue" | "setCredentialValue"> & Partial<Pick<WebSearchProviderPlugin, "getConfiguredCredentialValue" | "setConfiguredCredentialValue">>;
export declare function createBaseWebSearchProviderContractFields(options: CreateWebSearchProviderContractFieldsOptions): WebSearchProviderContractFields;
