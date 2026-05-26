import { o as normalizeTokenProviderInput } from "./provider-auth-input-DMNIEm93.js";
import { t as resolvePluginProviders } from "./provider-auth-choice.runtime-CHcmr6A-.js";
import { i as resolveProviderMatch } from "./provider-auth-choice-helpers-DA-F8Rp0.js";
//#region src/commands/auth-choice.apply.api-providers.ts
function resolveProviderAuthChoiceByKind(params) {
	return resolveProviderMatch(resolvePluginProviders({
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env,
		mode: "setup"
	}), params.providerId)?.auth.find((method) => method.kind === params.kind)?.wizard?.choiceId;
}
function normalizeApiKeyTokenProviderAuthChoice(params) {
	if (!params.tokenProvider) return params.authChoice;
	const normalizedTokenProvider = normalizeTokenProviderInput(params.tokenProvider);
	if (!normalizedTokenProvider) return params.authChoice;
	if (params.authChoice === "token" || params.authChoice === "setup-token") return resolveProviderAuthChoiceByKind({
		providerId: normalizedTokenProvider,
		kind: "token",
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) ?? params.authChoice;
	if (params.authChoice !== "apiKey") return params.authChoice;
	return resolveProviderAuthChoiceByKind({
		providerId: normalizedTokenProvider,
		kind: "api_key",
		config: params.config,
		workspaceDir: params.workspaceDir,
		env: params.env
	}) ?? params.authChoice;
}
//#endregion
export { normalizeApiKeyTokenProviderAuthChoice as t };
