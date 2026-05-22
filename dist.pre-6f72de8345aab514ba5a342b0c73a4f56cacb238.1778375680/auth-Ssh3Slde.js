import { r as resolveProviderIdForAuth } from "./provider-auth-aliases-CMFAgCpW.js";
import { t as normalizeEmbeddedAgentRuntime } from "./runtime--ZPKHuu1.js";
import { s as shouldRouteOpenAIPiThroughCodexAuthProvider } from "./openai-codex-routing-BHd9kAAe.js";
//#region src/agents/runtime-plan/auth.ts
const CODEX_HARNESS_AUTH_PROVIDER = "openai-codex";
function resolveHarnessAuthProvider(params) {
	const harnessId = normalizeEmbeddedAgentRuntime(params.harnessId);
	const runtime = normalizeEmbeddedAgentRuntime(params.harnessRuntime);
	return harnessId === "codex" || runtime === "codex" ? CODEX_HARNESS_AUTH_PROVIDER : void 0;
}
function buildAgentRuntimeAuthPlan(params) {
	const aliasLookupParams = {
		config: params.config,
		workspaceDir: params.workspaceDir
	};
	const providerForAuth = resolveProviderIdForAuth(params.provider, aliasLookupParams);
	const authProfileProviderForAuth = resolveProviderIdForAuth(params.authProfileProvider ?? params.provider, aliasLookupParams);
	const harnessAuthProvider = resolveHarnessAuthProvider(params);
	const harnessProviderForAuth = harnessAuthProvider ? resolveProviderIdForAuth(harnessAuthProvider, aliasLookupParams) : void 0;
	const harnessCanForwardProfile = params.allowHarnessAuthProfileForwarding !== false && harnessProviderForAuth && harnessProviderForAuth === authProfileProviderForAuth;
	const openAIPiCanForwardCodexProfile = shouldRouteOpenAIPiThroughCodexAuthProvider({
		provider: providerForAuth,
		harnessRuntime: params.harnessRuntime,
		agentHarnessId: params.harnessId,
		authProfileProvider: authProfileProviderForAuth,
		authProfileId: params.sessionAuthProfileId,
		config: params.config,
		workspaceDir: params.workspaceDir
	});
	const canForwardProfile = !harnessProviderForAuth && providerForAuth === authProfileProviderForAuth || harnessCanForwardProfile || openAIPiCanForwardCodexProfile;
	return {
		providerForAuth,
		authProfileProviderForAuth,
		...harnessProviderForAuth ? { harnessAuthProvider: harnessProviderForAuth } : {},
		...canForwardProfile ? { forwardedAuthProfileId: params.sessionAuthProfileId } : {}
	};
}
//#endregion
export { buildAgentRuntimeAuthPlan as t };
