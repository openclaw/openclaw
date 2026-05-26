import { c as normalizeOptionalString } from "./string-coerce-LndEvhRk.js";
import { t as requireApiKey } from "./model-auth-runtime-shared-wzqc0OTs.js";
import { a as createProviderHttpError } from "./provider-http-errors-B_ZYSMaC.js";
import { n as executeWithApiKeyRotation, t as collectProviderApiKeysForExecution } from "./api-key-rotation-CgNvbhLt.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import { a as resolveApiKeyForProvider } from "./provider-auth-runtime-CNBotkGP.js";
import "./provider-http-BWEeBX6j.js";
import { C as withRemoteHttpResponse, D as sanitizeAndNormalizeEmbedding, S as buildRemoteBaseUrlPolicy, o as debugEmbeddingsLog } from "./memory-core-host-engine-embeddings-B41PUaLw.js";
import { n as resolveMemorySecretInputString } from "./secret-input-B_Bq_Rsm.js";
//#region extensions/google/embedding-provider.ts
const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const DEFAULT_GOOGLE_API_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_MAX_INPUT_TOKENS = {
	"text-embedding-004": 2048,
	"gemini-embedding-001": 2048,
	"gemini-embedding-2-preview": 8192
};
function parseGeminiAuth(apiKey) {
	if (apiKey.startsWith("{")) try {
		const parsed = JSON.parse(apiKey);
		if (typeof parsed.token === "string" && parsed.token) return { headers: {
			Authorization: `Bearer ${parsed.token}`,
			"Content-Type": "application/json"
		} };
	} catch {}
	return { headers: {
		"x-goog-api-key": apiKey,
		"Content-Type": "application/json"
	} };
}
const GEMINI_EMBEDDING_2_MODELS = new Set(["gemini-embedding-2-preview"]);
const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
const GEMINI_EMBEDDING_2_VALID_DIMENSIONS = [
	768,
	1536,
	3072
];
/** Builds the text-only Gemini embedding request shape used across direct and batch APIs. */
function buildGeminiTextEmbeddingRequest(params) {
	return buildGeminiEmbeddingRequest({
		input: { text: params.text },
		taskType: params.taskType,
		outputDimensionality: params.outputDimensionality,
		modelPath: params.modelPath
	});
}
function buildGeminiEmbeddingRequest(params) {
	const request = {
		content: { parts: params.input.parts?.map((part) => part.type === "text" ? { text: part.text } : { inlineData: {
			mimeType: part.mimeType,
			data: part.data
		} }) ?? [{ text: params.input.text }] },
		taskType: params.taskType
	};
	if (params.modelPath) request.model = params.modelPath;
	if (params.outputDimensionality != null) request.outputDimensionality = params.outputDimensionality;
	return request;
}
/**
* Returns true if the given model name is a gemini-embedding-2 variant that
* supports `outputDimensionality` and extended task types.
*/
function isGeminiEmbedding2Model(model) {
	return GEMINI_EMBEDDING_2_MODELS.has(model);
}
/**
* Validate and return the `outputDimensionality` for gemini-embedding-2 models.
* Returns `undefined` for older models (they don't support the param).
*/
function resolveGeminiOutputDimensionality(model, requested) {
	if (!isGeminiEmbedding2Model(model)) return;
	if (requested == null) return GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS;
	const valid = GEMINI_EMBEDDING_2_VALID_DIMENSIONS;
	if (!valid.includes(requested)) throw new Error(`Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`);
	return requested;
}
function resolveRemoteApiKey(remoteApiKey) {
	const trimmed = resolveMemorySecretInputString({
		value: remoteApiKey,
		path: "agents.*.memorySearch.remote.apiKey"
	});
	if (!trimmed) return;
	if (trimmed === "GOOGLE_API_KEY" || trimmed === "GEMINI_API_KEY") return process.env[trimmed]?.trim();
	return trimmed;
}
function normalizeGeminiModel(model) {
	const trimmed = model.trim();
	if (!trimmed) return DEFAULT_GEMINI_EMBEDDING_MODEL;
	const withoutPrefix = trimmed.replace(/^models\//, "");
	if (withoutPrefix.startsWith("gemini/")) return withoutPrefix.slice(7);
	if (withoutPrefix.startsWith("google/")) return withoutPrefix.slice(7);
	return withoutPrefix;
}
async function fetchGeminiEmbeddingPayload(params) {
	return await executeWithApiKeyRotation({
		provider: "google",
		apiKeys: params.client.apiKeys,
		execute: async (apiKey) => {
			const headers = {
				...parseGeminiAuth(apiKey).headers,
				...params.client.headers
			};
			return await withRemoteHttpResponse({
				url: params.endpoint,
				ssrfPolicy: params.client.ssrfPolicy,
				init: {
					method: "POST",
					headers,
					body: JSON.stringify(params.body)
				},
				onResponse: async (res) => {
					if (!res.ok) throw await createProviderHttpError(res, "gemini embeddings failed");
					return await res.json();
				}
			});
		}
	});
}
function normalizeGeminiBaseUrl(raw) {
	const trimmed = raw.replace(/\/+$/, "");
	const openAiIndex = trimmed.indexOf("/openai");
	if (openAiIndex > -1) return normalizeGoogleApiBaseUrl(trimmed.slice(0, openAiIndex));
	return normalizeGoogleApiBaseUrl(trimmed);
}
function buildGeminiModelPath(model) {
	return model.startsWith("models/") ? model : `models/${model}`;
}
function normalizeGoogleApiBaseUrl(baseUrl) {
	const trimmed = baseUrl.trim().replace(/\/+$/, "");
	if (!trimmed) return DEFAULT_GOOGLE_API_BASE_URL;
	try {
		const url = new URL(trimmed);
		url.hash = "";
		url.search = "";
		if (url.origin.toLowerCase() === "https://generativelanguage.googleapis.com" && url.pathname.replace(/\/+$/, "") === "") url.pathname = "/v1beta";
		return url.toString().replace(/\/+$/, "");
	} catch {
		return trimmed;
	}
}
async function createGeminiEmbeddingProvider(options) {
	const client = await resolveGeminiEmbeddingClient(options);
	const baseUrl = client.baseUrl.replace(/\/$/, "");
	const embedUrl = `${baseUrl}/${client.modelPath}:embedContent`;
	const batchUrl = `${baseUrl}/${client.modelPath}:batchEmbedContents`;
	const isV2 = isGeminiEmbedding2Model(client.model);
	const outputDimensionality = client.outputDimensionality;
	const embedQuery = async (text) => {
		if (!text.trim()) return [];
		return sanitizeAndNormalizeEmbedding((await fetchGeminiEmbeddingPayload({
			client,
			endpoint: embedUrl,
			body: buildGeminiTextEmbeddingRequest({
				text,
				taskType: options.taskType ?? "RETRIEVAL_QUERY",
				outputDimensionality: isV2 ? outputDimensionality : void 0
			})
		})).embedding?.values ?? []);
	};
	const embedBatchInputs = async (inputs) => {
		if (inputs.length === 0) return [];
		const payload = await fetchGeminiEmbeddingPayload({
			client,
			endpoint: batchUrl,
			body: { requests: inputs.map((input) => buildGeminiEmbeddingRequest({
				input,
				modelPath: client.modelPath,
				taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
				outputDimensionality: isV2 ? outputDimensionality : void 0
			})) }
		});
		const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
		return inputs.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
	};
	const embedBatch = async (texts) => {
		return await embedBatchInputs(texts.map((text) => ({ text })));
	};
	return {
		provider: {
			id: "gemini",
			model: client.model,
			maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
			embedQuery,
			embedBatch,
			embedBatchInputs
		},
		client
	};
}
async function resolveGeminiEmbeddingClient(options) {
	const remote = options.remote;
	const remoteApiKey = resolveRemoteApiKey(remote?.apiKey);
	const remoteBaseUrl = remote?.baseUrl?.trim();
	const apiKey = remoteApiKey ? remoteApiKey : requireApiKey(await resolveApiKeyForProvider({
		provider: "google",
		cfg: options.config,
		agentDir: options.agentDir
	}), "google");
	const providerConfig = options.config.models?.providers?.google;
	const rawBaseUrl = remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl) || DEFAULT_GOOGLE_API_BASE_URL;
	const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
	const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
	const headers = { ...Object.assign({}, providerConfig?.headers, remote?.headers) };
	const apiKeys = collectProviderApiKeysForExecution({
		provider: "google",
		primaryApiKey: apiKey
	});
	const model = normalizeGeminiModel(options.model);
	const modelPath = buildGeminiModelPath(model);
	const outputDimensionality = resolveGeminiOutputDimensionality(model, options.outputDimensionality);
	debugEmbeddingsLog("memory embeddings: gemini client", {
		rawBaseUrl,
		baseUrl,
		model,
		modelPath,
		outputDimensionality,
		embedEndpoint: `${baseUrl}/${modelPath}:embedContent`,
		batchEndpoint: `${baseUrl}/${modelPath}:batchEmbedContents`
	});
	return {
		baseUrl,
		headers,
		ssrfPolicy,
		model,
		modelPath,
		apiKeys,
		outputDimensionality
	};
}
//#endregion
export { createGeminiEmbeddingProvider as a, resolveGeminiOutputDimensionality as c, buildGeminiTextEmbeddingRequest as i, GEMINI_EMBEDDING_2_MODELS as n, isGeminiEmbedding2Model as o, buildGeminiEmbeddingRequest as r, normalizeGeminiModel as s, DEFAULT_GEMINI_EMBEDDING_MODEL as t };
