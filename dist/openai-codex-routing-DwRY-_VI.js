import { s as normalizeOptionalLowercaseString } from "./string-coerce-DyL154ka.js";
import { n as findNormalizedProviderValue, r as normalizeProviderId } from "./provider-id-zTW9Rdln.js";
import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-4jqi6Djx.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime-fVbSwiLb.js";
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
function configuredOpenAIAuthOrderStartsWithCodexProfile(config) {
	if (!openAIProviderUsesCodexRuntimeByDefault({
		provider: "openai",
		config
	})) return false;
	const firstProfile = findNormalizedProviderValue(config?.auth?.order, OPENAI_PROVIDER_ID)?.find((profileId) => typeof profileId === "string" && profileId.trim().length > 0);
	return hasOpenAICodexAuthProfileOverride(firstProfile);
}
function shouldRouteOpenAIPiThroughCodexAuthProvider(params) {
	if (!isOpenAIProvider(params.provider)) return false;
	if (normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime) !== "pi") return false;
	if (!hasOpenAICodexAuthProfileOverride(params.authProfileId)) return false;
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
	if (runtime === "pi") {
		if (configuredOpenAIAuthOrderStartsWithCodexProfile(params.config)) return [OPENAI_CODEX_PROVIDER_ID, OPENAI_PROVIDER_ID];
		return [OPENAI_PROVIDER_ID, OPENAI_CODEX_PROVIDER_ID];
	}
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
function resolveSelectedOpenAIPiRuntimeProvider(params) {
	if (shouldRouteOpenAIPiThroughCodexAuthProvider(params)) return OPENAI_CODEX_PROVIDER_ID;
	const runtime = normalizeEmbeddedAgentRuntime(params.agentHarnessId ?? params.harnessRuntime);
	if (!isOpenAIProvider(params.provider)) return params.provider;
	if (runtime === "codex") return OPENAI_CODEX_PROVIDER_ID;
	return runtime === "pi" && !params.authProfileId?.trim() && configuredOpenAIAuthOrderStartsWithCodexProfile(params.config) ? OPENAI_CODEX_PROVIDER_ID : params.provider;
}
function resolveContextConfigProviderForRuntime(params) {
	const provider = normalizeProviderId(params.provider);
	const runtimeId = normalizeEmbeddedAgentRuntime(params.runtimeId);
	if (provider === "openai" && runtimeId === "codex") return OPENAI_CODEX_PROVIDER_ID;
	return params.provider;
}
//#endregion
export { listOpenAIAuthProfileProvidersForAgentRuntime as a, resolveContextConfigProviderForRuntime as c, shouldRouteOpenAIPiThroughCodexAuthProvider as d, isOpenAIProvider as i, resolveOpenAIRuntimeProviderForPi as l, OPENAI_PROVIDER_ID as n, modelSelectionShouldEnsureCodexPlugin as o, isOpenAICodexProvider as r, openAIProviderUsesCodexRuntimeByDefault as s, OPENAI_CODEX_PROVIDER_ID as t, resolveSelectedOpenAIPiRuntimeProvider as u };
