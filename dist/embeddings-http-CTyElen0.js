import { a as normalizeLowercaseStringOrEmpty, c as normalizeOptionalString } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import "./agent-scope-CtLXGcWm.js";
import { a as resolveAgentDir } from "./agent-scope-config-CMp71_27.js";
import { a as logWarn } from "./logger-0o2znY2U.js";
import { i as getRuntimeConfig } from "./io-DoswVvYe.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BEQRq9yG.js";
import { n as listMemoryEmbeddingProviders, t as getMemoryEmbeddingProvider } from "./memory-embedding-provider-runtime-xg7fdvKI.js";
import { a as sendJson } from "./http-common-D6Lgf8u5.js";
import { a as getHeader, l as resolveOpenAiCompatibleHttpOperatorScopes } from "./http-auth-utils-Bn7sdLLK.js";
import { i as resolveAgentIdFromModel, r as resolveAgentIdForRequest } from "./http-utils-GEkok2ix.js";
import { t as handleGatewayPostJsonEndpoint } from "./http-endpoint-helpers-B1Tw6PpU.js";
import { Buffer } from "node:buffer";
//#region src/gateway/embeddings-http.ts
const DEFAULT_EMBEDDINGS_BODY_BYTES = 5 * 1024 * 1024;
const MAX_EMBEDDING_INPUTS = 128;
const MAX_EMBEDDING_INPUT_CHARS = 8192;
const MAX_EMBEDDING_TOTAL_CHARS = 65536;
function coerceRequest(value) {
	return value && typeof value === "object" ? value : {};
}
function resolveInputTexts(input) {
	if (typeof input === "string") return [input];
	if (!Array.isArray(input)) return null;
	if (input.every((entry) => typeof entry === "string")) return input;
	return null;
}
function encodeEmbeddingBase64(embedding) {
	const float32 = Float32Array.from(embedding);
	return Buffer.from(float32.buffer).toString("base64");
}
function validateInputTexts(texts) {
	if (texts.length > MAX_EMBEDDING_INPUTS) return `Too many inputs (max ${MAX_EMBEDDING_INPUTS}).`;
	let totalChars = 0;
	for (const text of texts) {
		if (text.length > MAX_EMBEDDING_INPUT_CHARS) return `Input too long (max ${MAX_EMBEDDING_INPUT_CHARS} chars).`;
		totalChars += text.length;
		if (totalChars > MAX_EMBEDDING_TOTAL_CHARS) return `Total input too large (max ${MAX_EMBEDDING_TOTAL_CHARS} chars).`;
	}
}
function resolveAutoExplicitProviders(cfg) {
	return new Set(listMemoryEmbeddingProviders(cfg).filter((adapter) => adapter.allowExplicitWhenConfiguredAuto).map((adapter) => adapter.id));
}
function shouldContinueAutoSelection(adapter, err) {
	return adapter.shouldContinueAutoSelection?.(err) ?? false;
}
async function createConfiguredEmbeddingProvider(params) {
	const createWithAdapter = async (adapter) => {
		return (await adapter.create({
			config: params.cfg,
			agentDir: params.agentDir,
			model: params.model || adapter.defaultModel || "",
			local: params.memorySearch?.local,
			remote: params.memorySearch?.remote ? {
				baseUrl: params.memorySearch?.remote.baseUrl,
				apiKey: params.memorySearch?.remote.apiKey,
				headers: params.memorySearch?.remote.headers
			} : void 0,
			outputDimensionality: params.memorySearch?.outputDimensionality
		})).provider;
	};
	if (params.provider === "auto") {
		const adapters = listMemoryEmbeddingProviders(params.cfg).filter((adapter) => typeof adapter.autoSelectPriority === "number").toSorted((a, b) => (a.autoSelectPriority ?? Number.MAX_SAFE_INTEGER) - (b.autoSelectPriority ?? Number.MAX_SAFE_INTEGER));
		for (const adapter of adapters) try {
			const provider = await createWithAdapter(adapter);
			if (provider) return provider;
		} catch (err) {
			if (shouldContinueAutoSelection(adapter, err)) continue;
			throw err;
		}
		throw new Error("No embeddings provider available.");
	}
	const adapter = getMemoryEmbeddingProvider(params.provider, params.cfg);
	if (!adapter) throw new Error(`Unknown memory embedding provider: ${params.provider}`);
	const provider = await createWithAdapter(adapter);
	if (!provider) throw new Error(`Memory embedding provider ${params.provider} is unavailable.`);
	return provider;
}
function resolveEmbeddingsTarget(params) {
	const raw = params.requestModel.trim();
	const slash = raw.indexOf("/");
	if (slash === -1) return {
		provider: params.configuredProvider,
		model: raw
	};
	const provider = normalizeLowercaseStringOrEmpty(raw.slice(0, slash));
	const model = raw.slice(slash + 1).trim();
	if (!model) return { errorMessage: "Unsupported embedding model reference." };
	if (params.configuredProvider === "auto") {
		const safeAutoExplicitProviders = resolveAutoExplicitProviders(params.cfg);
		if (provider === "auto") return {
			provider: "auto",
			model
		};
		if (safeAutoExplicitProviders.has(provider)) return {
			provider,
			model
		};
		return { errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`." };
	}
	if (provider !== params.configuredProvider) return { errorMessage: "This agent does not allow that embedding provider on `/v1/embeddings`." };
	return {
		provider: params.configuredProvider,
		model
	};
}
async function handleOpenAiEmbeddingsHttpRequest(req, res, opts) {
	const handled = await handleGatewayPostJsonEndpoint(req, res, {
		pathname: "/v1/embeddings",
		requiredOperatorMethod: "chat.send",
		resolveOperatorScopes: resolveOpenAiCompatibleHttpOperatorScopes,
		auth: opts.auth,
		trustedProxies: opts.trustedProxies,
		allowRealIpFallback: opts.allowRealIpFallback,
		rateLimiter: opts.rateLimiter,
		maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_EMBEDDINGS_BODY_BYTES
	});
	if (handled === false) return false;
	if (!handled) return true;
	const payload = coerceRequest(handled.body);
	const requestModel = normalizeOptionalString(payload.model) ?? "";
	if (!requestModel) {
		sendJson(res, 400, { error: {
			message: "Missing `model`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const cfg = getRuntimeConfig();
	if (requestModel !== "openclaw" && !resolveAgentIdFromModel(requestModel, cfg)) {
		sendJson(res, 400, { error: {
			message: "Invalid `model`. Use `openclaw` or `openclaw/<agentId>`.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const texts = resolveInputTexts(payload.input);
	if (!texts) {
		sendJson(res, 400, { error: {
			message: "`input` must be a string or an array of strings.",
			type: "invalid_request_error"
		} });
		return true;
	}
	const inputError = validateInputTexts(texts);
	if (inputError) {
		sendJson(res, 400, { error: {
			message: inputError,
			type: "invalid_request_error"
		} });
		return true;
	}
	const agentId = resolveAgentIdForRequest({
		req,
		model: requestModel
	});
	const agentDir = resolveAgentDir(cfg, agentId);
	const memorySearch = resolveMemorySearchConfig(cfg, agentId);
	const configuredProvider = memorySearch?.provider ?? "openai";
	const target = resolveEmbeddingsTarget({
		requestModel: normalizeOptionalString(getHeader(req, "x-openclaw-model")) || normalizeOptionalString(memorySearch?.model) || "",
		configuredProvider,
		cfg
	});
	if ("errorMessage" in target) {
		sendJson(res, 400, { error: {
			message: target.errorMessage,
			type: "invalid_request_error"
		} });
		return true;
	}
	try {
		const embeddings = await (await createConfiguredEmbeddingProvider({
			cfg,
			agentDir,
			provider: target.provider,
			model: target.model,
			memorySearch: memorySearch ? {
				...memorySearch,
				outputDimensionality: typeof payload.dimensions === "number" && payload.dimensions > 0 ? Math.floor(payload.dimensions) : memorySearch.outputDimensionality
			} : void 0
		})).embedBatch(texts);
		const encodingFormat = payload.encoding_format === "base64" ? "base64" : "float";
		sendJson(res, 200, {
			object: "list",
			data: embeddings.map((embedding, index) => ({
				object: "embedding",
				index,
				embedding: encodingFormat === "base64" ? encodeEmbeddingBase64(embedding) : embedding
			})),
			model: requestModel,
			usage: {
				prompt_tokens: 0,
				total_tokens: 0
			}
		});
	} catch (err) {
		logWarn(`openai-compat: embeddings request failed: ${formatErrorMessage(err)}`);
		sendJson(res, 500, { error: {
			message: "internal error",
			type: "api_error"
		} });
	}
	return true;
}
//#endregion
export { handleOpenAiEmbeddingsHttpRequest };
