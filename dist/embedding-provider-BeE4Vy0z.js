import { i as formatErrorMessage } from "./errors-VfATXfah.js";
import { s as hasConfiguredSecretInput, u as normalizeResolvedSecretInputString } from "./types.secrets-BxqheYvy.js";
import { r as normalizeProviderId } from "./provider-id-Cz7K6wgK.js";
import { l as isKnownEnvApiKeyMarker, u as isNonSecretApiKeyMarker } from "./model-auth-markers-UDEQVW7W.js";
import { t as normalizeOptionalSecretInput } from "./normalize-secret-input-CrCOUFln.js";
import { t as resolveEnvApiKey } from "./model-auth-env-CblHr3q1.js";
import { _ as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-CYoLqc2K.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-B7xT8hT9.js";
import "./provider-model-shared-D-slKnZa.js";
import "./provider-auth-D5QGE8z6.js";
import "./secret-input-DlbCRffO.js";
import "./ssrf-runtime-B7YsbRmp.js";
import "./provider-auth-runtime-CNBotkGP.js";
import { t as OLLAMA_CLOUD_BASE_URL } from "./defaults-B7Swclqd.js";
import { t as readProviderBaseUrl, u as resolveOllamaApiBase } from "./provider-base-url-BorJpQi-.js";
import { g as normalizeOllamaWireModelId } from "./stream-rxdgQFVo.js";
//#region extensions/ollama/src/embedding-provider.ts
const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const QUERY_INSTRUCTION_TEMPLATES = [
	{
		prefix: "qwen3-embedding",
		template: "Instruct: Given a user query, retrieve relevant memory notes and documents\nQuery:{query}"
	},
	{
		prefix: "nomic-embed-text",
		template: "search_query: {query}"
	},
	{
		prefix: "mxbai-embed-large",
		template: "Represent this sentence for searching relevant passages: {query}"
	}
];
function sanitizeAndNormalizeEmbedding(vec) {
	const sanitized = vec.map((value) => Number.isFinite(value) ? value : 0);
	const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
	if (magnitude < 1e-10) return sanitized;
	return sanitized.map((value) => value / magnitude);
}
async function withRemoteHttpResponse(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		init: params.init,
		policy: params.ssrfPolicy,
		auditContext: "memory-remote"
	});
	try {
		return await params.onResponse(response);
	} finally {
		await release();
	}
}
function normalizeEmbeddingModel(model, providerId) {
	const trimmed = model.trim();
	if (!trimmed) return DEFAULT_OLLAMA_EMBEDDING_MODEL;
	return normalizeOllamaWireModelId(trimmed, providerId);
}
function applyQueryInstructionTemplate(model, queryText) {
	const normalizedModel = model.trim().toLowerCase();
	const match = QUERY_INSTRUCTION_TEMPLATES.find(({ prefix }) => normalizedModel.startsWith(prefix));
	return match ? match.template.replace("{query}", () => queryText) : queryText;
}
function resolveConfiguredProvider(options) {
	const providers = options.config.models?.providers;
	if (!providers) return;
	const providerId = options.provider?.trim() || "ollama";
	const direct = providers[providerId];
	if (direct) return direct;
	const normalized = normalizeProviderId(providerId);
	for (const [candidateId, candidate] of Object.entries(providers)) if (normalizeProviderId(candidateId) === normalized) return candidate;
	return providers.ollama;
}
function resolveMemorySecretInputString(params) {
	if (!hasConfiguredSecretInput(params.value)) return;
	return normalizeResolvedSecretInputString({
		value: params.value,
		path: params.path
	});
}
function resolveSourcedOllamaEmbeddingKey(params) {
	if (params.configString !== void 0) {
		if (!isNonSecretApiKeyMarker(params.configString)) return { apiKey: params.configString };
		if (!isKnownEnvApiKeyMarker(params.configString)) return "opt-out";
		const envKey = resolveEnvApiKey("ollama")?.apiKey;
		return envKey && !isNonSecretApiKeyMarker(envKey) ? { apiKey: envKey } : "opt-out";
	}
	if (params.declared) {
		const envKey = resolveEnvApiKey("ollama")?.apiKey;
		return envKey && !isNonSecretApiKeyMarker(envKey) ? { apiKey: envKey } : "opt-out";
	}
	return "unset";
}
function resolveOllamaEmbeddingResolvedKeys(options, providerConfig) {
	const remoteValue = options.remote?.apiKey;
	const remote = resolveSourcedOllamaEmbeddingKey({
		configString: resolveMemorySecretInputString({
			value: remoteValue,
			path: "agents.*.memorySearch.remote.apiKey"
		}),
		declared: hasConfiguredSecretInput(remoteValue)
	});
	const providerValue = providerConfig?.apiKey;
	const provider = resolveSourcedOllamaEmbeddingKey({
		configString: normalizeOptionalSecretInput(providerValue),
		declared: hasConfiguredSecretInput(providerValue)
	});
	const envKey = resolveEnvApiKey("ollama")?.apiKey;
	return {
		remote,
		provider,
		env: envKey && !isNonSecretApiKeyMarker(envKey) ? envKey : void 0
	};
}
function resolveOllamaEmbeddingBaseUrl(params) {
	const remoteBaseUrl = params.remoteBaseUrl?.trim();
	if (remoteBaseUrl) return {
		baseUrl: resolveOllamaApiBase(remoteBaseUrl),
		origin: "remote-config"
	};
	const providerBaseUrl = readProviderBaseUrl(params.providerConfig);
	if (providerBaseUrl) return {
		baseUrl: resolveOllamaApiBase(providerBaseUrl),
		origin: "provider-config"
	};
	return {
		baseUrl: resolveOllamaApiBase(void 0),
		origin: "default"
	};
}
function normalizeOllamaHostKey(baseUrl) {
	try {
		const parsed = new URL(baseUrl);
		let hostname = parsed.hostname.toLowerCase();
		if (hostname === "localhost" || hostname === "::1" || hostname === "[::1]") hostname = "127.0.0.1";
		const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
		const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
		return `${parsed.protocol}//${hostname}:${port}${path}`;
	} catch {
		return;
	}
}
function areOllamaHostsEquivalent(a, b) {
	const aKey = normalizeOllamaHostKey(a);
	const bKey = normalizeOllamaHostKey(b);
	return aKey !== void 0 && bKey !== void 0 && aKey === bKey;
}
function isOllamaCloudBaseUrl(baseUrl) {
	return areOllamaHostsEquivalent(baseUrl, OLLAMA_CLOUD_BASE_URL);
}
function selectOllamaEmbeddingApiKey(params) {
	if (params.resolved.remote !== "unset") return typeof params.resolved.remote === "object" ? params.resolved.remote.apiKey : void 0;
	const reachesProviderHost = params.baseUrlOrigin === "provider-config" || params.baseUrlOrigin === "default" || areOllamaHostsEquivalent(params.baseUrl, params.providerOwnedHost);
	if (params.resolved.provider !== "unset" && reachesProviderHost) return typeof params.resolved.provider === "object" ? params.resolved.provider.apiKey : void 0;
	if (params.resolved.env && isOllamaCloudBaseUrl(params.baseUrl)) return params.resolved.env;
}
function resolveOllamaEmbeddingClient(options) {
	const providerConfig = resolveConfiguredProvider(options);
	const { baseUrl, origin: baseUrlOrigin } = resolveOllamaEmbeddingBaseUrl({
		remoteBaseUrl: options.remote?.baseUrl,
		providerConfig
	});
	const model = normalizeEmbeddingModel(options.model, options.provider);
	const headers = {
		"Content-Type": "application/json",
		...Object.assign({}, providerConfig?.headers, options.remote?.headers)
	};
	const apiKey = selectOllamaEmbeddingApiKey({
		resolved: resolveOllamaEmbeddingResolvedKeys(options, providerConfig),
		baseUrl,
		baseUrlOrigin,
		providerOwnedHost: resolveOllamaApiBase(readProviderBaseUrl(providerConfig))
	});
	if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
	return {
		baseUrl,
		headers,
		ssrfPolicy: ssrfPolicyFromHttpBaseUrlAllowedHostname(baseUrl),
		model
	};
}
async function createOllamaEmbeddingProvider(options) {
	const client = resolveOllamaEmbeddingClient(options);
	const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embed`;
	const embedMany = async (input) => {
		const json = await withRemoteHttpResponse({
			url: embedUrl,
			ssrfPolicy: client.ssrfPolicy,
			init: {
				method: "POST",
				headers: client.headers,
				body: JSON.stringify({
					model: client.model,
					input
				})
			},
			onResponse: async (response) => {
				if (!response.ok) throw new Error(`Ollama embed HTTP ${response.status}: ${await response.text()}`);
				return await response.json();
			}
		});
		if (!Array.isArray(json.embeddings)) throw new Error("Ollama embed response missing embeddings[]");
		const expectedCount = Array.isArray(input) ? input.length : 1;
		if (json.embeddings.length !== expectedCount) throw new Error(`Ollama embed response returned ${json.embeddings.length} embeddings for ${expectedCount} inputs`);
		return json.embeddings.map((embedding) => {
			if (!Array.isArray(embedding)) throw new Error("Ollama embed response contains a non-array embedding");
			return sanitizeAndNormalizeEmbedding(embedding);
		});
	};
	const embedOne = async (text) => {
		const [embedding] = await embedMany(text);
		if (!embedding) throw new Error("Ollama embed response returned no embedding");
		return embedding;
	};
	const embedQuery = async (text) => await embedOne(applyQueryInstructionTemplate(client.model, text));
	const provider = {
		id: "ollama",
		model: client.model,
		embedQuery,
		embedBatch: async (texts) => texts.length === 0 ? [] : await embedMany(texts)
	};
	return {
		provider,
		client: {
			...client,
			embedBatch: async (texts) => {
				try {
					return await provider.embedBatch(texts);
				} catch (err) {
					throw new Error(formatErrorMessage(err), { cause: err });
				}
			}
		}
	};
}
//#endregion
export { createOllamaEmbeddingProvider as n, DEFAULT_OLLAMA_EMBEDDING_MODEL as t };
