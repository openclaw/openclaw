import { s as normalizeOptionalLowercaseString } from "./string-coerce-LndEvhRk.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-3NFJcokO.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime-d2Px3Q1Z.js";
//#region src/agents/openai-codex-routing.ts
const OPENAI_PROVIDER_ID = "openai";
const OPENAI_CODEX_PROVIDER_ID = "openai-codex";
function isOfficialOpenAIBaseUrl(baseUrl) {
	if (typeof baseUrl !== "string" || !baseUrl.trim()) return true;
	try {
		const url = new URL(baseUrl.trim());
		return url.protocol === "https:" && url.hostname.toLowerCase() === "api.openai.com" && (url.pathname === "" || url.pathname === "/" || url.pathname === "/v1" || url.pathname === "/v1/");
	} catch {
		return false;
	}
}
function openAIProviderUsesCustomBaseUrl(config) {
	return !isOfficialOpenAIBaseUrl(config?.models?.providers?.openai?.baseUrl);
}
function isOpenAIProvider(provider) {
	return normalizeProviderId(provider ?? "") === OPENAI_PROVIDER_ID;
}
function isOpenAICodexProvider(provider) {
	return normalizeProviderId(provider ?? "") === OPENAI_CODEX_PROVIDER_ID;
}
function openAIProviderUsesCodexRuntimeByDefault(params) {
	return isOpenAIProvider(params.provider) && !openAIProviderUsesCustomBaseUrl(params.config);
}
function parseModelRefProvider(value) {
	if (typeof value !== "string") return;
	const slashIndex = value.trim().indexOf("/");
	if (slashIndex <= 0) return;
	return normalizeProviderId(value.trim().slice(0, slashIndex));
}
function modelSelectionShouldEnsureCodexPlugin(params) {
	const provider = parseModelRefProvider(params.model);
	if (provider === "openai-codex") return true;
	return provider === "openai" && !openAIProviderUsesCustomBaseUrl(params.config);
}
function hasOpenAICodexAuthProfileOverride(value) {
	return typeof value === "string" && normalizeOptionalLowercaseString(value)?.startsWith(`openai-codex:`) === true;
}
function shouldRouteOpenAIPiThroughCodexAuthProvider(params) {
	if (!isOpenAIProvider(params.provider) || !hasOpenAICodexAuthProfileOverride(params.authProfileId)) return false;
	if (normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime) !== "pi") return false;
	const aliasLookupParams = {
		config: params.config,
		workspaceDir: params.workspaceDir
	};
	return resolveProviderIdForAuth(params.authProfileProvider ?? params.authProfileId?.split(":", 1)[0] ?? "", aliasLookupParams) === OPENAI_CODEX_PROVIDER_ID;
}
function listOpenAIAuthProfileProvidersForAgentRuntime(params) {
	if (!isOpenAIProvider(params.provider)) return [params.provider];
	const runtime = normalizeEmbeddedAgentRuntime(normalizeExplicitRuntimePin(params.agentHarnessId) ?? params.harnessRuntime);
	if (runtime === "codex") return [OPENAI_CODEX_PROVIDER_ID];
	if (runtime === "pi") return [OPENAI_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID];
	return [params.provider];
}
function normalizeExplicitRuntimePin(value) {
	if (typeof value !== "string" || !value.trim()) return;
	const runtime = normalizeEmbeddedAgentRuntime(value);
	return runtime === "auto" || runtime === "default" ? void 0 : runtime;
}
function resolveOpenAIRuntimeProviderForPi(params) {
	return shouldRouteOpenAIPiThroughCodexAuthProvider(params) ? OPENAI_CODEX_PROVIDER_ID : params.provider;
}
//#endregion
export { modelSelectionShouldEnsureCodexPlugin as a, shouldRouteOpenAIPiThroughCodexAuthProvider as c, listOpenAIAuthProfileProvidersForAgentRuntime as i, isOpenAICodexProvider as n, openAIProviderUsesCodexRuntimeByDefault as o, isOpenAIProvider as r, resolveOpenAIRuntimeProviderForPi as s, OPENAI_CODEX_PROVIDER_ID as t };
