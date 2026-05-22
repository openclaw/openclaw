import { r as ensureGlobalUndiciEnvProxyDispatcher } from "../../undici-global-dispatcher-g5Mnd971.js";
import "../../runtime-env-D9goOc6d.js";
import { getOAuthApiKey as getOAuthApiKey$1, refreshOpenAICodexToken as refreshOpenAICodexToken$1 } from "@earendil-works/pi-ai/oauth";
//#region extensions/openai/openai-codex-provider.runtime.ts
function createOpenAICodexProviderRuntime(deps) {
	return {
		async getOAuthApiKey(...args) {
			deps.ensureGlobalUndiciEnvProxyDispatcher();
			return await deps.getOAuthApiKey(...args);
		},
		async refreshOpenAICodexToken(...args) {
			deps.ensureGlobalUndiciEnvProxyDispatcher();
			return await deps.refreshOpenAICodexToken(...args);
		}
	};
}
const runtime = createOpenAICodexProviderRuntime({
	ensureGlobalUndiciEnvProxyDispatcher,
	getOAuthApiKey: getOAuthApiKey$1,
	refreshOpenAICodexToken: refreshOpenAICodexToken$1
});
async function getOAuthApiKey(...args) {
	return await runtime.getOAuthApiKey(...args);
}
async function refreshOpenAICodexToken(...args) {
	return await runtime.refreshOpenAICodexToken(...args);
}
//#endregion
export { createOpenAICodexProviderRuntime, getOAuthApiKey, refreshOpenAICodexToken };
