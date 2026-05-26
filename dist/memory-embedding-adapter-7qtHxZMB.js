import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import "./ssrf-runtime-Be2o3zD7.js";
import "./logging-core-DwEC9Ajh.js";
import { S as buildRemoteBaseUrlPolicy, a as normalizeEmbeddingModelWithPrefixes, l as sanitizeEmbeddingCacheHeaders, t as createRemoteEmbeddingProvider } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import { n as resolveMemorySecretInputString } from "./secret-input-DJirly1z.js";
import { E as LMSTUDIO_DEFAULT_EMBEDDING_MODEL, P as LMSTUDIO_PROVIDER_ID, c as resolveLmstudioRuntimeApiKey, i as buildLmstudioAuthHeaders, n as ensureLmstudioModelLoaded, o as resolveLmstudioProviderHeaders, y as resolveLmstudioInferenceBase } from "./models.fetch-BJryONkH.js";
//#region extensions/lmstudio/src/embedding-provider.ts
const log = createSubsystemLogger("memory/embeddings");
const DEFAULT_LMSTUDIO_EMBEDDING_MODEL = LMSTUDIO_DEFAULT_EMBEDDING_MODEL;
/** Normalizes LM Studio embedding model refs and accepts `lmstudio/` prefix. */
function normalizeLmstudioModel(model) {
	return normalizeEmbeddingModelWithPrefixes({
		model,
		defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
		prefixes: ["lmstudio/"]
	});
}
function hasAuthorizationHeader(headers) {
	if (!headers) return false;
	return Object.entries(headers).some(([headerName, value]) => headerName.trim().toLowerCase() === "authorization" && value.trim().length > 0);
}
/** Resolves API key (real or synthetic placeholder) from runtime/provider auth config. */
async function resolveLmstudioApiKey(options) {
	try {
		return await resolveLmstudioRuntimeApiKey({
			config: options.config,
			agentDir: options.agentDir
		});
	} catch (error) {
		if (/LM Studio API key is required/i.test(formatErrorMessage(error))) return;
		throw error;
	}
}
/** Creates the LM Studio embedding provider client and preloads the target model before return. */
async function createLmstudioEmbeddingProvider(options) {
	const providerConfig = options.config.models?.providers?.lmstudio;
	const providerBaseUrl = providerConfig?.baseUrl?.trim();
	const isFallbackActivation = options.fallback === "lmstudio" && options.provider !== "lmstudio";
	const remoteBaseUrl = options.remote?.baseUrl?.trim();
	const remoteApiKey = !isFallbackActivation ? resolveMemorySecretInputString({
		value: options.remote?.apiKey,
		path: "agents.*.memorySearch.remote.apiKey"
	}) : void 0;
	const baseUrlSource = !isFallbackActivation ? remoteBaseUrl : void 0;
	const baseUrl = resolveLmstudioInferenceBase(baseUrlSource && baseUrlSource.length > 0 ? baseUrlSource : providerBaseUrl && providerBaseUrl.length > 0 ? providerBaseUrl : void 0);
	const model = normalizeLmstudioModel(options.model);
	const providerHeaders = await resolveLmstudioProviderHeaders({
		config: options.config,
		env: process.env,
		headers: Object.assign({}, providerConfig?.headers, !isFallbackActivation ? options.remote?.headers : {})
	});
	const apiKey = hasAuthorizationHeader(providerHeaders) ? void 0 : !isFallbackActivation ? remoteApiKey?.trim() || await resolveLmstudioApiKey(options) : await resolveLmstudioApiKey(options);
	const headerOverrides = Object.assign({}, providerHeaders);
	const headers = buildLmstudioAuthHeaders({
		apiKey,
		json: true,
		headers: headerOverrides
	}) ?? {};
	const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
	const client = {
		baseUrl,
		model,
		headers,
		ssrfPolicy
	};
	try {
		await ensureLmstudioModelLoaded({
			baseUrl,
			apiKey,
			headers: headerOverrides,
			ssrfPolicy,
			modelKey: model,
			timeoutMs: 12e4
		});
	} catch (error) {
		log.warn("lmstudio embeddings warmup failed; continuing without preload", {
			baseUrl,
			model,
			error: formatErrorMessage(error)
		});
	}
	return {
		provider: createRemoteEmbeddingProvider({
			id: LMSTUDIO_PROVIDER_ID,
			client,
			errorPrefix: "lmstudio embeddings failed"
		}),
		client
	};
}
//#endregion
//#region extensions/lmstudio/memory-embedding-adapter.ts
const lmstudioMemoryEmbeddingProviderAdapter = {
	id: "lmstudio",
	defaultModel: DEFAULT_LMSTUDIO_EMBEDDING_MODEL,
	transport: "remote",
	authProviderId: "lmstudio",
	allowExplicitWhenConfiguredAuto: true,
	create: async (options) => {
		const { provider, client } = await createLmstudioEmbeddingProvider({
			...options,
			provider: "lmstudio",
			fallback: "none"
		});
		return {
			provider,
			runtime: {
				id: "lmstudio",
				inlineBatchTimeoutMs: 10 * 6e4,
				cacheKeyData: {
					provider: "lmstudio",
					baseUrl: client.baseUrl,
					model: client.model,
					headers: sanitizeEmbeddingCacheHeaders(client.headers, ["authorization"])
				}
			}
		};
	}
};
//#endregion
export { lmstudioMemoryEmbeddingProviderAdapter as t };
