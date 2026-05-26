import { a as setProviderWebSearchPluginConfigValue, i as resolveProviderWebSearchPluginConfig, n as getTopLevelCredentialValue, o as setScopedCredentialValue, s as setTopLevelCredentialValue, t as getScopedCredentialValue } from "./web-search-provider-config-CM5VNRaS.js";
//#region src/plugin-sdk/provider-web-search-contract-fields.ts
function createSearchCredentialFields(credential) {
	switch (credential.type) {
		case "scoped": return {
			getCredentialValue: (searchConfig) => getScopedCredentialValue(searchConfig, credential.scopeId),
			setCredentialValue: (searchConfigTarget, value) => setScopedCredentialValue(searchConfigTarget, credential.scopeId, value)
		};
		case "top-level": return {
			getCredentialValue: getTopLevelCredentialValue,
			setCredentialValue: setTopLevelCredentialValue
		};
		case "none": return {
			getCredentialValue: () => void 0,
			setCredentialValue: () => {}
		};
	}
	throw new Error("Unsupported web search credential type");
}
function createConfiguredCredentialFields(configuredCredential) {
	if (!configuredCredential) return null;
	const field = configuredCredential.field ?? "apiKey";
	return {
		getConfiguredCredentialValue: (config) => resolveProviderWebSearchPluginConfig(config, configuredCredential.pluginId)?.[field],
		setConfiguredCredentialValue: (configTarget, value) => {
			setProviderWebSearchPluginConfigValue(configTarget, configuredCredential.pluginId, field, value);
		}
	};
}
function createBaseWebSearchProviderContractFields(options) {
	const configuredCredentialFields = createConfiguredCredentialFields(options.configuredCredential);
	return {
		inactiveSecretPaths: options.inactiveSecretPaths ?? (options.credentialPath ? [options.credentialPath] : []),
		...createSearchCredentialFields(options.searchCredential),
		...configuredCredentialFields
	};
}
//#endregion
export { createBaseWebSearchProviderContractFields as t };
