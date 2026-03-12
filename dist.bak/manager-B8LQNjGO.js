import { t as __exportAll } from "./rolldown-runtime-Cbj13DAv.js";
import { i as resolveAgentDir, r as resolveAgentConfig, s as resolveAgentWorkspaceDir } from "./agent-scope-ET3-KDD1.js";
import { s as resolveStateDir } from "./paths-MYHBPf85.js";
import { D as clampInt, K as truncateUtf16Safe, O as clampNumber, t as createSubsystemLogger, z as resolveUserPath } from "./subsystem-CYLd4dcj.js";
import { E as resolveApiKeyForProvider, T as requireApiKey } from "./model-selection-DOYvU3hc.js";
import { t as isTruthyEnvValue } from "./env-DioSf1y0.js";
import { n as formatErrorMessage } from "./errors-kKzMhHcT.js";
import { c as resolveSessionTranscriptsDirForAgent } from "./paths-6XrpQmMB.js";
import { n as onSessionTranscriptUpdate } from "./transcript-events-BtNd-j6q.js";
import { n as collectProviderApiKeysForExecution, r as executeWithApiKeyRotation, t as parseGeminiAuth } from "./gemini-auth-BoOrasN3.js";
import { t as fetchWithSsrFGuard } from "./fetch-guard-2JREkJbB.js";
import { _ as isFileMissingError, a as sessionPathForFile, c as cosineSimilarity, d as isMemoryPath, f as listMemoryFiles, g as runWithConcurrency, h as remapChunkLines, i as listSessionFilesForAgent, l as ensureDir, m as parseEmbedding, n as requireNodeSqlite, o as buildFileEntry, p as normalizeExtraMemoryPaths, r as buildSessionEntry, s as chunkMarkdown, t as extractKeywords, u as hashText, v as statRegularFile } from "./query-expansion-DuzwZ9c2.js";
import { n as retryAsync } from "./retry-BL5RYsiN.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import syncFs from "node:fs";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import chokidar from "chokidar";

//#region src/agents/memory-search.ts
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_GEMINI_MODEL = "gemini-embedding-001";
const DEFAULT_VOYAGE_MODEL = "voyage-4-large";
const DEFAULT_MISTRAL_MODEL = "mistral-embed";
const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_WATCH_DEBOUNCE_MS = 1500;
const DEFAULT_SESSION_DELTA_BYTES = 1e5;
const DEFAULT_SESSION_DELTA_MESSAGES = 50;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = .35;
const DEFAULT_HYBRID_ENABLED = true;
const DEFAULT_HYBRID_VECTOR_WEIGHT = .7;
const DEFAULT_HYBRID_TEXT_WEIGHT = .3;
const DEFAULT_HYBRID_CANDIDATE_MULTIPLIER = 4;
const DEFAULT_MMR_ENABLED = false;
const DEFAULT_MMR_LAMBDA = .7;
const DEFAULT_TEMPORAL_DECAY_ENABLED = false;
const DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS = 30;
const DEFAULT_CACHE_ENABLED = true;
const DEFAULT_SOURCES = ["memory"];
function normalizeSources(sources, sessionMemoryEnabled) {
	const normalized = /* @__PURE__ */ new Set();
	const input = sources?.length ? sources : DEFAULT_SOURCES;
	for (const source of input) {
		if (source === "memory") normalized.add("memory");
		if (source === "sessions" && sessionMemoryEnabled) normalized.add("sessions");
	}
	if (normalized.size === 0) normalized.add("memory");
	return Array.from(normalized);
}
function resolveStorePath(agentId, raw) {
	const stateDir = resolveStateDir(process.env, os.homedir);
	const fallback = path.join(stateDir, "memory", `${agentId}.sqlite`);
	if (!raw) return fallback;
	return resolveUserPath(raw.includes("{agentId}") ? raw.replaceAll("{agentId}", agentId) : raw);
}
function mergeConfig(defaults, overrides, agentId) {
	const enabled = overrides?.enabled ?? defaults?.enabled ?? true;
	const sessionMemory = overrides?.experimental?.sessionMemory ?? defaults?.experimental?.sessionMemory ?? false;
	const provider = overrides?.provider ?? defaults?.provider ?? "auto";
	const defaultRemote = defaults?.remote;
	const overrideRemote = overrides?.remote;
	const includeRemote = Boolean(overrideRemote?.baseUrl || overrideRemote?.apiKey || overrideRemote?.headers || defaultRemote?.baseUrl || defaultRemote?.apiKey || defaultRemote?.headers) || provider === "openai" || provider === "gemini" || provider === "voyage" || provider === "mistral" || provider === "auto";
	const batch = {
		enabled: overrideRemote?.batch?.enabled ?? defaultRemote?.batch?.enabled ?? false,
		wait: overrideRemote?.batch?.wait ?? defaultRemote?.batch?.wait ?? true,
		concurrency: Math.max(1, overrideRemote?.batch?.concurrency ?? defaultRemote?.batch?.concurrency ?? 2),
		pollIntervalMs: overrideRemote?.batch?.pollIntervalMs ?? defaultRemote?.batch?.pollIntervalMs ?? 2e3,
		timeoutMinutes: overrideRemote?.batch?.timeoutMinutes ?? defaultRemote?.batch?.timeoutMinutes ?? 60
	};
	const remote = includeRemote ? {
		baseUrl: overrideRemote?.baseUrl ?? defaultRemote?.baseUrl,
		apiKey: overrideRemote?.apiKey ?? defaultRemote?.apiKey,
		headers: overrideRemote?.headers ?? defaultRemote?.headers,
		batch
	} : void 0;
	const fallback = overrides?.fallback ?? defaults?.fallback ?? "none";
	const modelDefault = provider === "gemini" ? DEFAULT_GEMINI_MODEL : provider === "openai" ? DEFAULT_OPENAI_MODEL : provider === "voyage" ? DEFAULT_VOYAGE_MODEL : provider === "mistral" ? DEFAULT_MISTRAL_MODEL : void 0;
	const model = overrides?.model ?? defaults?.model ?? modelDefault ?? "";
	const local = {
		modelPath: overrides?.local?.modelPath ?? defaults?.local?.modelPath,
		modelCacheDir: overrides?.local?.modelCacheDir ?? defaults?.local?.modelCacheDir
	};
	const sources = normalizeSources(overrides?.sources ?? defaults?.sources, sessionMemory);
	const rawPaths = [...defaults?.extraPaths ?? [], ...overrides?.extraPaths ?? []].map((value) => value.trim()).filter(Boolean);
	const extraPaths = Array.from(new Set(rawPaths));
	const vector = {
		enabled: overrides?.store?.vector?.enabled ?? defaults?.store?.vector?.enabled ?? true,
		extensionPath: overrides?.store?.vector?.extensionPath ?? defaults?.store?.vector?.extensionPath
	};
	const store = {
		driver: overrides?.store?.driver ?? defaults?.store?.driver ?? "sqlite",
		path: resolveStorePath(agentId, overrides?.store?.path ?? defaults?.store?.path),
		vector
	};
	const chunking = {
		tokens: overrides?.chunking?.tokens ?? defaults?.chunking?.tokens ?? DEFAULT_CHUNK_TOKENS,
		overlap: overrides?.chunking?.overlap ?? defaults?.chunking?.overlap ?? DEFAULT_CHUNK_OVERLAP
	};
	const sync = {
		onSessionStart: overrides?.sync?.onSessionStart ?? defaults?.sync?.onSessionStart ?? true,
		onSearch: overrides?.sync?.onSearch ?? defaults?.sync?.onSearch ?? true,
		watch: overrides?.sync?.watch ?? defaults?.sync?.watch ?? true,
		watchDebounceMs: overrides?.sync?.watchDebounceMs ?? defaults?.sync?.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS,
		intervalMinutes: overrides?.sync?.intervalMinutes ?? defaults?.sync?.intervalMinutes ?? 0,
		sessions: {
			deltaBytes: overrides?.sync?.sessions?.deltaBytes ?? defaults?.sync?.sessions?.deltaBytes ?? DEFAULT_SESSION_DELTA_BYTES,
			deltaMessages: overrides?.sync?.sessions?.deltaMessages ?? defaults?.sync?.sessions?.deltaMessages ?? DEFAULT_SESSION_DELTA_MESSAGES
		}
	};
	const query = {
		maxResults: overrides?.query?.maxResults ?? defaults?.query?.maxResults ?? DEFAULT_MAX_RESULTS,
		minScore: overrides?.query?.minScore ?? defaults?.query?.minScore ?? DEFAULT_MIN_SCORE
	};
	const hybrid = {
		enabled: overrides?.query?.hybrid?.enabled ?? defaults?.query?.hybrid?.enabled ?? DEFAULT_HYBRID_ENABLED,
		vectorWeight: overrides?.query?.hybrid?.vectorWeight ?? defaults?.query?.hybrid?.vectorWeight ?? DEFAULT_HYBRID_VECTOR_WEIGHT,
		textWeight: overrides?.query?.hybrid?.textWeight ?? defaults?.query?.hybrid?.textWeight ?? DEFAULT_HYBRID_TEXT_WEIGHT,
		candidateMultiplier: overrides?.query?.hybrid?.candidateMultiplier ?? defaults?.query?.hybrid?.candidateMultiplier ?? DEFAULT_HYBRID_CANDIDATE_MULTIPLIER,
		mmr: {
			enabled: overrides?.query?.hybrid?.mmr?.enabled ?? defaults?.query?.hybrid?.mmr?.enabled ?? DEFAULT_MMR_ENABLED,
			lambda: overrides?.query?.hybrid?.mmr?.lambda ?? defaults?.query?.hybrid?.mmr?.lambda ?? DEFAULT_MMR_LAMBDA
		},
		temporalDecay: {
			enabled: overrides?.query?.hybrid?.temporalDecay?.enabled ?? defaults?.query?.hybrid?.temporalDecay?.enabled ?? DEFAULT_TEMPORAL_DECAY_ENABLED,
			halfLifeDays: overrides?.query?.hybrid?.temporalDecay?.halfLifeDays ?? defaults?.query?.hybrid?.temporalDecay?.halfLifeDays ?? DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS
		}
	};
	const cache = {
		enabled: overrides?.cache?.enabled ?? defaults?.cache?.enabled ?? DEFAULT_CACHE_ENABLED,
		maxEntries: overrides?.cache?.maxEntries ?? defaults?.cache?.maxEntries
	};
	const overlap = clampNumber(chunking.overlap, 0, Math.max(0, chunking.tokens - 1));
	const minScore = clampNumber(query.minScore, 0, 1);
	const vectorWeight = clampNumber(hybrid.vectorWeight, 0, 1);
	const textWeight = clampNumber(hybrid.textWeight, 0, 1);
	const sum = vectorWeight + textWeight;
	const normalizedVectorWeight = sum > 0 ? vectorWeight / sum : DEFAULT_HYBRID_VECTOR_WEIGHT;
	const normalizedTextWeight = sum > 0 ? textWeight / sum : DEFAULT_HYBRID_TEXT_WEIGHT;
	const candidateMultiplier = clampInt(hybrid.candidateMultiplier, 1, 20);
	const temporalDecayHalfLifeDays = Math.max(1, Math.floor(Number.isFinite(hybrid.temporalDecay.halfLifeDays) ? hybrid.temporalDecay.halfLifeDays : DEFAULT_TEMPORAL_DECAY_HALF_LIFE_DAYS));
	const deltaBytes = clampInt(sync.sessions.deltaBytes, 0, Number.MAX_SAFE_INTEGER);
	const deltaMessages = clampInt(sync.sessions.deltaMessages, 0, Number.MAX_SAFE_INTEGER);
	return {
		enabled,
		sources,
		extraPaths,
		provider,
		remote,
		experimental: { sessionMemory },
		fallback,
		model,
		local,
		store,
		chunking: {
			tokens: Math.max(1, chunking.tokens),
			overlap
		},
		sync: {
			...sync,
			sessions: {
				deltaBytes,
				deltaMessages
			}
		},
		query: {
			...query,
			minScore,
			hybrid: {
				enabled: Boolean(hybrid.enabled),
				vectorWeight: normalizedVectorWeight,
				textWeight: normalizedTextWeight,
				candidateMultiplier,
				mmr: {
					enabled: Boolean(hybrid.mmr.enabled),
					lambda: Number.isFinite(hybrid.mmr.lambda) ? Math.max(0, Math.min(1, hybrid.mmr.lambda)) : DEFAULT_MMR_LAMBDA
				},
				temporalDecay: {
					enabled: Boolean(hybrid.temporalDecay.enabled),
					halfLifeDays: temporalDecayHalfLifeDays
				}
			}
		},
		cache: {
			enabled: Boolean(cache.enabled),
			maxEntries: typeof cache.maxEntries === "number" && Number.isFinite(cache.maxEntries) ? Math.max(1, Math.floor(cache.maxEntries)) : void 0
		}
	};
}
function resolveMemorySearchConfig(cfg, agentId) {
	const defaults = cfg.agents?.defaults?.memorySearch;
	const overrides = resolveAgentConfig(cfg, agentId)?.memorySearch;
	const resolved = mergeConfig(defaults, overrides, agentId);
	if (!resolved.enabled) return null;
	return resolved;
}

//#endregion
//#region src/memory/embeddings-debug.ts
const debugEmbeddings = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_MEMORY_EMBEDDINGS);
const log$3 = createSubsystemLogger("memory/embeddings");
function debugEmbeddingsLog(message, meta) {
	if (!debugEmbeddings) return;
	const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
	log$3.raw(`${message}${suffix}`);
}

//#endregion
//#region src/memory/remote-http.ts
function buildRemoteBaseUrlPolicy(baseUrl) {
	const trimmed = baseUrl.trim();
	if (!trimmed) return;
	try {
		const parsed = new URL(trimmed);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return;
		return { allowedHostnames: [parsed.hostname] };
	} catch {
		return;
	}
}
async function withRemoteHttpResponse(params) {
	const { response, release } = await fetchWithSsrFGuard({
		url: params.url,
		init: params.init,
		policy: params.ssrfPolicy,
		auditContext: params.auditContext ?? "memory-remote"
	});
	try {
		return await params.onResponse(response);
	} finally {
		await release();
	}
}

//#endregion
//#region src/memory/embeddings-gemini.ts
const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_MAX_INPUT_TOKENS = { "text-embedding-004": 2048 };
function resolveRemoteApiKey(remoteApiKey) {
	const trimmed = remoteApiKey?.trim();
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
function normalizeGeminiBaseUrl(raw) {
	const trimmed = raw.replace(/\/+$/, "");
	const openAiIndex = trimmed.indexOf("/openai");
	if (openAiIndex > -1) return trimmed.slice(0, openAiIndex);
	return trimmed;
}
function buildGeminiModelPath(model) {
	return model.startsWith("models/") ? model : `models/${model}`;
}
async function createGeminiEmbeddingProvider(options) {
	const client = await resolveGeminiEmbeddingClient(options);
	const baseUrl = client.baseUrl.replace(/\/$/, "");
	const embedUrl = `${baseUrl}/${client.modelPath}:embedContent`;
	const batchUrl = `${baseUrl}/${client.modelPath}:batchEmbedContents`;
	const fetchWithGeminiAuth = async (apiKey, endpoint, body) => {
		const headers = {
			...parseGeminiAuth(apiKey).headers,
			...client.headers
		};
		return await withRemoteHttpResponse({
			url: endpoint,
			ssrfPolicy: client.ssrfPolicy,
			init: {
				method: "POST",
				headers,
				body: JSON.stringify(body)
			},
			onResponse: async (res) => {
				if (!res.ok) {
					const text = await res.text();
					throw new Error(`gemini embeddings failed: ${res.status} ${text}`);
				}
				return await res.json();
			}
		});
	};
	const embedQuery = async (text) => {
		if (!text.trim()) return [];
		return (await executeWithApiKeyRotation({
			provider: "google",
			apiKeys: client.apiKeys,
			execute: (apiKey) => fetchWithGeminiAuth(apiKey, embedUrl, {
				content: { parts: [{ text }] },
				taskType: "RETRIEVAL_QUERY"
			})
		})).embedding?.values ?? [];
	};
	const embedBatch = async (texts) => {
		if (texts.length === 0) return [];
		const requests = texts.map((text) => ({
			model: client.modelPath,
			content: { parts: [{ text }] },
			taskType: "RETRIEVAL_DOCUMENT"
		}));
		const payload = await executeWithApiKeyRotation({
			provider: "google",
			apiKeys: client.apiKeys,
			execute: (apiKey) => fetchWithGeminiAuth(apiKey, batchUrl, { requests })
		});
		const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
		return texts.map((_, index) => embeddings[index]?.values ?? []);
	};
	return {
		provider: {
			id: "gemini",
			model: client.model,
			maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
			embedQuery,
			embedBatch
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
	const rawBaseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL;
	const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
	const ssrfPolicy = buildRemoteBaseUrlPolicy(baseUrl);
	const headers = { ...Object.assign({}, providerConfig?.headers, remote?.headers) };
	const apiKeys = collectProviderApiKeysForExecution({
		provider: "google",
		primaryApiKey: apiKey
	});
	const model = normalizeGeminiModel(options.model);
	const modelPath = buildGeminiModelPath(model);
	debugEmbeddingsLog("memory embeddings: gemini client", {
		rawBaseUrl,
		baseUrl,
		model,
		modelPath,
		embedEndpoint: `${baseUrl}/${modelPath}:embedContent`,
		batchEndpoint: `${baseUrl}/${modelPath}:batchEmbedContents`
	});
	return {
		baseUrl,
		headers,
		ssrfPolicy,
		model,
		modelPath,
		apiKeys
	};
}

//#endregion
//#region src/memory/embeddings-remote-client.ts
async function resolveRemoteEmbeddingBearerClient(params) {
	const remote = params.options.remote;
	const remoteApiKey = remote?.apiKey?.trim();
	const remoteBaseUrl = remote?.baseUrl?.trim();
	const providerConfig = params.options.config.models?.providers?.[params.provider];
	const apiKey = remoteApiKey ? remoteApiKey : requireApiKey(await resolveApiKeyForProvider({
		provider: params.provider,
		cfg: params.options.config,
		agentDir: params.options.agentDir
	}), params.provider);
	const baseUrl = remoteBaseUrl || providerConfig?.baseUrl?.trim() || params.defaultBaseUrl;
	const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
	return {
		baseUrl,
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
			...headerOverrides
		},
		ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl)
	};
}

//#endregion
//#region src/memory/post-json.ts
async function postJson(params) {
	return await withRemoteHttpResponse({
		url: params.url,
		ssrfPolicy: params.ssrfPolicy,
		init: {
			method: "POST",
			headers: params.headers,
			body: JSON.stringify(params.body)
		},
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				const err = /* @__PURE__ */ new Error(`${params.errorPrefix}: ${res.status} ${text}`);
				if (params.attachStatus) err.status = res.status;
				throw err;
			}
			return await params.parse(await res.json());
		}
	});
}

//#endregion
//#region src/memory/embeddings-remote-fetch.ts
async function fetchRemoteEmbeddingVectors(params) {
	return await postJson({
		url: params.url,
		headers: params.headers,
		ssrfPolicy: params.ssrfPolicy,
		body: params.body,
		errorPrefix: params.errorPrefix,
		parse: (payload) => {
			return (payload.data ?? []).map((entry) => entry.embedding ?? []);
		}
	});
}

//#endregion
//#region src/memory/embeddings-remote-provider.ts
function createRemoteEmbeddingProvider(params) {
	const { client } = params;
	const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
	const embed = async (input) => {
		if (input.length === 0) return [];
		return await fetchRemoteEmbeddingVectors({
			url,
			headers: client.headers,
			ssrfPolicy: client.ssrfPolicy,
			body: {
				model: client.model,
				input
			},
			errorPrefix: params.errorPrefix
		});
	};
	return {
		id: params.id,
		model: client.model,
		...typeof params.maxInputTokens === "number" ? { maxInputTokens: params.maxInputTokens } : {},
		embedQuery: async (text) => {
			const [vec] = await embed([text]);
			return vec ?? [];
		},
		embedBatch: embed
	};
}
async function resolveRemoteEmbeddingClient(params) {
	const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
		provider: params.provider,
		options: params.options,
		defaultBaseUrl: params.defaultBaseUrl
	});
	return {
		baseUrl,
		headers,
		ssrfPolicy,
		model: params.normalizeModel(params.options.model)
	};
}

//#endregion
//#region src/memory/embeddings-mistral.ts
const DEFAULT_MISTRAL_EMBEDDING_MODEL = "mistral-embed";
const DEFAULT_MISTRAL_BASE_URL = "https://api.mistral.ai/v1";
function normalizeMistralModel(model) {
	const trimmed = model.trim();
	if (!trimmed) return DEFAULT_MISTRAL_EMBEDDING_MODEL;
	if (trimmed.startsWith("mistral/")) return trimmed.slice(8);
	return trimmed;
}
async function createMistralEmbeddingProvider(options) {
	const client = await resolveMistralEmbeddingClient(options);
	return {
		provider: createRemoteEmbeddingProvider({
			id: "mistral",
			client,
			errorPrefix: "mistral embeddings failed"
		}),
		client
	};
}
async function resolveMistralEmbeddingClient(options) {
	return await resolveRemoteEmbeddingClient({
		provider: "mistral",
		options,
		defaultBaseUrl: DEFAULT_MISTRAL_BASE_URL,
		normalizeModel: normalizeMistralModel
	});
}

//#endregion
//#region src/memory/embeddings-openai.ts
const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MAX_INPUT_TOKENS = {
	"text-embedding-3-small": 8192,
	"text-embedding-3-large": 8192,
	"text-embedding-ada-002": 8191
};
function normalizeOpenAiModel(model) {
	const trimmed = model.trim();
	if (!trimmed) return DEFAULT_OPENAI_EMBEDDING_MODEL;
	if (trimmed.startsWith("openai/")) return trimmed.slice(7);
	return trimmed;
}
async function createOpenAiEmbeddingProvider(options) {
	const client = await resolveOpenAiEmbeddingClient(options);
	return {
		provider: createRemoteEmbeddingProvider({
			id: "openai",
			client,
			errorPrefix: "openai embeddings failed",
			maxInputTokens: OPENAI_MAX_INPUT_TOKENS[client.model]
		}),
		client
	};
}
async function resolveOpenAiEmbeddingClient(options) {
	return await resolveRemoteEmbeddingClient({
		provider: "openai",
		options,
		defaultBaseUrl: DEFAULT_OPENAI_BASE_URL,
		normalizeModel: normalizeOpenAiModel
	});
}

//#endregion
//#region src/memory/embeddings-voyage.ts
const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-4-large";
const DEFAULT_VOYAGE_BASE_URL = "https://api.voyageai.com/v1";
const VOYAGE_MAX_INPUT_TOKENS = {
	"voyage-3": 32e3,
	"voyage-3-lite": 16e3,
	"voyage-code-3": 32e3
};
function normalizeVoyageModel(model) {
	const trimmed = model.trim();
	if (!trimmed) return DEFAULT_VOYAGE_EMBEDDING_MODEL;
	if (trimmed.startsWith("voyage/")) return trimmed.slice(7);
	return trimmed;
}
async function createVoyageEmbeddingProvider(options) {
	const client = await resolveVoyageEmbeddingClient(options);
	const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
	const embed = async (input, input_type) => {
		if (input.length === 0) return [];
		const body = {
			model: client.model,
			input
		};
		if (input_type) body.input_type = input_type;
		return await fetchRemoteEmbeddingVectors({
			url,
			headers: client.headers,
			ssrfPolicy: client.ssrfPolicy,
			body,
			errorPrefix: "voyage embeddings failed"
		});
	};
	return {
		provider: {
			id: "voyage",
			model: client.model,
			maxInputTokens: VOYAGE_MAX_INPUT_TOKENS[client.model],
			embedQuery: async (text) => {
				const [vec] = await embed([text], "query");
				return vec ?? [];
			},
			embedBatch: async (texts) => embed(texts, "document")
		},
		client
	};
}
async function resolveVoyageEmbeddingClient(options) {
	const { baseUrl, headers, ssrfPolicy } = await resolveRemoteEmbeddingBearerClient({
		provider: "voyage",
		options,
		defaultBaseUrl: DEFAULT_VOYAGE_BASE_URL
	});
	return {
		baseUrl,
		headers,
		ssrfPolicy,
		model: normalizeVoyageModel(options.model)
	};
}

//#endregion
//#region src/memory/node-llama.ts
async function importNodeLlamaCpp() {
	return import("node-llama-cpp");
}

//#endregion
//#region src/memory/embeddings.ts
function sanitizeAndNormalizeEmbedding(vec) {
	const sanitized = vec.map((value) => Number.isFinite(value) ? value : 0);
	const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
	if (magnitude < 1e-10) return sanitized;
	return sanitized.map((value) => value / magnitude);
}
const REMOTE_EMBEDDING_PROVIDER_IDS = [
	"openai",
	"gemini",
	"voyage",
	"mistral"
];
const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
function canAutoSelectLocal(options) {
	const modelPath = options.local?.modelPath?.trim();
	if (!modelPath) return false;
	if (/^(hf:|https?:)/i.test(modelPath)) return false;
	const resolved = resolveUserPath(modelPath);
	try {
		return syncFs.statSync(resolved).isFile();
	} catch {
		return false;
	}
}
function isMissingApiKeyError(err) {
	return formatErrorMessage(err).includes("No API key found for provider");
}
async function createLocalEmbeddingProvider(options) {
	const modelPath = options.local?.modelPath?.trim() || DEFAULT_LOCAL_MODEL;
	const modelCacheDir = options.local?.modelCacheDir?.trim();
	const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();
	let llama = null;
	let embeddingModel = null;
	let embeddingContext = null;
	const ensureContext = async () => {
		if (!llama) llama = await getLlama({ logLevel: LlamaLogLevel.error });
		if (!embeddingModel) {
			const resolved = await resolveModelFile(modelPath, modelCacheDir || void 0);
			embeddingModel = await llama.loadModel({ modelPath: resolved });
		}
		if (!embeddingContext) embeddingContext = await embeddingModel.createEmbeddingContext();
		return embeddingContext;
	};
	return {
		id: "local",
		model: modelPath,
		embedQuery: async (text) => {
			const embedding = await (await ensureContext()).getEmbeddingFor(text);
			return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
		},
		embedBatch: async (texts) => {
			const ctx = await ensureContext();
			return await Promise.all(texts.map(async (text) => {
				const embedding = await ctx.getEmbeddingFor(text);
				return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
			}));
		}
	};
}
async function createEmbeddingProvider(options) {
	const requestedProvider = options.provider;
	const fallback = options.fallback;
	const createProvider = async (id) => {
		if (id === "local") return { provider: await createLocalEmbeddingProvider(options) };
		if (id === "gemini") {
			const { provider, client } = await createGeminiEmbeddingProvider(options);
			return {
				provider,
				gemini: client
			};
		}
		if (id === "voyage") {
			const { provider, client } = await createVoyageEmbeddingProvider(options);
			return {
				provider,
				voyage: client
			};
		}
		if (id === "mistral") {
			const { provider, client } = await createMistralEmbeddingProvider(options);
			return {
				provider,
				mistral: client
			};
		}
		const { provider, client } = await createOpenAiEmbeddingProvider(options);
		return {
			provider,
			openAi: client
		};
	};
	const formatPrimaryError = (err, provider) => provider === "local" ? formatLocalSetupError(err) : formatErrorMessage(err);
	if (requestedProvider === "auto") {
		const missingKeyErrors = [];
		let localError = null;
		if (canAutoSelectLocal(options)) try {
			return {
				...await createProvider("local"),
				requestedProvider
			};
		} catch (err) {
			localError = formatLocalSetupError(err);
		}
		for (const provider of REMOTE_EMBEDDING_PROVIDER_IDS) try {
			return {
				...await createProvider(provider),
				requestedProvider
			};
		} catch (err) {
			const message = formatPrimaryError(err, provider);
			if (isMissingApiKeyError(err)) {
				missingKeyErrors.push(message);
				continue;
			}
			const wrapped = new Error(message);
			wrapped.cause = err;
			throw wrapped;
		}
		const details = [...missingKeyErrors, localError].filter(Boolean);
		return {
			provider: null,
			requestedProvider,
			providerUnavailableReason: details.length > 0 ? details.join("\n\n") : "No embeddings provider available."
		};
	}
	try {
		return {
			...await createProvider(requestedProvider),
			requestedProvider
		};
	} catch (primaryErr) {
		const reason = formatPrimaryError(primaryErr, requestedProvider);
		if (fallback && fallback !== "none" && fallback !== requestedProvider) try {
			return {
				...await createProvider(fallback),
				requestedProvider,
				fallbackFrom: requestedProvider,
				fallbackReason: reason
			};
		} catch (fallbackErr) {
			const combinedReason = `${reason}\n\nFallback to ${fallback} failed: ${formatErrorMessage(fallbackErr)}`;
			if (isMissingApiKeyError(primaryErr) && isMissingApiKeyError(fallbackErr)) return {
				provider: null,
				requestedProvider,
				fallbackFrom: requestedProvider,
				fallbackReason: reason,
				providerUnavailableReason: combinedReason
			};
			const wrapped = new Error(combinedReason);
			wrapped.cause = fallbackErr;
			throw wrapped;
		}
		if (isMissingApiKeyError(primaryErr)) return {
			provider: null,
			requestedProvider,
			providerUnavailableReason: reason
		};
		const wrapped = new Error(reason);
		wrapped.cause = primaryErr;
		throw wrapped;
	}
}
function isNodeLlamaCppMissing(err) {
	if (!(err instanceof Error)) return false;
	if (err.code === "ERR_MODULE_NOT_FOUND") return err.message.includes("node-llama-cpp");
	return false;
}
function formatLocalSetupError(err) {
	const detail = formatErrorMessage(err);
	const missing = isNodeLlamaCppMissing(err);
	return [
		"Local embeddings unavailable.",
		missing ? "Reason: optional dependency node-llama-cpp is missing (or failed to install)." : detail ? `Reason: ${detail}` : void 0,
		missing && detail ? `Detail: ${detail}` : null,
		"To enable local embeddings:",
		"1) Use Node 22 LTS (recommended for installs/updates)",
		missing ? "2) Reinstall OpenClaw (this should install node-llama-cpp): npm i -g openclaw@latest" : null,
		"3) If you use pnpm: pnpm approve-builds (select node-llama-cpp), then pnpm rebuild node-llama-cpp",
		...REMOTE_EMBEDDING_PROVIDER_IDS.map((provider) => `Or set agents.defaults.memorySearch.provider = "${provider}" (remote).`)
	].filter(Boolean).join("\n");
}

//#endregion
//#region src/memory/mmr.ts
const DEFAULT_MMR_CONFIG = {
	enabled: false,
	lambda: .7
};
/**
* Tokenize text for Jaccard similarity computation.
* Extracts alphanumeric tokens and normalizes to lowercase.
*/
function tokenize(text) {
	const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
	return new Set(tokens);
}
/**
* Compute Jaccard similarity between two token sets.
* Returns a value in [0, 1] where 1 means identical sets.
*/
function jaccardSimilarity(setA, setB) {
	if (setA.size === 0 && setB.size === 0) return 1;
	if (setA.size === 0 || setB.size === 0) return 0;
	let intersectionSize = 0;
	const smaller = setA.size <= setB.size ? setA : setB;
	const larger = setA.size <= setB.size ? setB : setA;
	for (const token of smaller) if (larger.has(token)) intersectionSize++;
	const unionSize = setA.size + setB.size - intersectionSize;
	return unionSize === 0 ? 0 : intersectionSize / unionSize;
}
/**
* Compute the maximum similarity between an item and all selected items.
*/
function maxSimilarityToSelected(item, selectedItems, tokenCache) {
	if (selectedItems.length === 0) return 0;
	let maxSim = 0;
	const itemTokens = tokenCache.get(item.id) ?? tokenize(item.content);
	for (const selected of selectedItems) {
		const sim = jaccardSimilarity(itemTokens, tokenCache.get(selected.id) ?? tokenize(selected.content));
		if (sim > maxSim) maxSim = sim;
	}
	return maxSim;
}
/**
* Compute MMR score for a candidate item.
* MMR = λ * relevance - (1-λ) * max_similarity_to_selected
*/
function computeMMRScore(relevance, maxSimilarity, lambda) {
	return lambda * relevance - (1 - lambda) * maxSimilarity;
}
/**
* Re-rank items using Maximal Marginal Relevance (MMR).
*
* The algorithm iteratively selects items that balance relevance with diversity:
* 1. Start with the highest-scoring item
* 2. For each remaining slot, select the item that maximizes the MMR score
* 3. MMR score = λ * relevance - (1-λ) * max_similarity_to_already_selected
*
* @param items - Items to re-rank, must have score and content
* @param config - MMR configuration (lambda, enabled)
* @returns Re-ranked items in MMR order
*/
function mmrRerank(items, config = {}) {
	const { enabled = DEFAULT_MMR_CONFIG.enabled, lambda = DEFAULT_MMR_CONFIG.lambda } = config;
	if (!enabled || items.length <= 1) return [...items];
	const clampedLambda = Math.max(0, Math.min(1, lambda));
	if (clampedLambda === 1) return [...items].toSorted((a, b) => b.score - a.score);
	const tokenCache = /* @__PURE__ */ new Map();
	for (const item of items) tokenCache.set(item.id, tokenize(item.content));
	const maxScore = Math.max(...items.map((i) => i.score));
	const minScore = Math.min(...items.map((i) => i.score));
	const scoreRange = maxScore - minScore;
	const normalizeScore = (score) => {
		if (scoreRange === 0) return 1;
		return (score - minScore) / scoreRange;
	};
	const selected = [];
	const remaining = new Set(items);
	while (remaining.size > 0) {
		let bestItem = null;
		let bestMMRScore = -Infinity;
		for (const candidate of remaining) {
			const mmrScore = computeMMRScore(normalizeScore(candidate.score), maxSimilarityToSelected(candidate, selected, tokenCache), clampedLambda);
			if (mmrScore > bestMMRScore || mmrScore === bestMMRScore && candidate.score > (bestItem?.score ?? -Infinity)) {
				bestMMRScore = mmrScore;
				bestItem = candidate;
			}
		}
		if (bestItem) {
			selected.push(bestItem);
			remaining.delete(bestItem);
		} else break;
	}
	return selected;
}
/**
* Apply MMR re-ranking to hybrid search results.
* Adapts the generic MMR function to work with the hybrid search result format.
*/
function applyMMRToHybridResults(results, config = {}) {
	if (results.length === 0) return results;
	const itemById = /* @__PURE__ */ new Map();
	return mmrRerank(results.map((r, index) => {
		const id = `${r.path}:${r.startLine}:${index}`;
		itemById.set(id, r);
		return {
			id,
			score: r.score,
			content: r.snippet
		};
	}), config).map((item) => itemById.get(item.id));
}

//#endregion
//#region src/memory/temporal-decay.ts
const DEFAULT_TEMPORAL_DECAY_CONFIG = {
	enabled: false,
	halfLifeDays: 30
};
const DAY_MS = 1440 * 60 * 1e3;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;
function toDecayLambda(halfLifeDays) {
	if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return 0;
	return Math.LN2 / halfLifeDays;
}
function calculateTemporalDecayMultiplier(params) {
	const lambda = toDecayLambda(params.halfLifeDays);
	const clampedAge = Math.max(0, params.ageInDays);
	if (lambda <= 0 || !Number.isFinite(clampedAge)) return 1;
	return Math.exp(-lambda * clampedAge);
}
function applyTemporalDecayToScore(params) {
	return params.score * calculateTemporalDecayMultiplier(params);
}
function parseMemoryDateFromPath(filePath) {
	const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
	const match = DATED_MEMORY_PATH_RE.exec(normalized);
	if (!match) return null;
	const year = Number(match[1]);
	const month = Number(match[2]);
	const day = Number(match[3]);
	if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
	const timestamp = Date.UTC(year, month - 1, day);
	const parsed = new Date(timestamp);
	if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
	return parsed;
}
function isEvergreenMemoryPath(filePath) {
	const normalized = filePath.replaceAll("\\", "/").replace(/^\.\//, "");
	if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
	if (!normalized.startsWith("memory/")) return false;
	return !DATED_MEMORY_PATH_RE.test(normalized);
}
async function extractTimestamp(params) {
	const fromPath = parseMemoryDateFromPath(params.filePath);
	if (fromPath) return fromPath;
	if (params.source === "memory" && isEvergreenMemoryPath(params.filePath)) return null;
	if (!params.workspaceDir) return null;
	const absolutePath = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(params.workspaceDir, params.filePath);
	try {
		const stat = await fs.stat(absolutePath);
		if (!Number.isFinite(stat.mtimeMs)) return null;
		return new Date(stat.mtimeMs);
	} catch {
		return null;
	}
}
function ageInDaysFromTimestamp(timestamp, nowMs) {
	return Math.max(0, nowMs - timestamp.getTime()) / DAY_MS;
}
async function applyTemporalDecayToHybridResults(params) {
	const config = {
		...DEFAULT_TEMPORAL_DECAY_CONFIG,
		...params.temporalDecay
	};
	if (!config.enabled) return [...params.results];
	const nowMs = params.nowMs ?? Date.now();
	const timestampPromiseCache = /* @__PURE__ */ new Map();
	return Promise.all(params.results.map(async (entry) => {
		const cacheKey = `${entry.source}:${entry.path}`;
		let timestampPromise = timestampPromiseCache.get(cacheKey);
		if (!timestampPromise) {
			timestampPromise = extractTimestamp({
				filePath: entry.path,
				source: entry.source,
				workspaceDir: params.workspaceDir
			});
			timestampPromiseCache.set(cacheKey, timestampPromise);
		}
		const timestamp = await timestampPromise;
		if (!timestamp) return entry;
		const decayedScore = applyTemporalDecayToScore({
			score: entry.score,
			ageInDays: ageInDaysFromTimestamp(timestamp, nowMs),
			halfLifeDays: config.halfLifeDays
		});
		return {
			...entry,
			score: decayedScore
		};
	}));
}

//#endregion
//#region src/memory/hybrid.ts
function buildFtsQuery(raw) {
	const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replaceAll("\"", "")}"`).join(" AND ");
}
function bm25RankToScore(rank) {
	return 1 / (1 + (Number.isFinite(rank) ? Math.max(0, rank) : 999));
}
async function mergeHybridResults(params) {
	const byId = /* @__PURE__ */ new Map();
	for (const r of params.vector) byId.set(r.id, {
		id: r.id,
		path: r.path,
		startLine: r.startLine,
		endLine: r.endLine,
		source: r.source,
		snippet: r.snippet,
		vectorScore: r.vectorScore,
		textScore: 0
	});
	for (const r of params.keyword) {
		const existing = byId.get(r.id);
		if (existing) {
			existing.textScore = r.textScore;
			if (r.snippet && r.snippet.length > 0) existing.snippet = r.snippet;
		} else byId.set(r.id, {
			id: r.id,
			path: r.path,
			startLine: r.startLine,
			endLine: r.endLine,
			source: r.source,
			snippet: r.snippet,
			vectorScore: 0,
			textScore: r.textScore
		});
	}
	const sorted = (await applyTemporalDecayToHybridResults({
		results: Array.from(byId.values()).map((entry) => {
			const score = params.vectorWeight * entry.vectorScore + params.textWeight * entry.textScore;
			return {
				path: entry.path,
				startLine: entry.startLine,
				endLine: entry.endLine,
				score,
				snippet: entry.snippet,
				source: entry.source
			};
		}),
		temporalDecay: {
			...DEFAULT_TEMPORAL_DECAY_CONFIG,
			...params.temporalDecay
		},
		workspaceDir: params.workspaceDir,
		nowMs: params.nowMs
	})).toSorted((a, b) => b.score - a.score);
	const mmrConfig = {
		...DEFAULT_MMR_CONFIG,
		...params.mmr
	};
	if (mmrConfig.enabled) return applyMMRToHybridResults(sorted, mmrConfig);
	return sorted;
}

//#endregion
//#region src/memory/batch-utils.ts
function normalizeBatchBaseUrl(client) {
	return client.baseUrl?.replace(/\/$/, "") ?? "";
}
function buildBatchHeaders(client, params) {
	const headers = client.headers ? { ...client.headers } : {};
	if (params.json) {
		if (!headers["Content-Type"] && !headers["content-type"]) headers["Content-Type"] = "application/json";
	} else {
		delete headers["Content-Type"];
		delete headers["content-type"];
	}
	return headers;
}
function splitBatchRequests(requests, maxRequests) {
	if (requests.length <= maxRequests) return [requests];
	const groups = [];
	for (let i = 0; i < requests.length; i += maxRequests) groups.push(requests.slice(i, i + maxRequests));
	return groups;
}

//#endregion
//#region src/memory/batch-runner.ts
async function runEmbeddingBatchGroups(params) {
	if (params.requests.length === 0) return /* @__PURE__ */ new Map();
	const groups = splitBatchRequests(params.requests, params.maxRequests);
	const byCustomId = /* @__PURE__ */ new Map();
	const tasks = groups.map((group, groupIndex) => async () => {
		await params.runGroup({
			group,
			groupIndex,
			groups: groups.length,
			byCustomId
		});
	});
	params.debug?.(params.debugLabel, {
		requests: params.requests.length,
		groups: groups.length,
		wait: params.wait,
		concurrency: params.concurrency,
		pollIntervalMs: params.pollIntervalMs,
		timeoutMs: params.timeoutMs
	});
	await runWithConcurrency(tasks, params.concurrency);
	return byCustomId;
}
function buildEmbeddingBatchGroupOptions(params, options) {
	return {
		requests: params.requests,
		maxRequests: options.maxRequests,
		wait: params.wait,
		pollIntervalMs: params.pollIntervalMs,
		timeoutMs: params.timeoutMs,
		concurrency: params.concurrency,
		debug: params.debug,
		debugLabel: options.debugLabel
	};
}

//#endregion
//#region src/memory/batch-gemini.ts
const GEMINI_BATCH_MAX_REQUESTS = 5e4;
function getGeminiUploadUrl(baseUrl) {
	if (baseUrl.includes("/v1beta")) return baseUrl.replace(/\/v1beta\/?$/, "/upload/v1beta");
	return `${baseUrl.replace(/\/$/, "")}/upload`;
}
function buildGeminiUploadBody(params) {
	const boundary = `openclaw-${hashText(params.displayName)}`;
	const jsonPart = JSON.stringify({ file: {
		displayName: params.displayName,
		mimeType: "application/jsonl"
	} });
	const delimiter = `--${boundary}\r\n`;
	const closeDelimiter = `--${boundary}--\r\n`;
	const parts = [
		`${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${jsonPart}\r\n`,
		`${delimiter}Content-Type: application/jsonl; charset=UTF-8\r\n\r\n${params.jsonl}\r\n`,
		closeDelimiter
	];
	return {
		body: new Blob([parts.join("")], { type: "multipart/related" }),
		contentType: `multipart/related; boundary=${boundary}`
	};
}
async function submitGeminiBatch(params) {
	const baseUrl = normalizeBatchBaseUrl(params.gemini);
	const uploadPayload = buildGeminiUploadBody({
		jsonl: params.requests.map((request) => JSON.stringify({
			key: request.custom_id,
			request: {
				content: request.content,
				task_type: request.taskType
			}
		})).join("\n"),
		displayName: `memory-embeddings-${hashText(String(Date.now()))}`
	});
	const uploadUrl = `${getGeminiUploadUrl(baseUrl)}/files?uploadType=multipart`;
	debugEmbeddingsLog("memory embeddings: gemini batch upload", {
		uploadUrl,
		baseUrl,
		requests: params.requests.length
	});
	const filePayload = await withRemoteHttpResponse({
		url: uploadUrl,
		ssrfPolicy: params.gemini.ssrfPolicy,
		init: {
			method: "POST",
			headers: {
				...buildBatchHeaders(params.gemini, { json: false }),
				"Content-Type": uploadPayload.contentType
			},
			body: uploadPayload.body
		},
		onResponse: async (fileRes) => {
			if (!fileRes.ok) {
				const text = await fileRes.text();
				throw new Error(`gemini batch file upload failed: ${fileRes.status} ${text}`);
			}
			return await fileRes.json();
		}
	});
	const fileId = filePayload.name ?? filePayload.file?.name;
	if (!fileId) throw new Error("gemini batch file upload failed: missing file id");
	const batchBody = { batch: {
		displayName: `memory-embeddings-${params.agentId}`,
		inputConfig: { file_name: fileId }
	} };
	const batchEndpoint = `${baseUrl}/${params.gemini.modelPath}:asyncBatchEmbedContent`;
	debugEmbeddingsLog("memory embeddings: gemini batch create", {
		batchEndpoint,
		fileId
	});
	return await withRemoteHttpResponse({
		url: batchEndpoint,
		ssrfPolicy: params.gemini.ssrfPolicy,
		init: {
			method: "POST",
			headers: buildBatchHeaders(params.gemini, { json: true }),
			body: JSON.stringify(batchBody)
		},
		onResponse: async (batchRes) => {
			if (batchRes.ok) return await batchRes.json();
			const text = await batchRes.text();
			if (batchRes.status === 404) throw new Error("gemini batch create failed: 404 (asyncBatchEmbedContent not available for this model/baseUrl). Disable remote.batch.enabled or switch providers.");
			throw new Error(`gemini batch create failed: ${batchRes.status} ${text}`);
		}
	});
}
async function fetchGeminiBatchStatus(params) {
	const statusUrl = `${normalizeBatchBaseUrl(params.gemini)}/${params.batchName.startsWith("batches/") ? params.batchName : `batches/${params.batchName}`}`;
	debugEmbeddingsLog("memory embeddings: gemini batch status", { statusUrl });
	return await withRemoteHttpResponse({
		url: statusUrl,
		ssrfPolicy: params.gemini.ssrfPolicy,
		init: { headers: buildBatchHeaders(params.gemini, { json: true }) },
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`gemini batch status failed: ${res.status} ${text}`);
			}
			return await res.json();
		}
	});
}
async function fetchGeminiFileContent(params) {
	const downloadUrl = `${normalizeBatchBaseUrl(params.gemini)}/${params.fileId.startsWith("files/") ? params.fileId : `files/${params.fileId}`}:download`;
	debugEmbeddingsLog("memory embeddings: gemini batch download", { downloadUrl });
	return await withRemoteHttpResponse({
		url: downloadUrl,
		ssrfPolicy: params.gemini.ssrfPolicy,
		init: { headers: buildBatchHeaders(params.gemini, { json: true }) },
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`gemini batch file content failed: ${res.status} ${text}`);
			}
			return await res.text();
		}
	});
}
function parseGeminiBatchOutput(text) {
	if (!text.trim()) return [];
	return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
async function waitForGeminiBatch(params) {
	const start = Date.now();
	let current = params.initial;
	while (true) {
		const status = current ?? await fetchGeminiBatchStatus({
			gemini: params.gemini,
			batchName: params.batchName
		});
		const state = status.state ?? "UNKNOWN";
		if ([
			"SUCCEEDED",
			"COMPLETED",
			"DONE"
		].includes(state)) {
			const outputFileId = status.outputConfig?.file ?? status.outputConfig?.fileId ?? status.metadata?.output?.responsesFile;
			if (!outputFileId) throw new Error(`gemini batch ${params.batchName} completed without output file`);
			return { outputFileId };
		}
		if ([
			"FAILED",
			"CANCELLED",
			"CANCELED",
			"EXPIRED"
		].includes(state)) {
			const message = status.error?.message ?? "unknown error";
			throw new Error(`gemini batch ${params.batchName} ${state}: ${message}`);
		}
		if (!params.wait) throw new Error(`gemini batch ${params.batchName} still ${state}; wait disabled`);
		if (Date.now() - start > params.timeoutMs) throw new Error(`gemini batch ${params.batchName} timed out after ${params.timeoutMs}ms`);
		params.debug?.(`gemini batch ${params.batchName} ${state}; waiting ${params.pollIntervalMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
		current = void 0;
	}
}
async function runGeminiEmbeddingBatches(params) {
	return await runEmbeddingBatchGroups({
		...buildEmbeddingBatchGroupOptions(params, {
			maxRequests: GEMINI_BATCH_MAX_REQUESTS,
			debugLabel: "memory embeddings: gemini batch submit"
		}),
		runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
			const batchInfo = await submitGeminiBatch({
				gemini: params.gemini,
				requests: group,
				agentId: params.agentId
			});
			const batchName = batchInfo.name ?? "";
			if (!batchName) throw new Error("gemini batch create failed: missing batch name");
			params.debug?.("memory embeddings: gemini batch created", {
				batchName,
				state: batchInfo.state,
				group: groupIndex + 1,
				groups,
				requests: group.length
			});
			if (!params.wait && batchInfo.state && ![
				"SUCCEEDED",
				"COMPLETED",
				"DONE"
			].includes(batchInfo.state)) throw new Error(`gemini batch ${batchName} submitted; enable remote.batch.wait to await completion`);
			const completed = batchInfo.state && [
				"SUCCEEDED",
				"COMPLETED",
				"DONE"
			].includes(batchInfo.state) ? { outputFileId: batchInfo.outputConfig?.file ?? batchInfo.outputConfig?.fileId ?? batchInfo.metadata?.output?.responsesFile ?? "" } : await waitForGeminiBatch({
				gemini: params.gemini,
				batchName,
				wait: params.wait,
				pollIntervalMs: params.pollIntervalMs,
				timeoutMs: params.timeoutMs,
				debug: params.debug,
				initial: batchInfo
			});
			if (!completed.outputFileId) throw new Error(`gemini batch ${batchName} completed without output file`);
			const outputLines = parseGeminiBatchOutput(await fetchGeminiFileContent({
				gemini: params.gemini,
				fileId: completed.outputFileId
			}));
			const errors = [];
			const remaining = new Set(group.map((request) => request.custom_id));
			for (const line of outputLines) {
				const customId = line.key ?? line.custom_id ?? line.request_id;
				if (!customId) continue;
				remaining.delete(customId);
				if (line.error?.message) {
					errors.push(`${customId}: ${line.error.message}`);
					continue;
				}
				if (line.response?.error?.message) {
					errors.push(`${customId}: ${line.response.error.message}`);
					continue;
				}
				const embedding = line.embedding?.values ?? line.response?.embedding?.values ?? [];
				if (embedding.length === 0) {
					errors.push(`${customId}: empty embedding`);
					continue;
				}
				byCustomId.set(customId, embedding);
			}
			if (errors.length > 0) throw new Error(`gemini batch ${batchName} failed: ${errors.join("; ")}`);
			if (remaining.size > 0) throw new Error(`gemini batch ${batchName} missing ${remaining.size} embedding responses`);
		}
	});
}

//#endregion
//#region src/memory/batch-error-utils.ts
function getResponseErrorMessage(line) {
	const body = line?.response?.body;
	if (typeof body === "string") return body || void 0;
	if (!body || typeof body !== "object") return;
	return typeof body.error?.message === "string" ? body.error.message : void 0;
}
function extractBatchErrorMessage(lines) {
	const first = lines.find((line) => line.error?.message || getResponseErrorMessage(line));
	return first?.error?.message ?? getResponseErrorMessage(first);
}
function formatUnavailableBatchError(err) {
	const message = err instanceof Error ? err.message : String(err);
	return message ? `error file unavailable: ${message}` : void 0;
}

//#endregion
//#region src/memory/batch-http.ts
async function postJsonWithRetry(params) {
	return await retryAsync(async () => {
		return await postJson({
			url: params.url,
			headers: params.headers,
			ssrfPolicy: params.ssrfPolicy,
			body: params.body,
			errorPrefix: params.errorPrefix,
			attachStatus: true,
			parse: async (payload) => payload
		});
	}, {
		attempts: 3,
		minDelayMs: 300,
		maxDelayMs: 2e3,
		jitter: .2,
		shouldRetry: (err) => {
			const status = err.status;
			return status === 429 || typeof status === "number" && status >= 500;
		}
	});
}

//#endregion
//#region src/memory/batch-output.ts
function applyEmbeddingBatchOutputLine(params) {
	const customId = params.line.custom_id;
	if (!customId) return;
	params.remaining.delete(customId);
	const errorMessage = params.line.error?.message;
	if (errorMessage) {
		params.errors.push(`${customId}: ${errorMessage}`);
		return;
	}
	const response = params.line.response;
	if ((response?.status_code ?? 0) >= 400) {
		const messageFromObject = response?.body && typeof response.body === "object" ? response.body.error?.message : void 0;
		const messageFromString = typeof response?.body === "string" ? response.body : void 0;
		params.errors.push(`${customId}: ${messageFromObject ?? messageFromString ?? "unknown error"}`);
		return;
	}
	const embedding = (response?.body && typeof response.body === "object" ? response.body.data ?? [] : [])[0]?.embedding ?? [];
	if (embedding.length === 0) {
		params.errors.push(`${customId}: empty embedding`);
		return;
	}
	params.byCustomId.set(customId, embedding);
}

//#endregion
//#region src/memory/batch-provider-common.ts
const EMBEDDING_BATCH_ENDPOINT = "/v1/embeddings";

//#endregion
//#region src/memory/batch-upload.ts
async function uploadBatchJsonlFile(params) {
	const baseUrl = normalizeBatchBaseUrl(params.client);
	const jsonl = params.requests.map((request) => JSON.stringify(request)).join("\n");
	const form = new FormData();
	form.append("purpose", "batch");
	form.append("file", new Blob([jsonl], { type: "application/jsonl" }), `memory-embeddings.${hashText(String(Date.now()))}.jsonl`);
	const filePayload = await withRemoteHttpResponse({
		url: `${baseUrl}/files`,
		ssrfPolicy: params.client.ssrfPolicy,
		init: {
			method: "POST",
			headers: buildBatchHeaders(params.client, { json: false }),
			body: form
		},
		onResponse: async (fileRes) => {
			if (!fileRes.ok) {
				const text = await fileRes.text();
				throw new Error(`${params.errorPrefix}: ${fileRes.status} ${text}`);
			}
			return await fileRes.json();
		}
	});
	if (!filePayload.id) throw new Error(`${params.errorPrefix}: missing file id`);
	return filePayload.id;
}

//#endregion
//#region src/memory/batch-openai.ts
const OPENAI_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const OPENAI_BATCH_COMPLETION_WINDOW = "24h";
const OPENAI_BATCH_MAX_REQUESTS = 5e4;
async function submitOpenAiBatch(params) {
	const baseUrl = normalizeBatchBaseUrl(params.openAi);
	const inputFileId = await uploadBatchJsonlFile({
		client: params.openAi,
		requests: params.requests,
		errorPrefix: "openai batch file upload failed"
	});
	return await postJsonWithRetry({
		url: `${baseUrl}/batches`,
		headers: buildBatchHeaders(params.openAi, { json: true }),
		ssrfPolicy: params.openAi.ssrfPolicy,
		body: {
			input_file_id: inputFileId,
			endpoint: OPENAI_BATCH_ENDPOINT,
			completion_window: OPENAI_BATCH_COMPLETION_WINDOW,
			metadata: {
				source: "openclaw-memory",
				agent: params.agentId
			}
		},
		errorPrefix: "openai batch create failed"
	});
}
async function fetchOpenAiBatchStatus(params) {
	return await withRemoteHttpResponse({
		url: `${normalizeBatchBaseUrl(params.openAi)}/batches/${params.batchId}`,
		ssrfPolicy: params.openAi.ssrfPolicy,
		init: { headers: buildBatchHeaders(params.openAi, { json: true }) },
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`openai batch status failed: ${res.status} ${text}`);
			}
			return await res.json();
		}
	});
}
async function fetchOpenAiFileContent(params) {
	return await withRemoteHttpResponse({
		url: `${normalizeBatchBaseUrl(params.openAi)}/files/${params.fileId}/content`,
		ssrfPolicy: params.openAi.ssrfPolicy,
		init: { headers: buildBatchHeaders(params.openAi, { json: true }) },
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`openai batch file content failed: ${res.status} ${text}`);
			}
			return await res.text();
		}
	});
}
function parseOpenAiBatchOutput(text) {
	if (!text.trim()) return [];
	return text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
}
async function readOpenAiBatchError(params) {
	try {
		return extractBatchErrorMessage(parseOpenAiBatchOutput(await fetchOpenAiFileContent({
			openAi: params.openAi,
			fileId: params.errorFileId
		})));
	} catch (err) {
		return formatUnavailableBatchError(err);
	}
}
async function waitForOpenAiBatch(params) {
	const start = Date.now();
	let current = params.initial;
	while (true) {
		const status = current ?? await fetchOpenAiBatchStatus({
			openAi: params.openAi,
			batchId: params.batchId
		});
		const state = status.status ?? "unknown";
		if (state === "completed") {
			if (!status.output_file_id) throw new Error(`openai batch ${params.batchId} completed without output file`);
			return {
				outputFileId: status.output_file_id,
				errorFileId: status.error_file_id ?? void 0
			};
		}
		if ([
			"failed",
			"expired",
			"cancelled",
			"canceled"
		].includes(state)) {
			const detail = status.error_file_id ? await readOpenAiBatchError({
				openAi: params.openAi,
				errorFileId: status.error_file_id
			}) : void 0;
			const suffix = detail ? `: ${detail}` : "";
			throw new Error(`openai batch ${params.batchId} ${state}${suffix}`);
		}
		if (!params.wait) throw new Error(`openai batch ${params.batchId} still ${state}; wait disabled`);
		if (Date.now() - start > params.timeoutMs) throw new Error(`openai batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
		params.debug?.(`openai batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
		current = void 0;
	}
}
async function runOpenAiEmbeddingBatches(params) {
	return await runEmbeddingBatchGroups({
		...buildEmbeddingBatchGroupOptions(params, {
			maxRequests: OPENAI_BATCH_MAX_REQUESTS,
			debugLabel: "memory embeddings: openai batch submit"
		}),
		runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
			const batchInfo = await submitOpenAiBatch({
				openAi: params.openAi,
				requests: group,
				agentId: params.agentId
			});
			if (!batchInfo.id) throw new Error("openai batch create failed: missing batch id");
			params.debug?.("memory embeddings: openai batch created", {
				batchId: batchInfo.id,
				status: batchInfo.status,
				group: groupIndex + 1,
				groups,
				requests: group.length
			});
			if (!params.wait && batchInfo.status !== "completed") throw new Error(`openai batch ${batchInfo.id} submitted; enable remote.batch.wait to await completion`);
			const completed = batchInfo.status === "completed" ? {
				outputFileId: batchInfo.output_file_id ?? "",
				errorFileId: batchInfo.error_file_id ?? void 0
			} : await waitForOpenAiBatch({
				openAi: params.openAi,
				batchId: batchInfo.id,
				wait: params.wait,
				pollIntervalMs: params.pollIntervalMs,
				timeoutMs: params.timeoutMs,
				debug: params.debug,
				initial: batchInfo
			});
			if (!completed.outputFileId) throw new Error(`openai batch ${batchInfo.id} completed without output file`);
			const outputLines = parseOpenAiBatchOutput(await fetchOpenAiFileContent({
				openAi: params.openAi,
				fileId: completed.outputFileId
			}));
			const errors = [];
			const remaining = new Set(group.map((request) => request.custom_id));
			for (const line of outputLines) applyEmbeddingBatchOutputLine({
				line,
				remaining,
				errors,
				byCustomId
			});
			if (errors.length > 0) throw new Error(`openai batch ${batchInfo.id} failed: ${errors.join("; ")}`);
			if (remaining.size > 0) throw new Error(`openai batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
		}
	});
}

//#endregion
//#region src/memory/batch-voyage.ts
const VOYAGE_BATCH_ENDPOINT = EMBEDDING_BATCH_ENDPOINT;
const VOYAGE_BATCH_COMPLETION_WINDOW = "12h";
const VOYAGE_BATCH_MAX_REQUESTS = 5e4;
async function submitVoyageBatch(params) {
	const baseUrl = normalizeBatchBaseUrl(params.client);
	const inputFileId = await uploadBatchJsonlFile({
		client: params.client,
		requests: params.requests,
		errorPrefix: "voyage batch file upload failed"
	});
	return await postJsonWithRetry({
		url: `${baseUrl}/batches`,
		headers: buildBatchHeaders(params.client, { json: true }),
		ssrfPolicy: params.client.ssrfPolicy,
		body: {
			input_file_id: inputFileId,
			endpoint: VOYAGE_BATCH_ENDPOINT,
			completion_window: VOYAGE_BATCH_COMPLETION_WINDOW,
			request_params: {
				model: params.client.model,
				input_type: "document"
			},
			metadata: {
				source: "clawdbot-memory",
				agent: params.agentId
			}
		},
		errorPrefix: "voyage batch create failed"
	});
}
async function fetchVoyageBatchStatus(params) {
	return await withRemoteHttpResponse({
		url: `${normalizeBatchBaseUrl(params.client)}/batches/${params.batchId}`,
		ssrfPolicy: params.client.ssrfPolicy,
		init: { headers: buildBatchHeaders(params.client, { json: true }) },
		onResponse: async (res) => {
			if (!res.ok) {
				const text = await res.text();
				throw new Error(`voyage batch status failed: ${res.status} ${text}`);
			}
			return await res.json();
		}
	});
}
async function readVoyageBatchError(params) {
	try {
		return await withRemoteHttpResponse({
			url: `${normalizeBatchBaseUrl(params.client)}/files/${params.errorFileId}/content`,
			ssrfPolicy: params.client.ssrfPolicy,
			init: { headers: buildBatchHeaders(params.client, { json: true }) },
			onResponse: async (res) => {
				if (!res.ok) {
					const text = await res.text();
					throw new Error(`voyage batch error file content failed: ${res.status} ${text}`);
				}
				const text = await res.text();
				if (!text.trim()) return;
				return extractBatchErrorMessage(text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line)));
			}
		});
	} catch (err) {
		return formatUnavailableBatchError(err);
	}
}
async function waitForVoyageBatch(params) {
	const start = Date.now();
	let current = params.initial;
	while (true) {
		const status = current ?? await fetchVoyageBatchStatus({
			client: params.client,
			batchId: params.batchId
		});
		const state = status.status ?? "unknown";
		if (state === "completed") {
			if (!status.output_file_id) throw new Error(`voyage batch ${params.batchId} completed without output file`);
			return {
				outputFileId: status.output_file_id,
				errorFileId: status.error_file_id ?? void 0
			};
		}
		if ([
			"failed",
			"expired",
			"cancelled",
			"canceled"
		].includes(state)) {
			const detail = status.error_file_id ? await readVoyageBatchError({
				client: params.client,
				errorFileId: status.error_file_id
			}) : void 0;
			const suffix = detail ? `: ${detail}` : "";
			throw new Error(`voyage batch ${params.batchId} ${state}${suffix}`);
		}
		if (!params.wait) throw new Error(`voyage batch ${params.batchId} still ${state}; wait disabled`);
		if (Date.now() - start > params.timeoutMs) throw new Error(`voyage batch ${params.batchId} timed out after ${params.timeoutMs}ms`);
		params.debug?.(`voyage batch ${params.batchId} ${state}; waiting ${params.pollIntervalMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, params.pollIntervalMs));
		current = void 0;
	}
}
async function runVoyageEmbeddingBatches(params) {
	return await runEmbeddingBatchGroups({
		...buildEmbeddingBatchGroupOptions(params, {
			maxRequests: VOYAGE_BATCH_MAX_REQUESTS,
			debugLabel: "memory embeddings: voyage batch submit"
		}),
		runGroup: async ({ group, groupIndex, groups, byCustomId }) => {
			const batchInfo = await submitVoyageBatch({
				client: params.client,
				requests: group,
				agentId: params.agentId
			});
			if (!batchInfo.id) throw new Error("voyage batch create failed: missing batch id");
			params.debug?.("memory embeddings: voyage batch created", {
				batchId: batchInfo.id,
				status: batchInfo.status,
				group: groupIndex + 1,
				groups,
				requests: group.length
			});
			if (!params.wait && batchInfo.status !== "completed") throw new Error(`voyage batch ${batchInfo.id} submitted; enable remote.batch.wait to await completion`);
			const completed = batchInfo.status === "completed" ? {
				outputFileId: batchInfo.output_file_id ?? "",
				errorFileId: batchInfo.error_file_id ?? void 0
			} : await waitForVoyageBatch({
				client: params.client,
				batchId: batchInfo.id,
				wait: params.wait,
				pollIntervalMs: params.pollIntervalMs,
				timeoutMs: params.timeoutMs,
				debug: params.debug,
				initial: batchInfo
			});
			if (!completed.outputFileId) throw new Error(`voyage batch ${batchInfo.id} completed without output file`);
			const baseUrl = normalizeBatchBaseUrl(params.client);
			const errors = [];
			const remaining = new Set(group.map((request) => request.custom_id));
			await withRemoteHttpResponse({
				url: `${baseUrl}/files/${completed.outputFileId}/content`,
				ssrfPolicy: params.client.ssrfPolicy,
				init: { headers: buildBatchHeaders(params.client, { json: true }) },
				onResponse: async (contentRes) => {
					if (!contentRes.ok) {
						const text = await contentRes.text();
						throw new Error(`voyage batch file content failed: ${contentRes.status} ${text}`);
					}
					if (!contentRes.body) return;
					const reader = createInterface({
						input: Readable.fromWeb(contentRes.body),
						terminal: false
					});
					for await (const rawLine of reader) {
						if (!rawLine.trim()) continue;
						applyEmbeddingBatchOutputLine({
							line: JSON.parse(rawLine),
							remaining,
							errors,
							byCustomId
						});
					}
				}
			});
			if (errors.length > 0) throw new Error(`voyage batch ${batchInfo.id} failed: ${errors.join("; ")}`);
			if (remaining.size > 0) throw new Error(`voyage batch ${batchInfo.id} missing ${remaining.size} embedding responses`);
		}
	});
}

//#endregion
//#region src/memory/embedding-input-limits.ts
function estimateUtf8Bytes(text) {
	if (!text) return 0;
	return Buffer.byteLength(text, "utf8");
}
function splitTextToUtf8ByteLimit(text, maxUtf8Bytes) {
	if (maxUtf8Bytes <= 0) return [text];
	if (estimateUtf8Bytes(text) <= maxUtf8Bytes) return [text];
	const parts = [];
	let cursor = 0;
	while (cursor < text.length) {
		let low = cursor + 1;
		let high = Math.min(text.length, cursor + maxUtf8Bytes);
		let best = cursor;
		while (low <= high) {
			const mid = Math.floor((low + high) / 2);
			if (estimateUtf8Bytes(text.slice(cursor, mid)) <= maxUtf8Bytes) {
				best = mid;
				low = mid + 1;
			} else high = mid - 1;
		}
		if (best <= cursor) best = Math.min(text.length, cursor + 1);
		if (best < text.length && best > cursor && text.charCodeAt(best - 1) >= 55296 && text.charCodeAt(best - 1) <= 56319 && text.charCodeAt(best) >= 56320 && text.charCodeAt(best) <= 57343) best -= 1;
		const part = text.slice(cursor, best);
		if (!part) break;
		parts.push(part);
		cursor = best;
	}
	return parts;
}

//#endregion
//#region src/memory/embedding-model-limits.ts
const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;
const KNOWN_EMBEDDING_MAX_INPUT_TOKENS = {
	"openai:text-embedding-3-small": 8192,
	"openai:text-embedding-3-large": 8192,
	"openai:text-embedding-ada-002": 8191,
	"gemini:text-embedding-004": 2048,
	"voyage:voyage-3": 32e3,
	"voyage:voyage-3-lite": 16e3,
	"voyage:voyage-code-3": 32e3
};
function resolveEmbeddingMaxInputTokens(provider) {
	if (typeof provider.maxInputTokens === "number") return provider.maxInputTokens;
	const known = KNOWN_EMBEDDING_MAX_INPUT_TOKENS[`${provider.id}:${provider.model}`.toLowerCase()];
	if (typeof known === "number") return known;
	if (provider.id.toLowerCase() === "gemini") return 2048;
	if (provider.id.toLowerCase() === "local") return DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS;
	return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}

//#endregion
//#region src/memory/embedding-chunk-limits.ts
function enforceEmbeddingMaxInputTokens(provider, chunks, hardMaxInputTokens) {
	const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
	const maxInputTokens = typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0 ? Math.min(providerMaxInputTokens, hardMaxInputTokens) : providerMaxInputTokens;
	const out = [];
	for (const chunk of chunks) {
		if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
			out.push(chunk);
			continue;
		}
		for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) out.push({
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			text,
			hash: hashText(text)
		});
	}
	return out;
}

//#endregion
//#region src/memory/memory-schema.ts
function ensureMemoryIndexSchema(params) {
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
	params.db.exec(`
    CREATE TABLE IF NOT EXISTS ${params.embeddingCacheTable} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${params.embeddingCacheTable}(updated_at);`);
	let ftsAvailable = false;
	let ftsError;
	if (params.ftsEnabled) try {
		params.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${params.ftsTable} USING fts5(\n  text,\n  id UNINDEXED,\n  path UNINDEXED,\n  source UNINDEXED,\n  model UNINDEXED,\n  start_line UNINDEXED,\n  end_line UNINDEXED\n);`);
		ftsAvailable = true;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		ftsAvailable = false;
		ftsError = message;
	}
	ensureColumn(params.db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
	ensureColumn(params.db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
	params.db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);
	return {
		ftsAvailable,
		...ftsError ? { ftsError } : {}
	};
}
function ensureColumn(db, table, column, definition) {
	if (db.prepare(`PRAGMA table_info(${table})`).all().some((row) => row.name === column)) return;
	db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

//#endregion
//#region src/memory/sqlite-vec.ts
async function loadSqliteVecExtension(params) {
	try {
		const sqliteVec = await import("sqlite-vec");
		const resolvedPath = params.extensionPath?.trim() ? params.extensionPath.trim() : void 0;
		const extensionPath = resolvedPath ?? sqliteVec.getLoadablePath();
		params.db.enableLoadExtension(true);
		if (resolvedPath) params.db.loadExtension(extensionPath);
		else sqliteVec.load(params.db);
		return {
			ok: true,
			extensionPath
		};
	} catch (err) {
		return {
			ok: false,
			error: err instanceof Error ? err.message : String(err)
		};
	}
}

//#endregion
//#region src/memory/manager-sync-ops.ts
const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE$2 = "chunks_vec";
const FTS_TABLE$2 = "chunks_fts";
const EMBEDDING_CACHE_TABLE$2 = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5e3;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const VECTOR_LOAD_TIMEOUT_MS = 3e4;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
	".git",
	"node_modules",
	".pnpm-store",
	".venv",
	"venv",
	".tox",
	"__pycache__"
]);
const log$2 = createSubsystemLogger("memory");
function shouldIgnoreMemoryWatchPath(watchPath) {
	return path.normalize(watchPath).split(path.sep).map((segment) => segment.trim().toLowerCase()).some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}
var MemoryManagerSyncOps = class {
	constructor() {
		this.provider = null;
		this.sources = /* @__PURE__ */ new Set();
		this.providerKey = null;
		this.fts = {
			enabled: false,
			available: false
		};
		this.vectorReady = null;
		this.watcher = null;
		this.watchTimer = null;
		this.sessionWatchTimer = null;
		this.sessionUnsubscribe = null;
		this.intervalTimer = null;
		this.closed = false;
		this.dirty = false;
		this.sessionsDirty = false;
		this.sessionsDirtyFiles = /* @__PURE__ */ new Set();
		this.sessionPendingFiles = /* @__PURE__ */ new Set();
		this.sessionDeltas = /* @__PURE__ */ new Map();
	}
	async ensureVectorReady(dimensions) {
		if (!this.vector.enabled) return false;
		if (!this.vectorReady) this.vectorReady = this.withTimeout(this.loadVectorExtension(), VECTOR_LOAD_TIMEOUT_MS, `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1e3)}s`);
		let ready = false;
		try {
			ready = await this.vectorReady || false;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.vector.available = false;
			this.vector.loadError = message;
			this.vectorReady = null;
			log$2.warn(`sqlite-vec unavailable: ${message}`);
			return false;
		}
		if (ready && typeof dimensions === "number" && dimensions > 0) this.ensureVectorTable(dimensions);
		return ready;
	}
	async loadVectorExtension() {
		if (this.vector.available !== null) return this.vector.available;
		if (!this.vector.enabled) {
			this.vector.available = false;
			return false;
		}
		try {
			const resolvedPath = this.vector.extensionPath?.trim() ? resolveUserPath(this.vector.extensionPath) : void 0;
			const loaded = await loadSqliteVecExtension({
				db: this.db,
				extensionPath: resolvedPath
			});
			if (!loaded.ok) throw new Error(loaded.error ?? "unknown sqlite-vec load error");
			this.vector.extensionPath = loaded.extensionPath;
			this.vector.available = true;
			return true;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.vector.available = false;
			this.vector.loadError = message;
			log$2.warn(`sqlite-vec unavailable: ${message}`);
			return false;
		}
	}
	ensureVectorTable(dimensions) {
		if (this.vector.dims === dimensions) return;
		if (this.vector.dims && this.vector.dims !== dimensions) this.dropVectorTable();
		this.db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE$2} USING vec0(\n  id TEXT PRIMARY KEY,\n  embedding FLOAT[${dimensions}]\n)`);
		this.vector.dims = dimensions;
	}
	dropVectorTable() {
		try {
			this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE$2}`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			log$2.debug(`Failed to drop ${VECTOR_TABLE$2}: ${message}`);
		}
	}
	buildSourceFilter(alias) {
		const sources = Array.from(this.sources);
		if (sources.length === 0) return {
			sql: "",
			params: []
		};
		return {
			sql: ` AND ${alias ? `${alias}.source` : "source"} IN (${sources.map(() => "?").join(", ")})`,
			params: sources
		};
	}
	openDatabase() {
		const dbPath = resolveUserPath(this.settings.store.path);
		return this.openDatabaseAtPath(dbPath);
	}
	openDatabaseAtPath(dbPath) {
		ensureDir(path.dirname(dbPath));
		const { DatabaseSync } = requireNodeSqlite();
		return new DatabaseSync(dbPath, { allowExtension: this.settings.store.vector.enabled });
	}
	seedEmbeddingCache(sourceDb) {
		if (!this.cache.enabled) return;
		try {
			const rows = sourceDb.prepare(`SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE$2}`).all();
			if (!rows.length) return;
			const insert = this.db.prepare(`INSERT INTO ${EMBEDDING_CACHE_TABLE$2} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
           embedding=excluded.embedding,
           dims=excluded.dims,
           updated_at=excluded.updated_at`);
			this.db.exec("BEGIN");
			for (const row of rows) insert.run(row.provider, row.model, row.provider_key, row.hash, row.embedding, row.dims, row.updated_at);
			this.db.exec("COMMIT");
		} catch (err) {
			try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw err;
		}
	}
	async swapIndexFiles(targetPath, tempPath) {
		const backupPath = `${targetPath}.backup-${randomUUID()}`;
		await this.moveIndexFiles(targetPath, backupPath);
		try {
			await this.moveIndexFiles(tempPath, targetPath);
		} catch (err) {
			await this.moveIndexFiles(backupPath, targetPath);
			throw err;
		}
		await this.removeIndexFiles(backupPath);
	}
	async moveIndexFiles(sourceBase, targetBase) {
		for (const suffix of [
			"",
			"-wal",
			"-shm"
		]) {
			const source = `${sourceBase}${suffix}`;
			const target = `${targetBase}${suffix}`;
			try {
				await fs.rename(source, target);
			} catch (err) {
				if (err.code !== "ENOENT") throw err;
			}
		}
	}
	async removeIndexFiles(basePath) {
		await Promise.all([
			"",
			"-wal",
			"-shm"
		].map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
	}
	ensureSchema() {
		const result = ensureMemoryIndexSchema({
			db: this.db,
			embeddingCacheTable: EMBEDDING_CACHE_TABLE$2,
			ftsTable: FTS_TABLE$2,
			ftsEnabled: this.fts.enabled
		});
		this.fts.available = result.ftsAvailable;
		if (result.ftsError) {
			this.fts.loadError = result.ftsError;
			log$2.warn(`fts unavailable: ${result.ftsError}`);
		}
	}
	ensureWatcher() {
		if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) return;
		const watchPaths = new Set([
			path.join(this.workspaceDir, "MEMORY.md"),
			path.join(this.workspaceDir, "memory.md"),
			path.join(this.workspaceDir, "memory", "**", "*.md")
		]);
		const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
		for (const entry of additionalPaths) try {
			const stat = syncFs.lstatSync(entry);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				watchPaths.add(path.join(entry, "**", "*.md"));
				continue;
			}
			if (stat.isFile() && entry.toLowerCase().endsWith(".md")) watchPaths.add(entry);
		} catch {}
		this.watcher = chokidar.watch(Array.from(watchPaths), {
			ignoreInitial: true,
			ignored: (watchPath) => shouldIgnoreMemoryWatchPath(String(watchPath)),
			awaitWriteFinish: {
				stabilityThreshold: this.settings.sync.watchDebounceMs,
				pollInterval: 100
			}
		});
		const markDirty = () => {
			this.dirty = true;
			this.scheduleWatchSync();
		};
		this.watcher.on("add", markDirty);
		this.watcher.on("change", markDirty);
		this.watcher.on("unlink", markDirty);
	}
	ensureSessionListener() {
		if (!this.sources.has("sessions") || this.sessionUnsubscribe) return;
		this.sessionUnsubscribe = onSessionTranscriptUpdate((update) => {
			if (this.closed) return;
			const sessionFile = update.sessionFile;
			if (!this.isSessionFileForAgent(sessionFile)) return;
			this.scheduleSessionDirty(sessionFile);
		});
	}
	scheduleSessionDirty(sessionFile) {
		this.sessionPendingFiles.add(sessionFile);
		if (this.sessionWatchTimer) return;
		this.sessionWatchTimer = setTimeout(() => {
			this.sessionWatchTimer = null;
			this.processSessionDeltaBatch().catch((err) => {
				log$2.warn(`memory session delta failed: ${String(err)}`);
			});
		}, SESSION_DIRTY_DEBOUNCE_MS);
	}
	async processSessionDeltaBatch() {
		if (this.sessionPendingFiles.size === 0) return;
		const pending = Array.from(this.sessionPendingFiles);
		this.sessionPendingFiles.clear();
		let shouldSync = false;
		for (const sessionFile of pending) {
			const delta = await this.updateSessionDelta(sessionFile);
			if (!delta) continue;
			const bytesThreshold = delta.deltaBytes;
			const messagesThreshold = delta.deltaMessages;
			const bytesHit = bytesThreshold <= 0 ? delta.pendingBytes > 0 : delta.pendingBytes >= bytesThreshold;
			const messagesHit = messagesThreshold <= 0 ? delta.pendingMessages > 0 : delta.pendingMessages >= messagesThreshold;
			if (!bytesHit && !messagesHit) continue;
			this.sessionsDirtyFiles.add(sessionFile);
			this.sessionsDirty = true;
			delta.pendingBytes = bytesThreshold > 0 ? Math.max(0, delta.pendingBytes - bytesThreshold) : 0;
			delta.pendingMessages = messagesThreshold > 0 ? Math.max(0, delta.pendingMessages - messagesThreshold) : 0;
			shouldSync = true;
		}
		if (shouldSync) this.sync({ reason: "session-delta" }).catch((err) => {
			log$2.warn(`memory sync failed (session-delta): ${String(err)}`);
		});
	}
	async updateSessionDelta(sessionFile) {
		const thresholds = this.settings.sync.sessions;
		if (!thresholds) return null;
		let stat;
		try {
			stat = await fs.stat(sessionFile);
		} catch {
			return null;
		}
		const size = stat.size;
		let state = this.sessionDeltas.get(sessionFile);
		if (!state) {
			state = {
				lastSize: 0,
				pendingBytes: 0,
				pendingMessages: 0
			};
			this.sessionDeltas.set(sessionFile, state);
		}
		const deltaBytes = Math.max(0, size - state.lastSize);
		if (deltaBytes === 0 && size === state.lastSize) return {
			deltaBytes: thresholds.deltaBytes,
			deltaMessages: thresholds.deltaMessages,
			pendingBytes: state.pendingBytes,
			pendingMessages: state.pendingMessages
		};
		if (size < state.lastSize) {
			state.lastSize = size;
			state.pendingBytes += size;
			if (thresholds.deltaMessages > 0 && (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes)) state.pendingMessages += await this.countNewlines(sessionFile, 0, size);
		} else {
			state.pendingBytes += deltaBytes;
			if (thresholds.deltaMessages > 0 && (thresholds.deltaBytes <= 0 || state.pendingBytes < thresholds.deltaBytes)) state.pendingMessages += await this.countNewlines(sessionFile, state.lastSize, size);
			state.lastSize = size;
		}
		this.sessionDeltas.set(sessionFile, state);
		return {
			deltaBytes: thresholds.deltaBytes,
			deltaMessages: thresholds.deltaMessages,
			pendingBytes: state.pendingBytes,
			pendingMessages: state.pendingMessages
		};
	}
	async countNewlines(absPath, start, end) {
		if (end <= start) return 0;
		let handle;
		try {
			handle = await fs.open(absPath, "r");
		} catch (err) {
			if (isFileMissingError(err)) return 0;
			throw err;
		}
		try {
			let offset = start;
			let count = 0;
			const buffer = Buffer.alloc(SESSION_DELTA_READ_CHUNK_BYTES);
			while (offset < end) {
				const toRead = Math.min(buffer.length, end - offset);
				const { bytesRead } = await handle.read(buffer, 0, toRead, offset);
				if (bytesRead <= 0) break;
				for (let i = 0; i < bytesRead; i += 1) if (buffer[i] === 10) count += 1;
				offset += bytesRead;
			}
			return count;
		} finally {
			await handle.close();
		}
	}
	resetSessionDelta(absPath, size) {
		const state = this.sessionDeltas.get(absPath);
		if (!state) return;
		state.lastSize = size;
		state.pendingBytes = 0;
		state.pendingMessages = 0;
	}
	isSessionFileForAgent(sessionFile) {
		if (!sessionFile) return false;
		const sessionsDir = resolveSessionTranscriptsDirForAgent(this.agentId);
		const resolvedFile = path.resolve(sessionFile);
		const resolvedDir = path.resolve(sessionsDir);
		return resolvedFile.startsWith(`${resolvedDir}${path.sep}`);
	}
	ensureIntervalSync() {
		const minutes = this.settings.sync.intervalMinutes;
		if (!minutes || minutes <= 0 || this.intervalTimer) return;
		const ms = minutes * 60 * 1e3;
		this.intervalTimer = setInterval(() => {
			this.sync({ reason: "interval" }).catch((err) => {
				log$2.warn(`memory sync failed (interval): ${String(err)}`);
			});
		}, ms);
	}
	scheduleWatchSync() {
		if (!this.sources.has("memory") || !this.settings.sync.watch) return;
		if (this.watchTimer) clearTimeout(this.watchTimer);
		this.watchTimer = setTimeout(() => {
			this.watchTimer = null;
			this.sync({ reason: "watch" }).catch((err) => {
				log$2.warn(`memory sync failed (watch): ${String(err)}`);
			});
		}, this.settings.sync.watchDebounceMs);
	}
	shouldSyncSessions(params, needsFullReindex = false) {
		if (!this.sources.has("sessions")) return false;
		if (params?.force) return true;
		const reason = params?.reason;
		if (reason === "session-start" || reason === "watch") return false;
		if (needsFullReindex) return true;
		return this.sessionsDirty && this.sessionsDirtyFiles.size > 0;
	}
	async syncMemoryFiles(params) {
		if (!this.provider) {
			log$2.debug("Skipping memory file sync in FTS-only mode (no embedding provider)");
			return;
		}
		const files = await listMemoryFiles(this.workspaceDir, this.settings.extraPaths);
		const fileEntries = (await Promise.all(files.map(async (file) => buildFileEntry(file, this.workspaceDir)))).filter((entry) => entry !== null);
		log$2.debug("memory sync: indexing memory files", {
			files: fileEntries.length,
			needsFullReindex: params.needsFullReindex,
			batch: this.batch.enabled,
			concurrency: this.getIndexConcurrency()
		});
		const activePaths = new Set(fileEntries.map((entry) => entry.path));
		if (params.progress) {
			params.progress.total += fileEntries.length;
			params.progress.report({
				completed: params.progress.completed,
				total: params.progress.total,
				label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files…"
			});
		}
		await runWithConcurrency(fileEntries.map((entry) => async () => {
			const record = this.db.prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`).get(entry.path, "memory");
			if (!params.needsFullReindex && record?.hash === entry.hash) {
				if (params.progress) {
					params.progress.completed += 1;
					params.progress.report({
						completed: params.progress.completed,
						total: params.progress.total
					});
				}
				return;
			}
			await this.indexFile(entry, { source: "memory" });
			if (params.progress) {
				params.progress.completed += 1;
				params.progress.report({
					completed: params.progress.completed,
					total: params.progress.total
				});
			}
		}), this.getIndexConcurrency());
		const staleRows = this.db.prepare(`SELECT path FROM files WHERE source = ?`).all("memory");
		for (const stale of staleRows) {
			if (activePaths.has(stale.path)) continue;
			this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "memory");
			try {
				this.db.prepare(`DELETE FROM ${VECTOR_TABLE$2} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`).run(stale.path, "memory");
			} catch {}
			this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "memory");
			if (this.fts.enabled && this.fts.available) try {
				this.db.prepare(`DELETE FROM ${FTS_TABLE$2} WHERE path = ? AND source = ? AND model = ?`).run(stale.path, "memory", this.provider.model);
			} catch {}
		}
	}
	async syncSessionFiles(params) {
		if (!this.provider) {
			log$2.debug("Skipping session file sync in FTS-only mode (no embedding provider)");
			return;
		}
		const files = await listSessionFilesForAgent(this.agentId);
		const activePaths = new Set(files.map((file) => sessionPathForFile(file)));
		const indexAll = params.needsFullReindex || this.sessionsDirtyFiles.size === 0;
		log$2.debug("memory sync: indexing session files", {
			files: files.length,
			indexAll,
			dirtyFiles: this.sessionsDirtyFiles.size,
			batch: this.batch.enabled,
			concurrency: this.getIndexConcurrency()
		});
		if (params.progress) {
			params.progress.total += files.length;
			params.progress.report({
				completed: params.progress.completed,
				total: params.progress.total,
				label: this.batch.enabled ? "Indexing session files (batch)..." : "Indexing session files…"
			});
		}
		await runWithConcurrency(files.map((absPath) => async () => {
			if (!indexAll && !this.sessionsDirtyFiles.has(absPath)) {
				if (params.progress) {
					params.progress.completed += 1;
					params.progress.report({
						completed: params.progress.completed,
						total: params.progress.total
					});
				}
				return;
			}
			const entry = await buildSessionEntry(absPath);
			if (!entry) {
				if (params.progress) {
					params.progress.completed += 1;
					params.progress.report({
						completed: params.progress.completed,
						total: params.progress.total
					});
				}
				return;
			}
			const record = this.db.prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`).get(entry.path, "sessions");
			if (!params.needsFullReindex && record?.hash === entry.hash) {
				if (params.progress) {
					params.progress.completed += 1;
					params.progress.report({
						completed: params.progress.completed,
						total: params.progress.total
					});
				}
				this.resetSessionDelta(absPath, entry.size);
				return;
			}
			await this.indexFile(entry, {
				source: "sessions",
				content: entry.content
			});
			this.resetSessionDelta(absPath, entry.size);
			if (params.progress) {
				params.progress.completed += 1;
				params.progress.report({
					completed: params.progress.completed,
					total: params.progress.total
				});
			}
		}), this.getIndexConcurrency());
		const staleRows = this.db.prepare(`SELECT path FROM files WHERE source = ?`).all("sessions");
		for (const stale of staleRows) {
			if (activePaths.has(stale.path)) continue;
			this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "sessions");
			try {
				this.db.prepare(`DELETE FROM ${VECTOR_TABLE$2} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`).run(stale.path, "sessions");
			} catch {}
			this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "sessions");
			if (this.fts.enabled && this.fts.available) try {
				this.db.prepare(`DELETE FROM ${FTS_TABLE$2} WHERE path = ? AND source = ? AND model = ?`).run(stale.path, "sessions", this.provider.model);
			} catch {}
		}
	}
	createSyncProgress(onProgress) {
		const state = {
			completed: 0,
			total: 0,
			label: void 0,
			report: (update) => {
				if (update.label) state.label = update.label;
				const label = update.total > 0 && state.label ? `${state.label} ${update.completed}/${update.total}` : state.label;
				onProgress({
					completed: update.completed,
					total: update.total,
					label
				});
			}
		};
		return state;
	}
	async runSync(params) {
		const progress = params?.progress ? this.createSyncProgress(params.progress) : void 0;
		if (progress) progress.report({
			completed: progress.completed,
			total: progress.total,
			label: "Loading vector extension…"
		});
		const vectorReady = await this.ensureVectorReady();
		const meta = this.readMeta();
		const configuredSources = this.resolveConfiguredSourcesForMeta();
		const needsFullReindex = params?.force || !meta || this.provider && meta.model !== this.provider.model || this.provider && meta.provider !== this.provider.id || meta.providerKey !== this.providerKey || this.metaSourcesDiffer(meta, configuredSources) || meta.chunkTokens !== this.settings.chunking.tokens || meta.chunkOverlap !== this.settings.chunking.overlap || vectorReady && !meta?.vectorDims;
		try {
			if (needsFullReindex) {
				if (process.env.OPENCLAW_TEST_FAST === "1" && process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1") await this.runUnsafeReindex({
					reason: params?.reason,
					force: params?.force,
					progress: progress ?? void 0
				});
				else await this.runSafeReindex({
					reason: params?.reason,
					force: params?.force,
					progress: progress ?? void 0
				});
				return;
			}
			const shouldSyncMemory = this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);
			const shouldSyncSessions = this.shouldSyncSessions(params, needsFullReindex);
			if (shouldSyncMemory) {
				await this.syncMemoryFiles({
					needsFullReindex,
					progress: progress ?? void 0
				});
				this.dirty = false;
			}
			if (shouldSyncSessions) {
				await this.syncSessionFiles({
					needsFullReindex,
					progress: progress ?? void 0
				});
				this.sessionsDirty = false;
				this.sessionsDirtyFiles.clear();
			} else if (this.sessionsDirtyFiles.size > 0) this.sessionsDirty = true;
			else this.sessionsDirty = false;
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			if (this.shouldFallbackOnError(reason) && await this.activateFallbackProvider(reason)) {
				await this.runSafeReindex({
					reason: params?.reason ?? "fallback",
					force: true,
					progress: progress ?? void 0
				});
				return;
			}
			throw err;
		}
	}
	shouldFallbackOnError(message) {
		return /embedding|embeddings|batch/i.test(message);
	}
	resolveBatchConfig() {
		const batch = this.settings.remote?.batch;
		return {
			enabled: Boolean(batch?.enabled && this.provider && (this.openAi && this.provider.id === "openai" || this.gemini && this.provider.id === "gemini" || this.voyage && this.provider.id === "voyage")),
			wait: batch?.wait ?? true,
			concurrency: Math.max(1, batch?.concurrency ?? 2),
			pollIntervalMs: batch?.pollIntervalMs ?? 2e3,
			timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1e3
		};
	}
	async activateFallbackProvider(reason) {
		const fallback = this.settings.fallback;
		if (!fallback || fallback === "none" || !this.provider || fallback === this.provider.id) return false;
		if (this.fallbackFrom) return false;
		const fallbackFrom = this.provider.id;
		const fallbackModel = fallback === "gemini" ? DEFAULT_GEMINI_EMBEDDING_MODEL : fallback === "openai" ? DEFAULT_OPENAI_EMBEDDING_MODEL : fallback === "voyage" ? DEFAULT_VOYAGE_EMBEDDING_MODEL : fallback === "mistral" ? DEFAULT_MISTRAL_EMBEDDING_MODEL : this.settings.model;
		const fallbackResult = await createEmbeddingProvider({
			config: this.cfg,
			agentDir: resolveAgentDir(this.cfg, this.agentId),
			provider: fallback,
			remote: this.settings.remote,
			model: fallbackModel,
			fallback: "none",
			local: this.settings.local
		});
		this.fallbackFrom = fallbackFrom;
		this.fallbackReason = reason;
		this.provider = fallbackResult.provider;
		this.openAi = fallbackResult.openAi;
		this.gemini = fallbackResult.gemini;
		this.voyage = fallbackResult.voyage;
		this.mistral = fallbackResult.mistral;
		this.providerKey = this.computeProviderKey();
		this.batch = this.resolveBatchConfig();
		log$2.warn(`memory embeddings: switched to fallback provider (${fallback})`, { reason });
		return true;
	}
	async runSafeReindex(params) {
		const dbPath = resolveUserPath(this.settings.store.path);
		const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
		const tempDb = this.openDatabaseAtPath(tempDbPath);
		const originalDb = this.db;
		let originalDbClosed = false;
		const originalState = {
			ftsAvailable: this.fts.available,
			ftsError: this.fts.loadError,
			vectorAvailable: this.vector.available,
			vectorLoadError: this.vector.loadError,
			vectorDims: this.vector.dims,
			vectorReady: this.vectorReady
		};
		const restoreOriginalState = () => {
			if (originalDbClosed) this.db = this.openDatabaseAtPath(dbPath);
			else this.db = originalDb;
			this.fts.available = originalState.ftsAvailable;
			this.fts.loadError = originalState.ftsError;
			this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
			this.vector.loadError = originalState.vectorLoadError;
			this.vector.dims = originalState.vectorDims;
			this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
		};
		this.db = tempDb;
		this.vectorReady = null;
		this.vector.available = null;
		this.vector.loadError = void 0;
		this.vector.dims = void 0;
		this.fts.available = false;
		this.fts.loadError = void 0;
		this.ensureSchema();
		let nextMeta = null;
		try {
			this.seedEmbeddingCache(originalDb);
			const shouldSyncMemory = this.sources.has("memory");
			const shouldSyncSessions = this.shouldSyncSessions({
				reason: params.reason,
				force: params.force
			}, true);
			if (shouldSyncMemory) {
				await this.syncMemoryFiles({
					needsFullReindex: true,
					progress: params.progress
				});
				this.dirty = false;
			}
			if (shouldSyncSessions) {
				await this.syncSessionFiles({
					needsFullReindex: true,
					progress: params.progress
				});
				this.sessionsDirty = false;
				this.sessionsDirtyFiles.clear();
			} else if (this.sessionsDirtyFiles.size > 0) this.sessionsDirty = true;
			else this.sessionsDirty = false;
			nextMeta = {
				model: this.provider?.model ?? "fts-only",
				provider: this.provider?.id ?? "none",
				providerKey: this.providerKey,
				sources: this.resolveConfiguredSourcesForMeta(),
				chunkTokens: this.settings.chunking.tokens,
				chunkOverlap: this.settings.chunking.overlap
			};
			if (!nextMeta) throw new Error("Failed to compute memory index metadata for reindexing.");
			if (this.vector.available && this.vector.dims) nextMeta.vectorDims = this.vector.dims;
			this.writeMeta(nextMeta);
			this.pruneEmbeddingCacheIfNeeded?.();
			this.db.close();
			originalDb.close();
			originalDbClosed = true;
			await this.swapIndexFiles(dbPath, tempDbPath);
			this.db = this.openDatabaseAtPath(dbPath);
			this.vectorReady = null;
			this.vector.available = null;
			this.vector.loadError = void 0;
			this.ensureSchema();
			this.vector.dims = nextMeta?.vectorDims;
		} catch (err) {
			try {
				this.db.close();
			} catch {}
			await this.removeIndexFiles(tempDbPath);
			restoreOriginalState();
			throw err;
		}
	}
	async runUnsafeReindex(params) {
		this.resetIndex();
		const shouldSyncMemory = this.sources.has("memory");
		const shouldSyncSessions = this.shouldSyncSessions({
			reason: params.reason,
			force: params.force
		}, true);
		if (shouldSyncMemory) {
			await this.syncMemoryFiles({
				needsFullReindex: true,
				progress: params.progress
			});
			this.dirty = false;
		}
		if (shouldSyncSessions) {
			await this.syncSessionFiles({
				needsFullReindex: true,
				progress: params.progress
			});
			this.sessionsDirty = false;
			this.sessionsDirtyFiles.clear();
		} else if (this.sessionsDirtyFiles.size > 0) this.sessionsDirty = true;
		else this.sessionsDirty = false;
		const nextMeta = {
			model: this.provider?.model ?? "fts-only",
			provider: this.provider?.id ?? "none",
			providerKey: this.providerKey,
			sources: this.resolveConfiguredSourcesForMeta(),
			chunkTokens: this.settings.chunking.tokens,
			chunkOverlap: this.settings.chunking.overlap
		};
		if (this.vector.available && this.vector.dims) nextMeta.vectorDims = this.vector.dims;
		this.writeMeta(nextMeta);
		this.pruneEmbeddingCacheIfNeeded?.();
	}
	resetIndex() {
		this.db.exec(`DELETE FROM files`);
		this.db.exec(`DELETE FROM chunks`);
		if (this.fts.enabled && this.fts.available) try {
			this.db.exec(`DELETE FROM ${FTS_TABLE$2}`);
		} catch {}
		this.dropVectorTable();
		this.vector.dims = void 0;
		this.sessionsDirtyFiles.clear();
	}
	readMeta() {
		const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
		if (!row?.value) return null;
		try {
			return JSON.parse(row.value);
		} catch {
			return null;
		}
	}
	writeMeta(meta) {
		const value = JSON.stringify(meta);
		this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(META_KEY, value);
	}
	resolveConfiguredSourcesForMeta() {
		const normalized = Array.from(this.sources).filter((source) => source === "memory" || source === "sessions").toSorted();
		return normalized.length > 0 ? normalized : ["memory"];
	}
	normalizeMetaSources(meta) {
		if (!Array.isArray(meta.sources)) return ["memory"];
		const normalized = Array.from(new Set(meta.sources.filter((source) => source === "memory" || source === "sessions"))).toSorted();
		return normalized.length > 0 ? normalized : ["memory"];
	}
	metaSourcesDiffer(meta, configuredSources) {
		const metaSources = this.normalizeMetaSources(meta);
		if (metaSources.length !== configuredSources.length) return true;
		return metaSources.some((source, index) => source !== configuredSources[index]);
	}
};

//#endregion
//#region src/memory/manager-embedding-ops.ts
const VECTOR_TABLE$1 = "chunks_vec";
const FTS_TABLE$1 = "chunks_fts";
const EMBEDDING_CACHE_TABLE$1 = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8e3;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8e3;
const BATCH_FAILURE_LIMIT$1 = 2;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 6e4;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 6e4;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 6e4;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 6e4;
const vectorToBlob$1 = (embedding) => Buffer.from(new Float32Array(embedding).buffer);
const log$1 = createSubsystemLogger("memory");
var MemoryManagerEmbeddingOps = class extends MemoryManagerSyncOps {
	buildEmbeddingBatches(chunks) {
		const batches = [];
		let current = [];
		let currentTokens = 0;
		for (const chunk of chunks) {
			const estimate = estimateUtf8Bytes(chunk.text);
			if (current.length > 0 && currentTokens + estimate > EMBEDDING_BATCH_MAX_TOKENS) {
				batches.push(current);
				current = [];
				currentTokens = 0;
			}
			if (current.length === 0 && estimate > EMBEDDING_BATCH_MAX_TOKENS) {
				batches.push([chunk]);
				continue;
			}
			current.push(chunk);
			currentTokens += estimate;
		}
		if (current.length > 0) batches.push(current);
		return batches;
	}
	loadEmbeddingCache(hashes) {
		if (!this.cache.enabled || !this.provider) return /* @__PURE__ */ new Map();
		if (hashes.length === 0) return /* @__PURE__ */ new Map();
		const unique = [];
		const seen = /* @__PURE__ */ new Set();
		for (const hash of hashes) {
			if (!hash) continue;
			if (seen.has(hash)) continue;
			seen.add(hash);
			unique.push(hash);
		}
		if (unique.length === 0) return /* @__PURE__ */ new Map();
		const out = /* @__PURE__ */ new Map();
		const baseParams = [
			this.provider.id,
			this.provider.model,
			this.providerKey
		];
		const batchSize = 400;
		for (let start = 0; start < unique.length; start += batchSize) {
			const batch = unique.slice(start, start + batchSize);
			const placeholders = batch.map(() => "?").join(", ");
			const rows = this.db.prepare(`SELECT hash, embedding FROM ${EMBEDDING_CACHE_TABLE$1}\n WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`).all(...baseParams, ...batch);
			for (const row of rows) out.set(row.hash, parseEmbedding(row.embedding));
		}
		return out;
	}
	upsertEmbeddingCache(entries) {
		if (!this.cache.enabled || !this.provider) return;
		if (entries.length === 0) return;
		const now = Date.now();
		const stmt = this.db.prepare(`INSERT INTO ${EMBEDDING_CACHE_TABLE$1} (provider, model, provider_key, hash, embedding, dims, updated_at)\n VALUES (?, ?, ?, ?, ?, ?, ?)\n ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n   embedding=excluded.embedding,\n   dims=excluded.dims,\n   updated_at=excluded.updated_at`);
		for (const entry of entries) {
			const embedding = entry.embedding ?? [];
			stmt.run(this.provider.id, this.provider.model, this.providerKey, entry.hash, JSON.stringify(embedding), embedding.length, now);
		}
	}
	pruneEmbeddingCacheIfNeeded() {
		if (!this.cache.enabled) return;
		const max = this.cache.maxEntries;
		if (!max || max <= 0) return;
		const count = this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE$1}`).get()?.c ?? 0;
		if (count <= max) return;
		const excess = count - max;
		this.db.prepare(`DELETE FROM ${EMBEDDING_CACHE_TABLE$1}\n WHERE rowid IN (\n   SELECT rowid FROM ${EMBEDDING_CACHE_TABLE$1}\n   ORDER BY updated_at ASC\n   LIMIT ?\n )`).run(excess);
	}
	async embedChunksInBatches(chunks) {
		if (chunks.length === 0) return [];
		const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
		if (missing.length === 0) return embeddings;
		const missingChunks = missing.map((m) => m.chunk);
		const batches = this.buildEmbeddingBatches(missingChunks);
		const toCache = [];
		let cursor = 0;
		for (const batch of batches) {
			const batchEmbeddings = await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
			for (let i = 0; i < batch.length; i += 1) {
				const item = missing[cursor + i];
				const embedding = batchEmbeddings[i] ?? [];
				if (item) {
					embeddings[item.index] = embedding;
					toCache.push({
						hash: item.chunk.hash,
						embedding
					});
				}
			}
			cursor += batch.length;
		}
		this.upsertEmbeddingCache(toCache);
		return embeddings;
	}
	computeProviderKey() {
		if (!this.provider) return hashText(JSON.stringify({
			provider: "none",
			model: "fts-only"
		}));
		if (this.provider.id === "openai" && this.openAi) {
			const entries = Object.entries(this.openAi.headers).filter(([key]) => key.toLowerCase() !== "authorization").toSorted(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value]);
			return hashText(JSON.stringify({
				provider: "openai",
				baseUrl: this.openAi.baseUrl,
				model: this.openAi.model,
				headers: entries
			}));
		}
		if (this.provider.id === "gemini" && this.gemini) {
			const entries = Object.entries(this.gemini.headers).filter(([key]) => {
				const lower = key.toLowerCase();
				return lower !== "authorization" && lower !== "x-goog-api-key";
			}).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value]);
			return hashText(JSON.stringify({
				provider: "gemini",
				baseUrl: this.gemini.baseUrl,
				model: this.gemini.model,
				headers: entries
			}));
		}
		return hashText(JSON.stringify({
			provider: this.provider.id,
			model: this.provider.model
		}));
	}
	async embedChunksWithBatch(chunks, entry, source) {
		if (!this.provider) return this.embedChunksInBatches(chunks);
		if (this.provider.id === "openai" && this.openAi) return this.embedChunksWithOpenAiBatch(chunks, entry, source);
		if (this.provider.id === "gemini" && this.gemini) return this.embedChunksWithGeminiBatch(chunks, entry, source);
		if (this.provider.id === "voyage" && this.voyage) return this.embedChunksWithVoyageBatch(chunks, entry, source);
		return this.embedChunksInBatches(chunks);
	}
	collectCachedEmbeddings(chunks) {
		const cached = this.loadEmbeddingCache(chunks.map((chunk) => chunk.hash));
		const embeddings = Array.from({ length: chunks.length }, () => []);
		const missing = [];
		for (let i = 0; i < chunks.length; i += 1) {
			const chunk = chunks[i];
			const hit = chunk?.hash ? cached.get(chunk.hash) : void 0;
			if (hit && hit.length > 0) embeddings[i] = hit;
			else if (chunk) missing.push({
				index: i,
				chunk
			});
		}
		return {
			embeddings,
			missing
		};
	}
	buildBatchCustomId(params) {
		return hashText(`${params.source}:${params.entry.path}:${params.chunk.startLine}:${params.chunk.endLine}:${params.chunk.hash}:${params.index}`);
	}
	buildBatchRequests(params) {
		const requests = [];
		const mapping = /* @__PURE__ */ new Map();
		for (const item of params.missing) {
			const chunk = item.chunk;
			const customId = this.buildBatchCustomId({
				source: params.source,
				entry: params.entry,
				chunk,
				index: item.index
			});
			mapping.set(customId, {
				index: item.index,
				hash: chunk.hash
			});
			const built = params.build(chunk);
			requests.push({
				custom_id: customId,
				...built
			});
		}
		return {
			requests,
			mapping
		};
	}
	applyBatchEmbeddings(params) {
		const toCache = [];
		for (const [customId, embedding] of params.byCustomId.entries()) {
			const mapped = params.mapping.get(customId);
			if (!mapped) continue;
			params.embeddings[mapped.index] = embedding;
			toCache.push({
				hash: mapped.hash,
				embedding
			});
		}
		this.upsertEmbeddingCache(toCache);
	}
	buildEmbeddingBatchRunnerOptions(params) {
		const { requests, chunks, source } = params;
		return {
			agentId: this.agentId,
			requests,
			wait: this.batch.wait,
			concurrency: this.batch.concurrency,
			pollIntervalMs: this.batch.pollIntervalMs,
			timeoutMs: this.batch.timeoutMs,
			debug: (message, data) => log$1.debug(message, data ? {
				...data,
				source,
				chunks: chunks.length
			} : {
				source,
				chunks: chunks.length
			})
		};
	}
	async embedChunksWithProviderBatch(params) {
		if (!params.enabled) return this.embedChunksInBatches(params.chunks);
		if (params.chunks.length === 0) return [];
		const { embeddings, missing } = this.collectCachedEmbeddings(params.chunks);
		if (missing.length === 0) return embeddings;
		const { requests, mapping } = this.buildBatchRequests({
			missing,
			entry: params.entry,
			source: params.source,
			build: params.buildRequest
		});
		const runnerOptions = this.buildEmbeddingBatchRunnerOptions({
			requests,
			chunks: params.chunks,
			source: params.source
		});
		const batchResult = await this.runBatchWithFallback({
			provider: params.provider,
			run: async () => await params.runBatch(runnerOptions),
			fallback: async () => await this.embedChunksInBatches(params.chunks)
		});
		if (Array.isArray(batchResult)) return batchResult;
		this.applyBatchEmbeddings({
			byCustomId: batchResult,
			mapping,
			embeddings
		});
		return embeddings;
	}
	async embedChunksWithVoyageBatch(chunks, entry, source) {
		const voyage = this.voyage;
		return await this.embedChunksWithProviderBatch({
			chunks,
			entry,
			source,
			provider: "voyage",
			enabled: Boolean(voyage),
			buildRequest: (chunk) => ({ body: { input: chunk.text } }),
			runBatch: async (runnerOptions) => await runVoyageEmbeddingBatches({
				client: voyage,
				...runnerOptions
			})
		});
	}
	async embedChunksWithOpenAiBatch(chunks, entry, source) {
		const openAi = this.openAi;
		return await this.embedChunksWithProviderBatch({
			chunks,
			entry,
			source,
			provider: "openai",
			enabled: Boolean(openAi),
			buildRequest: (chunk) => ({
				method: "POST",
				url: OPENAI_BATCH_ENDPOINT,
				body: {
					model: openAi?.model ?? this.provider?.model ?? "text-embedding-3-small",
					input: chunk.text
				}
			}),
			runBatch: async (runnerOptions) => await runOpenAiEmbeddingBatches({
				openAi,
				...runnerOptions
			})
		});
	}
	async embedChunksWithGeminiBatch(chunks, entry, source) {
		const gemini = this.gemini;
		return await this.embedChunksWithProviderBatch({
			chunks,
			entry,
			source,
			provider: "gemini",
			enabled: Boolean(gemini),
			buildRequest: (chunk) => ({
				content: { parts: [{ text: chunk.text }] },
				taskType: "RETRIEVAL_DOCUMENT"
			}),
			runBatch: async (runnerOptions) => await runGeminiEmbeddingBatches({
				gemini,
				...runnerOptions
			})
		});
	}
	async embedBatchWithRetry(texts) {
		if (texts.length === 0) return [];
		if (!this.provider) throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
		let attempt = 0;
		let delayMs = EMBEDDING_RETRY_BASE_DELAY_MS;
		while (true) try {
			const timeoutMs = this.resolveEmbeddingTimeout("batch");
			log$1.debug("memory embeddings: batch start", {
				provider: this.provider.id,
				items: texts.length,
				timeoutMs
			});
			return await this.withTimeout(this.provider.embedBatch(texts), timeoutMs, `memory embeddings batch timed out after ${Math.round(timeoutMs / 1e3)}s`);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (!this.isRetryableEmbeddingError(message) || attempt >= EMBEDDING_RETRY_MAX_ATTEMPTS) throw err;
			const waitMs = Math.min(EMBEDDING_RETRY_MAX_DELAY_MS, Math.round(delayMs * (1 + Math.random() * .2)));
			log$1.warn(`memory embeddings rate limited; retrying in ${waitMs}ms`);
			await new Promise((resolve) => setTimeout(resolve, waitMs));
			delayMs *= 2;
			attempt += 1;
		}
	}
	isRetryableEmbeddingError(message) {
		return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare)/i.test(message);
	}
	resolveEmbeddingTimeout(kind) {
		const isLocal = this.provider?.id === "local";
		if (kind === "query") return isLocal ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
		return isLocal ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
	}
	async embedQueryWithTimeout(text) {
		if (!this.provider) throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
		const timeoutMs = this.resolveEmbeddingTimeout("query");
		log$1.debug("memory embeddings: query start", {
			provider: this.provider.id,
			timeoutMs
		});
		return await this.withTimeout(this.provider.embedQuery(text), timeoutMs, `memory embeddings query timed out after ${Math.round(timeoutMs / 1e3)}s`);
	}
	async withTimeout(promise, timeoutMs, message) {
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return await promise;
		let timer = null;
		const timeoutPromise = new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error(message)), timeoutMs);
		});
		try {
			return await Promise.race([promise, timeoutPromise]);
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async withBatchFailureLock(fn) {
		let release;
		const wait = this.batchFailureLock;
		this.batchFailureLock = new Promise((resolve) => {
			release = resolve;
		});
		await wait;
		try {
			return await fn();
		} finally {
			release();
		}
	}
	async resetBatchFailureCount() {
		await this.withBatchFailureLock(async () => {
			if (this.batchFailureCount > 0) log$1.debug("memory embeddings: batch recovered; resetting failure count");
			this.batchFailureCount = 0;
			this.batchFailureLastError = void 0;
			this.batchFailureLastProvider = void 0;
		});
	}
	async recordBatchFailure(params) {
		return await this.withBatchFailureLock(async () => {
			if (!this.batch.enabled) return {
				disabled: true,
				count: this.batchFailureCount
			};
			const increment = params.forceDisable ? BATCH_FAILURE_LIMIT$1 : Math.max(1, params.attempts ?? 1);
			this.batchFailureCount += increment;
			this.batchFailureLastError = params.message;
			this.batchFailureLastProvider = params.provider;
			const disabled = params.forceDisable || this.batchFailureCount >= BATCH_FAILURE_LIMIT$1;
			if (disabled) this.batch.enabled = false;
			return {
				disabled,
				count: this.batchFailureCount
			};
		});
	}
	isBatchTimeoutError(message) {
		return /timed out|timeout/i.test(message);
	}
	async runBatchWithTimeoutRetry(params) {
		try {
			return await params.run();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (this.isBatchTimeoutError(message)) {
				log$1.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
				try {
					return await params.run();
				} catch (retryErr) {
					retryErr.batchAttempts = 2;
					throw retryErr;
				}
			}
			throw err;
		}
	}
	async runBatchWithFallback(params) {
		if (!this.batch.enabled) return await params.fallback();
		try {
			const result = await this.runBatchWithTimeoutRetry({
				provider: params.provider,
				run: params.run
			});
			await this.resetBatchFailureCount();
			return result;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			const attempts = err.batchAttempts ?? 1;
			const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
			const failure = await this.recordBatchFailure({
				provider: params.provider,
				message,
				attempts,
				forceDisable
			});
			const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
			log$1.warn(`memory embeddings: ${params.provider} batch failed (${failure.count}/${BATCH_FAILURE_LIMIT$1}); ${suffix}; falling back to non-batch embeddings: ${message}`);
			return await params.fallback();
		}
	}
	getIndexConcurrency() {
		return this.batch.enabled ? this.batch.concurrency : EMBEDDING_INDEX_CONCURRENCY;
	}
	async indexFile(entry, options) {
		if (!this.provider) {
			log$1.debug("Skipping embedding indexing in FTS-only mode", {
				path: entry.path,
				source: options.source
			});
			return;
		}
		const content = options.content ?? await fs.readFile(entry.absPath, "utf-8");
		const chunks = enforceEmbeddingMaxInputTokens(this.provider, chunkMarkdown(content, this.settings.chunking).filter((chunk) => chunk.text.trim().length > 0), EMBEDDING_BATCH_MAX_TOKENS);
		if (options.source === "sessions" && "lineMap" in entry) remapChunkLines(chunks, entry.lineMap);
		const embeddings = this.batch.enabled ? await this.embedChunksWithBatch(chunks, entry, options.source) : await this.embedChunksInBatches(chunks);
		const sample = embeddings.find((embedding) => embedding.length > 0);
		const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
		const now = Date.now();
		if (vectorReady) try {
			this.db.prepare(`DELETE FROM ${VECTOR_TABLE$1} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`).run(entry.path, options.source);
		} catch {}
		if (this.fts.enabled && this.fts.available) try {
			this.db.prepare(`DELETE FROM ${FTS_TABLE$1} WHERE path = ? AND source = ? AND model = ?`).run(entry.path, options.source, this.provider.model);
		} catch {}
		this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(entry.path, options.source);
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddings[i] ?? [];
			const id = hashText(`${options.source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${this.provider.model}`);
			this.db.prepare(`INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at`).run(id, entry.path, options.source, chunk.startLine, chunk.endLine, chunk.hash, this.provider.model, chunk.text, JSON.stringify(embedding), now);
			if (vectorReady && embedding.length > 0) {
				try {
					this.db.prepare(`DELETE FROM ${VECTOR_TABLE$1} WHERE id = ?`).run(id);
				} catch {}
				this.db.prepare(`INSERT INTO ${VECTOR_TABLE$1} (id, embedding) VALUES (?, ?)`).run(id, vectorToBlob$1(embedding));
			}
			if (this.fts.enabled && this.fts.available) this.db.prepare(`INSERT INTO ${FTS_TABLE$1} (text, id, path, source, model, start_line, end_line)\n VALUES (?, ?, ?, ?, ?, ?, ?)`).run(chunk.text, id, entry.path, options.source, this.provider.model, chunk.startLine, chunk.endLine);
		}
		this.db.prepare(`INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`).run(entry.path, options.source, entry.hash, entry.mtimeMs, entry.size);
	}
};

//#endregion
//#region src/memory/manager-search.ts
const vectorToBlob = (embedding) => Buffer.from(new Float32Array(embedding).buffer);
async function searchVector(params) {
	if (params.queryVec.length === 0 || params.limit <= 0) return [];
	if (await params.ensureVectorReady(params.queryVec.length)) return params.db.prepare(`SELECT c.id, c.path, c.start_line, c.end_line, c.text,
       c.source,
       vec_distance_cosine(v.embedding, ?) AS dist
  FROM ${params.vectorTable} v\n  JOIN chunks c ON c.id = v.id\n WHERE c.model = ?${params.sourceFilterVec.sql}\n ORDER BY dist ASC\n LIMIT ?`).all(vectorToBlob(params.queryVec), params.providerModel, ...params.sourceFilterVec.params, params.limit).map((row) => ({
		id: row.id,
		path: row.path,
		startLine: row.start_line,
		endLine: row.end_line,
		score: 1 - row.dist,
		snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
		source: row.source
	}));
	return listChunks({
		db: params.db,
		providerModel: params.providerModel,
		sourceFilter: params.sourceFilterChunks
	}).map((chunk) => ({
		chunk,
		score: cosineSimilarity(params.queryVec, chunk.embedding)
	})).filter((entry) => Number.isFinite(entry.score)).toSorted((a, b) => b.score - a.score).slice(0, params.limit).map((entry) => ({
		id: entry.chunk.id,
		path: entry.chunk.path,
		startLine: entry.chunk.startLine,
		endLine: entry.chunk.endLine,
		score: entry.score,
		snippet: truncateUtf16Safe(entry.chunk.text, params.snippetMaxChars),
		source: entry.chunk.source
	}));
}
function listChunks(params) {
	return params.db.prepare(`SELECT id, path, start_line, end_line, text, embedding, source
  FROM chunks
 WHERE model = ?${params.sourceFilter.sql}`).all(params.providerModel, ...params.sourceFilter.params).map((row) => ({
		id: row.id,
		path: row.path,
		startLine: row.start_line,
		endLine: row.end_line,
		text: row.text,
		embedding: parseEmbedding(row.embedding),
		source: row.source
	}));
}
async function searchKeyword(params) {
	if (params.limit <= 0) return [];
	const ftsQuery = params.buildFtsQuery(params.query);
	if (!ftsQuery) return [];
	const modelClause = params.providerModel ? " AND model = ?" : "";
	const modelParams = params.providerModel ? [params.providerModel] : [];
	return params.db.prepare(`SELECT id, path, source, start_line, end_line, text,\n       bm25(${params.ftsTable}) AS rank\n  FROM ${params.ftsTable}\n WHERE ${params.ftsTable} MATCH ?${modelClause}${params.sourceFilter.sql}\n ORDER BY rank ASC\n LIMIT ?`).all(ftsQuery, ...modelParams, ...params.sourceFilter.params, params.limit).map((row) => {
		const textScore = params.bm25RankToScore(row.rank);
		return {
			id: row.id,
			path: row.path,
			startLine: row.start_line,
			endLine: row.end_line,
			score: textScore,
			textScore,
			snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
			source: row.source
		};
	});
}

//#endregion
//#region src/memory/manager.ts
var manager_exports = /* @__PURE__ */ __exportAll({ MemoryIndexManager: () => MemoryIndexManager });
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const BATCH_FAILURE_LIMIT = 2;
const log = createSubsystemLogger("memory");
const INDEX_CACHE = /* @__PURE__ */ new Map();
const INDEX_CACHE_PENDING = /* @__PURE__ */ new Map();
var MemoryIndexManager = class MemoryIndexManager extends MemoryManagerEmbeddingOps {
	static async get(params) {
		const { cfg, agentId } = params;
		const settings = resolveMemorySearchConfig(cfg, agentId);
		if (!settings) return null;
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}`;
		const existing = INDEX_CACHE.get(key);
		if (existing) return existing;
		const pending = INDEX_CACHE_PENDING.get(key);
		if (pending) return pending;
		const createPromise = (async () => {
			const providerResult = await createEmbeddingProvider({
				config: cfg,
				agentDir: resolveAgentDir(cfg, agentId),
				provider: settings.provider,
				remote: settings.remote,
				model: settings.model,
				fallback: settings.fallback,
				local: settings.local
			});
			const refreshed = INDEX_CACHE.get(key);
			if (refreshed) return refreshed;
			const manager = new MemoryIndexManager({
				cacheKey: key,
				cfg,
				agentId,
				workspaceDir,
				settings,
				providerResult,
				purpose: params.purpose
			});
			INDEX_CACHE.set(key, manager);
			return manager;
		})();
		INDEX_CACHE_PENDING.set(key, createPromise);
		try {
			return await createPromise;
		} finally {
			if (INDEX_CACHE_PENDING.get(key) === createPromise) INDEX_CACHE_PENDING.delete(key);
		}
	}
	constructor(params) {
		super();
		this.batchFailureCount = 0;
		this.batchFailureLock = Promise.resolve();
		this.vectorReady = null;
		this.watcher = null;
		this.watchTimer = null;
		this.sessionWatchTimer = null;
		this.sessionUnsubscribe = null;
		this.intervalTimer = null;
		this.closed = false;
		this.dirty = false;
		this.sessionsDirty = false;
		this.sessionsDirtyFiles = /* @__PURE__ */ new Set();
		this.sessionPendingFiles = /* @__PURE__ */ new Set();
		this.sessionDeltas = /* @__PURE__ */ new Map();
		this.sessionWarm = /* @__PURE__ */ new Set();
		this.syncing = null;
		this.readonlyRecoveryAttempts = 0;
		this.readonlyRecoverySuccesses = 0;
		this.readonlyRecoveryFailures = 0;
		this.cacheKey = params.cacheKey;
		this.cfg = params.cfg;
		this.agentId = params.agentId;
		this.workspaceDir = params.workspaceDir;
		this.settings = params.settings;
		this.provider = params.providerResult.provider;
		this.requestedProvider = params.providerResult.requestedProvider;
		this.fallbackFrom = params.providerResult.fallbackFrom;
		this.fallbackReason = params.providerResult.fallbackReason;
		this.providerUnavailableReason = params.providerResult.providerUnavailableReason;
		this.openAi = params.providerResult.openAi;
		this.gemini = params.providerResult.gemini;
		this.voyage = params.providerResult.voyage;
		this.mistral = params.providerResult.mistral;
		this.sources = new Set(params.settings.sources);
		this.db = this.openDatabase();
		this.providerKey = this.computeProviderKey();
		this.cache = {
			enabled: params.settings.cache.enabled,
			maxEntries: params.settings.cache.maxEntries
		};
		this.fts = {
			enabled: params.settings.query.hybrid.enabled,
			available: false
		};
		this.ensureSchema();
		this.vector = {
			enabled: params.settings.store.vector.enabled,
			available: null,
			extensionPath: params.settings.store.vector.extensionPath
		};
		const meta = this.readMeta();
		if (meta?.vectorDims) this.vector.dims = meta.vectorDims;
		this.ensureWatcher();
		this.ensureSessionListener();
		this.ensureIntervalSync();
		const statusOnly = params.purpose === "status";
		this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);
		this.batch = this.resolveBatchConfig();
	}
	async warmSession(sessionKey) {
		if (!this.settings.sync.onSessionStart) return;
		const key = sessionKey?.trim() || "";
		if (key && this.sessionWarm.has(key)) return;
		this.sync({ reason: "session-start" }).catch((err) => {
			log.warn(`memory sync failed (session-start): ${String(err)}`);
		});
		if (key) this.sessionWarm.add(key);
	}
	async search(query, opts) {
		this.warmSession(opts?.sessionKey);
		if (this.settings.sync.onSearch && (this.dirty || this.sessionsDirty)) this.sync({ reason: "search" }).catch((err) => {
			log.warn(`memory sync failed (search): ${String(err)}`);
		});
		const cleaned = query.trim();
		if (!cleaned) return [];
		const minScore = opts?.minScore ?? this.settings.query.minScore;
		const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
		const hybrid = this.settings.query.hybrid;
		const candidates = Math.min(200, Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)));
		if (!this.provider) {
			if (!this.fts.enabled || !this.fts.available) {
				log.warn("memory search: no provider and FTS unavailable");
				return [];
			}
			const keywords = extractKeywords(cleaned);
			const searchTerms = keywords.length > 0 ? keywords : [cleaned];
			const resultSets = await Promise.all(searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])));
			const seenIds = /* @__PURE__ */ new Map();
			for (const results of resultSets) for (const result of results) {
				const existing = seenIds.get(result.id);
				if (!existing || result.score > existing.score) seenIds.set(result.id, result);
			}
			return [...seenIds.values()].toSorted((a, b) => b.score - a.score).filter((entry) => entry.score >= minScore).slice(0, maxResults);
		}
		const keywordResults = hybrid.enabled ? await this.searchKeyword(cleaned, candidates).catch(() => []) : [];
		const queryVec = await this.embedQueryWithTimeout(cleaned);
		const vectorResults = queryVec.some((v) => v !== 0) ? await this.searchVector(queryVec, candidates).catch(() => []) : [];
		if (!hybrid.enabled) return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
		const merged = await this.mergeHybridResults({
			vector: vectorResults,
			keyword: keywordResults,
			vectorWeight: hybrid.vectorWeight,
			textWeight: hybrid.textWeight,
			mmr: hybrid.mmr,
			temporalDecay: hybrid.temporalDecay
		});
		const strict = merged.filter((entry) => entry.score >= minScore);
		if (strict.length > 0 || keywordResults.length === 0) return strict.slice(0, maxResults);
		const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
		const keywordKeys = new Set(keywordResults.map((entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`));
		return merged.filter((entry) => keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`) && entry.score >= relaxedMinScore).slice(0, maxResults);
	}
	async searchVector(queryVec, limit) {
		if (!this.provider) return [];
		return (await searchVector({
			db: this.db,
			vectorTable: VECTOR_TABLE,
			providerModel: this.provider.model,
			queryVec,
			limit,
			snippetMaxChars: SNIPPET_MAX_CHARS,
			ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
			sourceFilterVec: this.buildSourceFilter("c"),
			sourceFilterChunks: this.buildSourceFilter()
		})).map((entry) => entry);
	}
	buildFtsQuery(raw) {
		return buildFtsQuery(raw);
	}
	async searchKeyword(query, limit) {
		if (!this.fts.enabled || !this.fts.available) return [];
		const sourceFilter = this.buildSourceFilter();
		const providerModel = this.provider?.model;
		return (await searchKeyword({
			db: this.db,
			ftsTable: FTS_TABLE,
			providerModel,
			query,
			limit,
			snippetMaxChars: SNIPPET_MAX_CHARS,
			sourceFilter,
			buildFtsQuery: (raw) => this.buildFtsQuery(raw),
			bm25RankToScore
		})).map((entry) => entry);
	}
	mergeHybridResults(params) {
		return mergeHybridResults({
			vector: params.vector.map((r) => ({
				id: r.id,
				path: r.path,
				startLine: r.startLine,
				endLine: r.endLine,
				source: r.source,
				snippet: r.snippet,
				vectorScore: r.score
			})),
			keyword: params.keyword.map((r) => ({
				id: r.id,
				path: r.path,
				startLine: r.startLine,
				endLine: r.endLine,
				source: r.source,
				snippet: r.snippet,
				textScore: r.textScore
			})),
			vectorWeight: params.vectorWeight,
			textWeight: params.textWeight,
			mmr: params.mmr,
			temporalDecay: params.temporalDecay,
			workspaceDir: this.workspaceDir
		}).then((entries) => entries.map((entry) => entry));
	}
	async sync(params) {
		if (this.closed) return;
		if (this.syncing) return this.syncing;
		this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
			this.syncing = null;
		});
		return this.syncing ?? Promise.resolve();
	}
	isReadonlyDbError(err) {
		const readonlyPattern = /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
		const messages = /* @__PURE__ */ new Set();
		const pushValue = (value) => {
			if (typeof value !== "string") return;
			const normalized = value.trim();
			if (!normalized) return;
			messages.add(normalized);
		};
		pushValue(err instanceof Error ? err.message : String(err));
		if (err && typeof err === "object") {
			const record = err;
			pushValue(record.message);
			pushValue(record.code);
			pushValue(record.name);
			if (record.cause && typeof record.cause === "object") {
				const cause = record.cause;
				pushValue(cause.message);
				pushValue(cause.code);
				pushValue(cause.name);
			}
		}
		return [...messages].some((value) => readonlyPattern.test(value));
	}
	extractErrorReason(err) {
		if (err instanceof Error && err.message.trim()) return err.message;
		if (err && typeof err === "object") {
			const record = err;
			if (typeof record.message === "string" && record.message.trim()) return record.message;
			if (typeof record.code === "string" && record.code.trim()) return record.code;
		}
		return String(err);
	}
	async runSyncWithReadonlyRecovery(params) {
		try {
			await this.runSync(params);
			return;
		} catch (err) {
			if (!this.isReadonlyDbError(err) || this.closed) throw err;
			const reason = this.extractErrorReason(err);
			this.readonlyRecoveryAttempts += 1;
			this.readonlyRecoveryLastError = reason;
			log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
			try {
				this.db.close();
			} catch {}
			this.db = this.openDatabase();
			this.vectorReady = null;
			this.vector.available = null;
			this.vector.loadError = void 0;
			this.ensureSchema();
			const meta = this.readMeta();
			this.vector.dims = meta?.vectorDims;
			try {
				await this.runSync(params);
				this.readonlyRecoverySuccesses += 1;
			} catch (retryErr) {
				this.readonlyRecoveryFailures += 1;
				throw retryErr;
			}
		}
	}
	async readFile(params) {
		const rawPath = params.relPath.trim();
		if (!rawPath) throw new Error("path required");
		const absPath = path.isAbsolute(rawPath) ? path.resolve(rawPath) : path.resolve(this.workspaceDir, rawPath);
		const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
		const allowedWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath) && isMemoryPath(relPath);
		let allowedAdditional = false;
		if (!allowedWorkspace && this.settings.extraPaths.length > 0) {
			const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
			for (const additionalPath of additionalPaths) try {
				const stat = await fs.lstat(additionalPath);
				if (stat.isSymbolicLink()) continue;
				if (stat.isDirectory()) {
					if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
						allowedAdditional = true;
						break;
					}
					continue;
				}
				if (stat.isFile()) {
					if (absPath === additionalPath && absPath.endsWith(".md")) {
						allowedAdditional = true;
						break;
					}
				}
			} catch {}
		}
		if (!allowedWorkspace && !allowedAdditional) throw new Error("path required");
		if (!absPath.endsWith(".md")) throw new Error("path required");
		if ((await statRegularFile(absPath)).missing) return {
			text: "",
			path: relPath
		};
		let content;
		try {
			content = await fs.readFile(absPath, "utf-8");
		} catch (err) {
			if (isFileMissingError(err)) return {
				text: "",
				path: relPath
			};
			throw err;
		}
		if (!params.from && !params.lines) return {
			text: content,
			path: relPath
		};
		const lines = content.split("\n");
		const start = Math.max(1, params.from ?? 1);
		const count = Math.max(1, params.lines ?? lines.length);
		return {
			text: lines.slice(start - 1, start - 1 + count).join("\n"),
			path: relPath
		};
	}
	status() {
		const sourceFilter = this.buildSourceFilter();
		const files = this.db.prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`).get(...sourceFilter.params);
		const chunks = this.db.prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`).get(...sourceFilter.params);
		const sourceCounts = (() => {
			const sources = Array.from(this.sources);
			if (sources.length === 0) return [];
			const bySource = /* @__PURE__ */ new Map();
			for (const source of sources) bySource.set(source, {
				files: 0,
				chunks: 0
			});
			const fileRows = this.db.prepare(`SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`).all(...sourceFilter.params);
			for (const row of fileRows) {
				const entry = bySource.get(row.source) ?? {
					files: 0,
					chunks: 0
				};
				entry.files = row.c ?? 0;
				bySource.set(row.source, entry);
			}
			const chunkRows = this.db.prepare(`SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`).all(...sourceFilter.params);
			for (const row of chunkRows) {
				const entry = bySource.get(row.source) ?? {
					files: 0,
					chunks: 0
				};
				entry.chunks = row.c ?? 0;
				bySource.set(row.source, entry);
			}
			return sources.map((source) => Object.assign({ source }, bySource.get(source)));
		})();
		const searchMode = this.provider ? "hybrid" : "fts-only";
		const providerInfo = this.provider ? {
			provider: this.provider.id,
			model: this.provider.model
		} : {
			provider: "none",
			model: void 0
		};
		return {
			backend: "builtin",
			files: files?.c ?? 0,
			chunks: chunks?.c ?? 0,
			dirty: this.dirty || this.sessionsDirty,
			workspaceDir: this.workspaceDir,
			dbPath: this.settings.store.path,
			provider: providerInfo.provider,
			model: providerInfo.model,
			requestedProvider: this.requestedProvider,
			sources: Array.from(this.sources),
			extraPaths: this.settings.extraPaths,
			sourceCounts,
			cache: this.cache.enabled ? {
				enabled: true,
				entries: this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get()?.c ?? 0,
				maxEntries: this.cache.maxEntries
			} : {
				enabled: false,
				maxEntries: this.cache.maxEntries
			},
			fts: {
				enabled: this.fts.enabled,
				available: this.fts.available,
				error: this.fts.loadError
			},
			fallback: this.fallbackReason ? {
				from: this.fallbackFrom ?? "local",
				reason: this.fallbackReason
			} : void 0,
			vector: {
				enabled: this.vector.enabled,
				available: this.vector.available ?? void 0,
				extensionPath: this.vector.extensionPath,
				loadError: this.vector.loadError,
				dims: this.vector.dims
			},
			batch: {
				enabled: this.batch.enabled,
				failures: this.batchFailureCount,
				limit: BATCH_FAILURE_LIMIT,
				wait: this.batch.wait,
				concurrency: this.batch.concurrency,
				pollIntervalMs: this.batch.pollIntervalMs,
				timeoutMs: this.batch.timeoutMs,
				lastError: this.batchFailureLastError,
				lastProvider: this.batchFailureLastProvider
			},
			custom: {
				searchMode,
				providerUnavailableReason: this.providerUnavailableReason,
				readonlyRecovery: {
					attempts: this.readonlyRecoveryAttempts,
					successes: this.readonlyRecoverySuccesses,
					failures: this.readonlyRecoveryFailures,
					lastError: this.readonlyRecoveryLastError
				}
			}
		};
	}
	async probeVectorAvailability() {
		if (!this.provider) return false;
		if (!this.vector.enabled) return false;
		return this.ensureVectorReady();
	}
	async probeEmbeddingAvailability() {
		if (!this.provider) return {
			ok: false,
			error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)"
		};
		try {
			await this.embedBatchWithRetry(["ping"]);
			return { ok: true };
		} catch (err) {
			return {
				ok: false,
				error: err instanceof Error ? err.message : String(err)
			};
		}
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		const pendingSync = this.syncing;
		if (this.watchTimer) {
			clearTimeout(this.watchTimer);
			this.watchTimer = null;
		}
		if (this.sessionWatchTimer) {
			clearTimeout(this.sessionWatchTimer);
			this.sessionWatchTimer = null;
		}
		if (this.intervalTimer) {
			clearInterval(this.intervalTimer);
			this.intervalTimer = null;
		}
		if (this.watcher) {
			await this.watcher.close();
			this.watcher = null;
		}
		if (this.sessionUnsubscribe) {
			this.sessionUnsubscribe();
			this.sessionUnsubscribe = null;
		}
		if (pendingSync) try {
			await pendingSync;
		} catch {}
		this.db.close();
		INDEX_CACHE.delete(this.cacheKey);
	}
};

//#endregion
export { resolveMemorySearchConfig as n, manager_exports as t };