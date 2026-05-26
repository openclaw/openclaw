import { c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { a as resolveManifestProviderOnboardAuthFlags } from "./provider-auth-choices-BFWeF5vS.js";
import { t as CORE_ONBOARD_AUTH_FLAGS } from "./onboard-core-auth-flags-CINE1eGu.js";
//#region src/commands/onboard-non-interactive/local/auth-choice-inference.ts
function hasStringValue(value) {
	return typeof value === "string" ? Boolean(normalizeOptionalString(value)) : Boolean(value);
}
function inferAuthChoiceFromFlags(opts, params) {
	const matches = [...CORE_ONBOARD_AUTH_FLAGS, ...resolveManifestProviderOnboardAuthFlags({
		config: params?.config,
		workspaceDir: params?.workspaceDir,
		env: params?.env,
		includeUntrustedWorkspacePlugins: false
	})].filter(({ optionKey }) => hasStringValue(opts[optionKey])).map((flag) => ({
		optionKey: flag.optionKey,
		authChoice: flag.authChoice,
		label: flag.cliFlag
	}));
	if (hasStringValue(opts.customBaseUrl) || hasStringValue(opts.customModelId) || hasStringValue(opts.customApiKey)) matches.push({
		optionKey: "customBaseUrl",
		authChoice: "custom-api-key",
		label: "--custom-base-url/--custom-model-id/--custom-api-key"
	});
	return {
		choice: matches[0]?.authChoice,
		matches
	};
}
//#endregion
export { inferAuthChoiceFromFlags };
