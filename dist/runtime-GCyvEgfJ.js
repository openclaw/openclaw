import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { n as ensureAuthProfileStore } from "./store-a4exFSck.js";
import "./provider-auth-D5QGE8z6.js";
import "./error-runtime-BnVeBNYa.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { d as isFoundryProviderApi, h as resolveConfiguredModelNameHint, l as buildFoundryProviderBaseUrl, u as extractFoundryEndpoint } from "./shared-DatF4mQy.js";
import { a as getAccessTokenResultAsync } from "./cli-caQ-6GVE.js";
import { t as getFoundryTokenCacheKey } from "./shared-runtime-Dqhu1MRl.js";
//#region extensions/microsoft-foundry/runtime.ts
const cachedTokens = /* @__PURE__ */ new Map();
const refreshPromises = /* @__PURE__ */ new Map();
function resetFoundryRuntimeAuthCaches() {
	cachedTokens.clear();
	refreshPromises.clear();
}
async function refreshEntraToken(params) {
	const result = await getAccessTokenResultAsync(params);
	const rawExpiry = result.expiresOn ? new Date(result.expiresOn).getTime() : NaN;
	const expiresAt = Number.isFinite(rawExpiry) ? rawExpiry : Date.now() + 3300 * 1e3;
	cachedTokens.set(getFoundryTokenCacheKey(params), {
		token: result.accessToken,
		expiresAt
	});
	return {
		apiKey: result.accessToken,
		expiresAt
	};
}
async function prepareFoundryRuntimeAuth(ctx) {
	if (ctx.apiKey !== "__entra_id_dynamic__") return null;
	try {
		const authStore = ensureAuthProfileStore(ctx.agentDir, { allowKeychainPrompt: false });
		const credential = ctx.profileId ? authStore.profiles[ctx.profileId] : void 0;
		const metadata = credential?.type === "api_key" ? credential.metadata : void 0;
		const modelId = normalizeOptionalString(ctx.modelId) ?? normalizeOptionalString(metadata?.modelId) ?? ctx.modelId;
		const activeModelNameHint = ctx.modelId === metadata?.modelId ? metadata?.modelName : void 0;
		const modelNameHint = resolveConfiguredModelNameHint(modelId, ctx.model.name ?? activeModelNameHint);
		const configuredApi = typeof metadata?.api === "string" && isFoundryProviderApi(metadata.api) ? metadata.api : isFoundryProviderApi(ctx.model.api) ? ctx.model.api : void 0;
		const endpoint = normalizeOptionalString(metadata?.endpoint) ?? extractFoundryEndpoint(ctx.model.baseUrl ?? "");
		const baseUrl = endpoint ? buildFoundryProviderBaseUrl(endpoint, modelId, modelNameHint, configuredApi) : void 0;
		const cacheKey = getFoundryTokenCacheKey({
			subscriptionId: metadata?.subscriptionId,
			tenantId: metadata?.tenantId
		});
		const cachedToken = cachedTokens.get(cacheKey);
		if (cachedToken && cachedToken.expiresAt > Date.now() + 3e5) return {
			apiKey: cachedToken.token,
			expiresAt: cachedToken.expiresAt,
			...baseUrl ? { baseUrl } : {}
		};
		let refreshPromise = refreshPromises.get(cacheKey);
		if (!refreshPromise) {
			refreshPromise = refreshEntraToken({
				subscriptionId: metadata?.subscriptionId,
				tenantId: metadata?.tenantId
			}).finally(() => {
				refreshPromises.delete(cacheKey);
			});
			refreshPromises.set(cacheKey, refreshPromise);
		}
		return {
			...await refreshPromise,
			...baseUrl ? { baseUrl } : {}
		};
	} catch (err) {
		const details = formatErrorMessage(err);
		throw new Error(`Failed to refresh Azure Entra ID token via az CLI: ${details}`, { cause: err });
	}
}
//#endregion
export { resetFoundryRuntimeAuthCaches as n, prepareFoundryRuntimeAuth as t };
