import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-Bje8XVt9.js";
import "./text-runtime-C_zPTqpT.js";
import { D as sanitizeAndNormalizeEmbedding, o as debugEmbeddingsLog } from "./memory-core-host-engine-embeddings-CZoxGSzk.js";
//#region extensions/amazon-bedrock/embedding-provider.ts
const DEFAULT_BEDROCK_EMBEDDING_MODEL = "amazon.titan-embed-text-v2:0";
const MODELS = {
	"amazon.titan-embed-text-v2:0": {
		maxTokens: 8192,
		dims: 1024,
		validDims: [
			256,
			512,
			1024
		],
		family: "titan-v2"
	},
	"amazon.titan-embed-text-v1": {
		maxTokens: 8e3,
		dims: 1536,
		family: "titan-v1"
	},
	"amazon.titan-embed-g1-text-02": {
		maxTokens: 8e3,
		dims: 1536,
		family: "titan-v1"
	},
	"amazon.titan-embed-image-v1": {
		maxTokens: 128,
		dims: 1024,
		family: "titan-v1"
	},
	"cohere.embed-english-v3": {
		maxTokens: 512,
		dims: 1024,
		family: "cohere-v3"
	},
	"cohere.embed-multilingual-v3": {
		maxTokens: 512,
		dims: 1024,
		family: "cohere-v3"
	},
	"cohere.embed-v4:0": {
		maxTokens: 128e3,
		dims: 1536,
		validDims: [
			256,
			384,
			512,
			768,
			1024,
			1536
		],
		family: "cohere-v4"
	},
	"amazon.nova-2-multimodal-embeddings-v1:0": {
		maxTokens: 8192,
		dims: 1024,
		validDims: [
			256,
			384,
			1024,
			3072
		],
		family: "nova"
	},
	"twelvelabs.marengo-embed-2-7-v1:0": {
		maxTokens: 512,
		dims: 1024,
		family: "twelvelabs"
	},
	"twelvelabs.marengo-embed-3-0-v1:0": {
		maxTokens: 512,
		dims: 512,
		family: "twelvelabs"
	}
};
/** Resolve spec, stripping throughput suffixes like `:2:8k` or `:0:512`. */
function resolveSpec(modelId) {
	if (MODELS[modelId]) return MODELS[modelId];
	const parts = modelId.split(":");
	for (let i = parts.length - 1; i >= 1; i--) {
		const spec = MODELS[parts.slice(0, i).join(":")];
		if (spec) return spec;
	}
}
/** Infer family from model ID prefix when not in catalog. */
function inferFamily(modelId) {
	const id = normalizeLowercaseStringOrEmpty(modelId);
	if (id.startsWith("amazon.titan-embed-text-v2")) return "titan-v2";
	if (id.startsWith("amazon.titan-embed")) return "titan-v1";
	if (id.startsWith("amazon.nova")) return "nova";
	if (id.startsWith("cohere.embed-v4")) return "cohere-v4";
	if (id.startsWith("cohere.embed")) return "cohere-v3";
	if (id.startsWith("twelvelabs.")) return "twelvelabs";
	return "titan-v1";
}
let sdkCache = null;
let credentialProviderSdkCache;
async function loadSdk() {
	if (sdkCache) return sdkCache;
	try {
		sdkCache = await import("@aws-sdk/client-bedrock-runtime");
		return sdkCache;
	} catch {
		throw new Error("No API key found for provider bedrock: @aws-sdk/client-bedrock-runtime is not installed. Install it with: npm install @aws-sdk/client-bedrock-runtime");
	}
}
async function loadCredentialProviderSdk() {
	if (credentialProviderSdkCache !== void 0) return credentialProviderSdkCache;
	try {
		credentialProviderSdkCache = await import("@aws-sdk/credential-provider-node");
	} catch {
		credentialProviderSdkCache = null;
	}
	return credentialProviderSdkCache;
}
const MODEL_PREFIX_RE = /^(?:bedrock|amazon-bedrock|aws)\//;
const REGION_RE = /bedrock-runtime\.([a-z0-9-]+)\./;
function normalizeBedrockEmbeddingModel(model) {
	const trimmed = model.trim();
	return trimmed ? trimmed.replace(MODEL_PREFIX_RE, "") : DEFAULT_BEDROCK_EMBEDDING_MODEL;
}
function regionFromUrl(url) {
	return url?.trim() ? REGION_RE.exec(url)?.[1] : void 0;
}
function buildBody(family, text, dims) {
	switch (family) {
		case "titan-v2": {
			const b = { inputText: text };
			if (dims != null) {
				b.dimensions = dims;
				b.normalize = true;
			}
			return JSON.stringify(b);
		}
		case "titan-v1": return JSON.stringify({ inputText: text });
		case "nova": return JSON.stringify({
			taskType: "SINGLE_EMBEDDING",
			singleEmbeddingParams: {
				embeddingPurpose: "GENERIC_INDEX",
				embeddingDimension: dims ?? 1024,
				text: {
					truncationMode: "END",
					value: text
				}
			}
		});
		case "twelvelabs": return JSON.stringify({
			inputType: "text",
			text: { inputText: text }
		});
		default: return JSON.stringify({ inputText: text });
	}
}
function buildCohereBody(family, texts, inputType, dims) {
	const body = {
		texts,
		input_type: inputType,
		truncate: "END"
	};
	if (family === "cohere-v4") {
		body.embedding_types = ["float"];
		if (dims != null) body.output_dimension = dims;
	}
	return JSON.stringify(body);
}
function parseSingle(family, raw) {
	const data = JSON.parse(raw);
	switch (family) {
		case "nova": return data.embeddings?.[0]?.embedding ?? [];
		case "twelvelabs":
			if (Array.isArray(data.data)) return data.data[0]?.embedding ?? [];
			if (Array.isArray(data.data?.embedding)) return data.data.embedding;
			return data.embedding ?? [];
		default: return data.embedding ?? [];
	}
}
function parseCohereBatch(family, raw) {
	const embeddings = JSON.parse(raw).embeddings;
	if (!embeddings) return [];
	if (family === "cohere-v4" && !Array.isArray(embeddings)) return embeddings.float ?? [];
	return embeddings;
}
async function createBedrockEmbeddingProvider(options) {
	const client = resolveBedrockEmbeddingClient(options);
	const { BedrockRuntimeClient, InvokeModelCommand } = await loadSdk();
	const sdk = new BedrockRuntimeClient({ region: client.region });
	const spec = resolveSpec(client.model);
	const family = spec?.family ?? inferFamily(client.model);
	debugEmbeddingsLog("memory embeddings: bedrock client", {
		region: client.region,
		model: client.model,
		dimensions: client.dimensions,
		family
	});
	const invoke = async (body) => {
		const res = await sdk.send(new InvokeModelCommand({
			modelId: client.model,
			body,
			contentType: "application/json",
			accept: "application/json"
		}));
		return new TextDecoder().decode(res.body);
	};
	const isCohere = family === "cohere-v3" || family === "cohere-v4";
	const embedSingle = async (text) => {
		return sanitizeAndNormalizeEmbedding(parseSingle(family, await invoke(buildBody(family, text, client.dimensions))));
	};
	const embedCohere = async (texts, inputType) => {
		return parseCohereBatch(family, await invoke(buildCohereBody(family, texts, inputType, client.dimensions))).map((e) => sanitizeAndNormalizeEmbedding(e));
	};
	const embedQuery = async (text) => {
		if (!text.trim()) return [];
		if (isCohere) return (await embedCohere([text], "search_query"))[0] ?? [];
		return embedSingle(text);
	};
	const embedBatch = async (texts) => {
		if (texts.length === 0) return [];
		if (isCohere) return embedCohere(texts, "search_document");
		return Promise.all(texts.map((t) => t.trim() ? embedSingle(t) : Promise.resolve([])));
	};
	return {
		provider: {
			id: "bedrock",
			model: client.model,
			maxInputTokens: spec?.maxTokens,
			embedQuery,
			embedBatch
		},
		client
	};
}
function resolveBedrockEmbeddingClient(options) {
	const model = normalizeBedrockEmbeddingModel(options.model);
	const spec = resolveSpec(model);
	const providerConfig = options.config.models?.providers?.["amazon-bedrock"];
	const region = regionFromUrl(options.remote?.baseUrl) ?? regionFromUrl(providerConfig?.baseUrl) ?? process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? "us-east-1";
	let dimensions;
	if (options.outputDimensionality != null) {
		if (spec?.validDims && !spec.validDims.includes(options.outputDimensionality)) throw new Error(`Invalid dimensions ${options.outputDimensionality} for ${model}. Valid values: ${spec.validDims.join(", ")}`);
		dimensions = options.outputDimensionality;
	} else dimensions = spec?.dims;
	return {
		region,
		model,
		dimensions
	};
}
async function hasAwsCredentials(env = process.env, loadCredentialProvider = loadCredentialProviderSdk) {
	if (env.AWS_ACCESS_KEY_ID?.trim() && env.AWS_SECRET_ACCESS_KEY?.trim()) return true;
	if (env.AWS_BEARER_TOKEN_BEDROCK?.trim()) return true;
	const credentialProviderSdk = await loadCredentialProvider();
	if (!credentialProviderSdk) return false;
	try {
		const credentials = await credentialProviderSdk.defaultProvider({
			timeout: 1e3,
			maxRetries: 0
		})();
		return typeof credentials.accessKeyId === "string" && credentials.accessKeyId.trim().length > 0;
	} catch {
		return false;
	}
}
//#endregion
export { createBedrockEmbeddingProvider as n, hasAwsCredentials as r, DEFAULT_BEDROCK_EMBEDDING_MODEL as t };
