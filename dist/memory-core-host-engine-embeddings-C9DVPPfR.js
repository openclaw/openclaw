import { c as shouldUseEnvHttpProxyForUrl } from "./proxy-env-Cs0G_0hd.js";
import { n as requireApiKey } from "./model-auth-runtime-shared-cdTr1v5l.js";
import { y as ssrfPolicyFromHttpBaseUrlAllowedHostname } from "./ssrf-DdDeGa5L.js";
import { n as fetchWithSsrFGuard } from "./fetch-guard-BEAbHb5H.js";
import { r as normalizeOptionalString, t as normalizeLowercaseStringOrEmpty } from "./string-utils-xCz9RTVk.js";
import "./memory-embedding-provider-runtime-xg7fdvKI.js";
import "./openclaw-runtime-memory-B0KU6IIj.js";
import { t as formatErrorMessage } from "./error-utils-PBAKtEPD.js";
import { d as runWithConcurrency, f as hasNonTextEmbeddingParts, h as splitTextToUtf8ByteLimit, m as estimateUtf8Bytes } from "./internal-CS1S1qm3.js";
import { t as hashText } from "./hash-C0FSXO-A.js";
import { n as resolveMemorySecretInputString } from "./secret-input-DJirly1z.js";
//#region packages/memory-host-sdk/src/host/embedding-defaults.ts
const DEFAULT_LOCAL_MODEL = "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-vectors.ts
function sanitizeAndNormalizeEmbedding(vec) {
	const sanitized = vec.map((value) => Number.isFinite(value) ? value : 0);
	const magnitude = Math.sqrt(sanitized.reduce((sum, value) => sum + value * value, 0));
	if (magnitude < 1e-10) return sanitized;
	return sanitized.map((value) => value / magnitude);
}
//#endregion
//#region packages/memory-host-sdk/src/host/node-llama.ts
const NODE_LLAMA_CPP_MODULE = "node-llama-cpp";
async function importNodeLlamaCpp() {
	return import(NODE_LLAMA_CPP_MODULE);
}
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings.ts
async function disposeResources(resources) {
	let firstError;
	for (const resource of resources) try {
		await resource?.dispose?.();
	} catch (err) {
		firstError ??= err;
	}
	if (firstError) throw firstError;
}
async function createLocalEmbeddingProvider(options) {
	const modelPath = normalizeOptionalString(options.local?.modelPath) || "hf:ggml-org/embeddinggemma-300m-qat-q8_0-GGUF/embeddinggemma-300m-qat-Q8_0.gguf";
	const modelCacheDir = normalizeOptionalString(options.local?.modelCacheDir);
	const contextSize = options.local?.contextSize ?? 4096;
	const { getLlama, resolveModelFile, LlamaLogLevel } = await importNodeLlamaCpp();
	let llama = null;
	let embeddingModel = null;
	let embeddingContext = null;
	let initPromise = null;
	let initAbortController = null;
	let closePromise = null;
	let closed = false;
	const throwIfClosed = () => {
		if (closed) throw new Error("Local embedding provider has been closed");
	};
	const disposeAndThrowIfClosed = async (resource) => {
		if (!closed) return resource;
		await disposeResources([resource]);
		throwIfClosed();
		return resource;
	};
	const ensureContext = async () => {
		throwIfClosed();
		if (embeddingContext) return embeddingContext;
		if (initPromise) return initPromise;
		initPromise = (async () => {
			const abortController = new AbortController();
			initAbortController = abortController;
			try {
				if (!llama) llama = await disposeAndThrowIfClosed(await getLlama({ logLevel: LlamaLogLevel.error }));
				if (!embeddingModel) {
					const resolved = await resolveModelFile(modelPath, {
						...modelCacheDir ? { directory: modelCacheDir } : {},
						signal: abortController.signal
					});
					throwIfClosed();
					embeddingModel = await disposeAndThrowIfClosed(await llama.loadModel({
						modelPath: resolved,
						loadSignal: abortController.signal
					}));
				}
				if (!embeddingContext) embeddingContext = await disposeAndThrowIfClosed(await embeddingModel.createEmbeddingContext({
					contextSize,
					createSignal: abortController.signal
				}));
				return embeddingContext;
			} catch (err) {
				initPromise = null;
				throw err;
			} finally {
				if (initAbortController === abortController) initAbortController = null;
			}
		})();
		return initPromise;
	};
	return {
		id: "local",
		model: modelPath,
		embedQuery: async (text, options) => {
			throwIfClosed();
			options?.signal?.throwIfAborted();
			const ctx = await ensureContext();
			throwIfClosed();
			options?.signal?.throwIfAborted();
			const embedding = await ctx.getEmbeddingFor(text);
			return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
		},
		embedBatch: async (texts, options) => {
			throwIfClosed();
			options?.signal?.throwIfAborted();
			const ctx = await ensureContext();
			throwIfClosed();
			options?.signal?.throwIfAborted();
			return await Promise.all(texts.map(async (text) => {
				throwIfClosed();
				options?.signal?.throwIfAborted();
				const embedding = await ctx.getEmbeddingFor(text);
				return sanitizeAndNormalizeEmbedding(Array.from(embedding.vector));
			}));
		},
		close: async () => {
			if (closePromise) return closePromise;
			closed = true;
			initAbortController?.abort();
			initAbortController = null;
			closePromise = (async () => {
				const context = embeddingContext;
				const model = embeddingModel;
				const runtime = llama;
				embeddingContext = null;
				embeddingModel = null;
				llama = null;
				initPromise = null;
				await disposeResources([
					context,
					model,
					runtime
				]);
			})();
			return closePromise;
		}
	};
}
//#endregion
//#region packages/memory-host-sdk/src/host/batch-error-utils.ts
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
	const message = formatErrorMessage(err);
	return message ? `error file unavailable: ${message}` : void 0;
}
//#endregion
//#region packages/memory-host-sdk/src/host/remote-http.ts
const MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE = "trusted_env_proxy";
const buildRemoteBaseUrlPolicy = ssrfPolicyFromHttpBaseUrlAllowedHostname;
async function withRemoteHttpResponse(params) {
	const guardedFetch = params.fetchWithSsrFGuardImpl ?? fetchWithSsrFGuard;
	const shouldUseEnvProxy = params.shouldUseEnvHttpProxyForUrlImpl ?? shouldUseEnvHttpProxyForUrl;
	const { response, release } = await guardedFetch({
		url: params.url,
		fetchImpl: params.fetchImpl,
		init: params.init,
		signal: params.signal,
		policy: params.ssrfPolicy,
		auditContext: params.auditContext ?? "memory-remote",
		...shouldUseEnvProxy(params.url) ? { mode: MEMORY_REMOTE_TRUSTED_ENV_PROXY_MODE } : {}
	});
	try {
		return await params.onResponse(response);
	} finally {
		await release();
	}
}
//#endregion
//#region packages/memory-host-sdk/src/host/post-json.ts
async function postJson(params) {
	return await withRemoteHttpResponse({
		url: params.url,
		ssrfPolicy: params.ssrfPolicy,
		fetchImpl: params.fetchImpl,
		signal: params.signal,
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
			return await params.parse(await readJsonResponse(res, params.errorPrefix));
		}
	});
}
async function readJsonResponse(res, errorPrefix) {
	try {
		return await res.json();
	} catch (cause) {
		throw new Error(`${errorPrefix}: malformed JSON response`, { cause });
	}
}
//#endregion
//#region packages/memory-host-sdk/src/host/retry-utils.ts
const DEFAULT_RETRY_CONFIG = {
	attempts: 3,
	minDelayMs: 300,
	maxDelayMs: 3e4,
	jitter: 0
};
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function asFiniteNumber(value) {
	if (typeof value !== "number" || !Number.isFinite(value)) return;
	return value;
}
function clampNumber(value, fallback, min, max) {
	const next = asFiniteNumber(value);
	if (next === void 0) return fallback;
	const floor = typeof min === "number" ? min : Number.NEGATIVE_INFINITY;
	const ceiling = typeof max === "number" ? max : Number.POSITIVE_INFINITY;
	return Math.min(Math.max(next, floor), ceiling);
}
function resolveRetryConfig(defaults = DEFAULT_RETRY_CONFIG, overrides) {
	const attempts = Math.max(1, Math.round(clampNumber(overrides?.attempts, defaults.attempts, 1)));
	const minDelayMs = Math.max(0, Math.round(clampNumber(overrides?.minDelayMs, defaults.minDelayMs, 0)));
	return {
		attempts,
		minDelayMs,
		maxDelayMs: Math.max(minDelayMs, Math.round(clampNumber(overrides?.maxDelayMs, defaults.maxDelayMs, 0))),
		jitter: clampNumber(overrides?.jitter, defaults.jitter, 0, 1)
	};
}
function applyJitter(delayMs, jitter) {
	if (jitter <= 0) return delayMs;
	const offset = (Math.random() * 2 - 1) * jitter;
	return Math.max(0, Math.round(delayMs * (1 + offset)));
}
async function retryAsync(fn, attemptsOrOptions = 3, initialDelayMs = 300) {
	if (typeof attemptsOrOptions === "number") {
		const attempts = Math.max(1, Math.round(attemptsOrOptions));
		let lastErr;
		for (let i = 0; i < attempts; i += 1) try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (i === attempts - 1) break;
			await sleep(initialDelayMs * 2 ** i);
		}
		throw lastErr ?? /* @__PURE__ */ new Error("Retry failed");
	}
	const options = attemptsOrOptions;
	const resolved = resolveRetryConfig(DEFAULT_RETRY_CONFIG, options);
	const maxAttempts = resolved.attempts;
	const minDelayMs = resolved.minDelayMs;
	const maxDelayMs = Number.isFinite(resolved.maxDelayMs) && resolved.maxDelayMs > 0 ? resolved.maxDelayMs : Number.POSITIVE_INFINITY;
	const shouldRetry = options.shouldRetry ?? (() => true);
	let lastErr;
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) try {
		return await fn();
	} catch (err) {
		lastErr = err;
		if (attempt >= maxAttempts || !shouldRetry(err, attempt)) break;
		const retryAfterMs = options.retryAfterMs?.(err);
		const baseDelay = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? Math.max(retryAfterMs, minDelayMs) : minDelayMs * 2 ** (attempt - 1);
		let delay = Math.min(baseDelay, maxDelayMs);
		delay = applyJitter(delay, resolved.jitter);
		delay = Math.min(Math.max(delay, minDelayMs), maxDelayMs);
		options.onRetry?.({
			attempt,
			maxAttempts,
			delayMs: delay,
			err,
			label: options.label
		});
		if (delay > 0) await sleep(delay);
	}
	throw lastErr ?? /* @__PURE__ */ new Error("Retry failed");
}
//#endregion
//#region packages/memory-host-sdk/src/host/batch-http.ts
async function postJsonWithRetry(params) {
	return await (params.retryImpl ?? retryAsync)(async () => {
		return await postJson({
			url: params.url,
			headers: params.headers,
			ssrfPolicy: params.ssrfPolicy,
			fetchImpl: params.fetchImpl,
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
//#region packages/memory-host-sdk/src/host/batch-output.ts
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
//#region packages/memory-host-sdk/src/host/batch-provider-common.ts
const EMBEDDING_BATCH_ENDPOINT = "/v1/embeddings";
//#endregion
//#region packages/memory-host-sdk/src/host/batch-utils.ts
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
//#region packages/memory-host-sdk/src/host/batch-runner.ts
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
//#region packages/memory-host-sdk/src/host/batch-status.ts
const TERMINAL_FAILURE_STATES = new Set([
	"failed",
	"expired",
	"cancelled",
	"canceled"
]);
function resolveBatchCompletionFromStatus(params) {
	if (!params.status.output_file_id) throw new Error(`${params.provider} batch ${params.batchId} completed without output file`);
	return {
		outputFileId: params.status.output_file_id,
		errorFileId: params.status.error_file_id ?? void 0
	};
}
async function throwIfBatchTerminalFailure(params) {
	const state = params.status.status ?? "unknown";
	if (!TERMINAL_FAILURE_STATES.has(state)) return;
	const detail = params.status.error_file_id ? await params.readError(params.status.error_file_id) : void 0;
	const suffix = detail ? `: ${detail}` : "";
	throw new Error(`${params.provider} batch ${params.status.id ?? "<unknown>"} ${state}${suffix}`);
}
async function resolveCompletedBatchResult(params) {
	const batchId = params.status.id ?? "<unknown>";
	if (!params.wait && params.status.status !== "completed") throw new Error(`${params.provider} batch ${batchId} submitted; enable remote.batch.wait to await completion`);
	const completed = params.status.status === "completed" ? resolveBatchCompletionFromStatus({
		provider: params.provider,
		batchId,
		status: params.status
	}) : await params.waitForBatch();
	if (!completed.outputFileId) throw new Error(`${params.provider} batch ${batchId} completed without output file`);
	return completed;
}
//#endregion
//#region packages/memory-host-sdk/src/host/batch-upload.ts
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
			try {
				return await fileRes.json();
			} catch (cause) {
				throw new Error(`${params.errorPrefix}: malformed JSON response`, { cause });
			}
		}
	});
	if (!filePayload.id) throw new Error(`${params.errorPrefix}: missing file id`);
	return filePayload.id;
}
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-model-limits.ts
const DEFAULT_EMBEDDING_MAX_INPUT_TOKENS = 8192;
const DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS = 2048;
function resolveEmbeddingMaxInputTokens(provider) {
	if (typeof provider.maxInputTokens === "number") return provider.maxInputTokens;
	if (provider.id === "local") return DEFAULT_LOCAL_EMBEDDING_MAX_INPUT_TOKENS;
	return DEFAULT_EMBEDDING_MAX_INPUT_TOKENS;
}
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-chunk-limits.ts
function enforceEmbeddingMaxInputTokens(provider, chunks, hardMaxInputTokens) {
	const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
	const maxInputTokens = typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0 ? Math.min(providerMaxInputTokens, hardMaxInputTokens) : providerMaxInputTokens;
	const out = [];
	for (const chunk of chunks) {
		if (hasNonTextEmbeddingParts(chunk.embeddingInput)) {
			out.push(chunk);
			continue;
		}
		if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
			out.push(chunk);
			continue;
		}
		for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) out.push({
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			text,
			hash: hashText(text),
			embeddingInput: { text }
		});
	}
	return out;
}
//#endregion
//#region packages/memory-host-sdk/src/host/embedding-provider-adapter-utils.ts
function isMissingEmbeddingApiKeyError(err) {
	return err instanceof Error && err.message.includes("No API key found for provider");
}
function sanitizeEmbeddingCacheHeaders(headers, excludedHeaderNames) {
	const excluded = new Set(excludedHeaderNames.map((name) => normalizeLowercaseStringOrEmpty(name)));
	return Object.entries(headers).filter(([key]) => !excluded.has(normalizeLowercaseStringOrEmpty(key))).toSorted(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, value]);
}
function mapBatchEmbeddingsByIndex(byCustomId, count) {
	const embeddings = [];
	for (let index = 0; index < count; index += 1) embeddings.push(byCustomId.get(String(index)) ?? []);
	return embeddings;
}
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-debug.ts
const debugEmbeddings = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_MEMORY_EMBEDDINGS);
function debugEmbeddingsLog(message, meta) {
	if (!debugEmbeddings) return;
	const suffix = meta ? ` ${JSON.stringify(meta)}` : "";
	process.stderr.write(`${message}${suffix}\n`);
}
function isTruthyEnvValue(value) {
	switch (normalizeLowercaseStringOrEmpty(value)) {
		case "1":
		case "on":
		case "true":
		case "yes": return true;
		default: return false;
	}
}
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-model-normalize.ts
function normalizeEmbeddingModelWithPrefixes(params) {
	const trimmed = params.model.trim();
	if (!trimmed) return params.defaultModel;
	for (const prefix of params.prefixes) if (trimmed.startsWith(prefix)) return trimmed.slice(prefix.length);
	return trimmed;
}
//#endregion
//#region packages/memory-host-sdk/src/host/openclaw-runtime-auth.ts
const resolveApiKeyForProvider = async (...args) => {
	return (await import("./model-auth-CFJR0pRr.js")).resolveApiKeyForProvider(...args);
};
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-remote-client.ts
function resolveOpenClawAttributionHeaders() {
	const version = typeof process !== "undefined" ? process.env.OPENCLAW_VERSION?.trim() : void 0;
	return {
		originator: "openclaw",
		...version ? { version } : {},
		"User-Agent": version ? `openclaw/${version}` : "openclaw"
	};
}
function isNativeOpenAIEmbeddingRoute(provider, baseUrl) {
	if (provider !== "openai") return false;
	try {
		return new URL(baseUrl).hostname.toLowerCase().replace(/\.+$/, "") === "api.openai.com";
	} catch {
		return false;
	}
}
async function resolveRemoteEmbeddingBearerClient(params) {
	const remote = params.options.remote;
	const remoteApiKey = resolveMemorySecretInputString({
		value: remote?.apiKey,
		path: "agents.*.memorySearch.remote.apiKey"
	});
	const remoteBaseUrl = normalizeOptionalString(remote?.baseUrl);
	const providerConfig = params.options.config.models?.providers?.[params.provider];
	const apiKey = remoteApiKey ? remoteApiKey : requireApiKey(await resolveApiKeyForProvider({
		provider: params.provider,
		cfg: params.options.config,
		agentDir: params.options.agentDir
	}), params.provider);
	const baseUrl = remoteBaseUrl || normalizeOptionalString(providerConfig?.baseUrl) || params.defaultBaseUrl;
	const headerOverrides = Object.assign({}, providerConfig?.headers, remote?.headers);
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
		...headerOverrides
	};
	if (isNativeOpenAIEmbeddingRoute(params.provider, baseUrl)) Object.assign(headers, resolveOpenClawAttributionHeaders());
	return {
		baseUrl,
		headers,
		ssrfPolicy: buildRemoteBaseUrlPolicy(baseUrl)
	};
}
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-remote-fetch.ts
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : void 0;
}
function malformedEmbeddingResponse(errorPrefix) {
	return /* @__PURE__ */ new Error(`${errorPrefix}: malformed JSON response`);
}
function readEmbeddingVector(value, errorPrefix) {
	if (!Array.isArray(value)) throw malformedEmbeddingResponse(errorPrefix);
	for (const entry of value) if (typeof entry !== "number" || !Number.isFinite(entry)) throw malformedEmbeddingResponse(errorPrefix);
	return value;
}
function resolveExpectedEmbeddingCount(body) {
	const input = asRecord(body)?.input;
	return Array.isArray(input) ? input.length : void 0;
}
async function fetchRemoteEmbeddingVectors(params) {
	return await postJson({
		url: params.url,
		headers: params.headers,
		ssrfPolicy: params.ssrfPolicy,
		fetchImpl: params.fetchImpl,
		signal: params.signal,
		body: params.body,
		errorPrefix: params.errorPrefix,
		parse: (payload) => {
			const root = asRecord(payload);
			if (!root || !Array.isArray(root.data)) throw malformedEmbeddingResponse(params.errorPrefix);
			const expectedCount = resolveExpectedEmbeddingCount(params.body);
			if (expectedCount !== void 0 && root.data.length !== expectedCount) throw malformedEmbeddingResponse(params.errorPrefix);
			return root.data.map((entry) => {
				const record = asRecord(entry);
				if (!record) throw malformedEmbeddingResponse(params.errorPrefix);
				return readEmbeddingVector(record.embedding, params.errorPrefix);
			});
		}
	});
}
//#endregion
//#region packages/memory-host-sdk/src/host/embeddings-remote-provider.ts
function createRemoteEmbeddingProvider(params) {
	const { client } = params;
	const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;
	const embed = async (input, signal) => {
		if (input.length === 0) return [];
		return await fetchRemoteEmbeddingVectors({
			url,
			headers: client.headers,
			ssrfPolicy: client.ssrfPolicy,
			fetchImpl: client.fetchImpl,
			signal,
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
		embedQuery: async (text, options) => {
			const [vec] = await embed([text], options?.signal);
			return vec ?? [];
		},
		embedBatch: async (texts, options) => await embed(texts, options?.signal)
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
export { withRemoteHttpResponse as C, sanitizeAndNormalizeEmbedding as D, createLocalEmbeddingProvider as E, DEFAULT_LOCAL_MODEL as O, buildRemoteBaseUrlPolicy as S, formatUnavailableBatchError as T, buildBatchHeaders as _, normalizeEmbeddingModelWithPrefixes as a, applyEmbeddingBatchOutputLine as b, mapBatchEmbeddingsByIndex as c, uploadBatchJsonlFile as d, resolveBatchCompletionFromStatus as f, runEmbeddingBatchGroups as g, buildEmbeddingBatchGroupOptions as h, resolveRemoteEmbeddingBearerClient as i, sanitizeEmbeddingCacheHeaders as l, throwIfBatchTerminalFailure as m, resolveRemoteEmbeddingClient as n, debugEmbeddingsLog as o, resolveCompletedBatchResult as p, fetchRemoteEmbeddingVectors as r, isMissingEmbeddingApiKeyError as s, createRemoteEmbeddingProvider as t, enforceEmbeddingMaxInputTokens as u, normalizeBatchBaseUrl as v, extractBatchErrorMessage as w, postJsonWithRetry as x, EMBEDDING_BATCH_ENDPOINT as y };
