import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-DyL154ka.js";
import { i as formatErrorMessage } from "./errors-b3ZrCRlt.js";
import { n as resolveGlobalSingleton } from "./global-singleton-DE6St75u.js";
import { p as resolveUserPath, y as truncateUtf16Safe } from "./utils-sBTEdeml.js";
import { a as resolveAgentDir, o as resolveAgentWorkspaceDir } from "./agent-scope-config-CMp71_27.js";
import { t as createSubsystemLogger } from "./subsystem-DSPWLoK5.js";
import { c as isUsageCountedSessionTranscriptFileName, i as isSessionArchiveArtifactName } from "./artifacts-BZhcmsUl.js";
import { l as resolveSessionTranscriptsDirForAgent } from "./paths-Bg3PO6Gj.js";
import { n as onSessionTranscriptUpdate } from "./transcript-events-ClYG_P1o.js";
import { t as extractKeywords } from "./query-expansion-BMvljseN.js";
import { r as classifyMemoryMultimodalPath } from "./multimodal-DsKQmW5D.js";
import { t as resolveMemorySearchConfig } from "./memory-search-BEQRq9yG.js";
import "./error-runtime-DGHc7DZw.js";
import "./string-coerce-runtime-BAEEbdFW.js";
import { n as listMemoryEmbeddingProviders, t as getMemoryEmbeddingProvider } from "./memory-embedding-provider-runtime-xg7fdvKI.js";
import { u as enforceEmbeddingMaxInputTokens } from "./memory-core-host-engine-embeddings-C9DVPPfR.js";
import { t as isFileMissingError } from "./fs-utils-DdhuqF2m.js";
import { a as ensureDir, c as normalizeExtraMemoryPaths, d as runWithConcurrency, f as hasNonTextEmbeddingParts, i as cosineSimilarity, l as parseEmbedding, n as buildMultimodalChunkForIndexing, r as chunkMarkdown, s as listMemoryFiles, t as buildFileEntry, u as remapChunkLines } from "./internal-CS1S1qm3.js";
import { t as hashText } from "./hash-C0FSXO-A.js";
import "./memory-core-host-engine-foundation-C4jQcNJ0.js";
import { l as buildSessionEntry, m as sessionPathForFile, u as listSessionFilesForAgent } from "./engine-qmd-DGRjZTL_.js";
import "./memory-core-host-engine-qmd-CqFCiTFk.js";
import { n as readMemoryFile } from "./read-file-DT3HXSt4.js";
import { a as ensureMemoryIndexSchema, i as loadSqliteVecExtension, n as configureMemorySqliteWalMaintenance, r as requireNodeSqlite, t as closeMemorySqliteWalMaintenance } from "./engine-storage-Dql4GNKy.js";
import "./memory-core-host-engine-storage-BkNmLt7d.js";
import "./dreaming-shared-TJ4wErqZ.js";
import { t as canAutoSelectLocal } from "./provider-adapters-DLvfgy7S.js";
import { n as settleMemoryWatchEventPaths, t as recordMemoryWatchEventPath } from "./watch-settle-D8vi8R4W.js";
import fs from "node:fs";
import path from "node:path";
import fs$1 from "node:fs/promises";
import { randomUUID } from "node:crypto";
import chokidar from "chokidar";
import { setTimeout as setTimeout$1 } from "node:timers/promises";
//#region extensions/memory-core/src/memory/embeddings.ts
function formatProviderError(adapter, err) {
	return adapter.formatSetupError?.(err) ?? formatErrorMessage(err);
}
function shouldContinueAutoSelection(adapter, err) {
	return adapter.shouldContinueAutoSelection?.(err) ?? false;
}
function getAdapter(id, config) {
	const adapter = getMemoryEmbeddingProvider(id, config);
	if (!adapter) throw new Error(`Unknown memory embedding provider: ${id}`);
	return adapter;
}
function listAutoSelectAdapters(options) {
	return listMemoryEmbeddingProviders(options.config).filter((adapter) => typeof adapter.autoSelectPriority === "number").filter((adapter) => adapter.id === "local" ? canAutoSelectLocal(options.local?.modelPath) : true).toSorted((a, b) => (a.autoSelectPriority ?? Number.MAX_SAFE_INTEGER) - (b.autoSelectPriority ?? Number.MAX_SAFE_INTEGER));
}
function resolveProviderModel(adapter, requestedModel) {
	const trimmed = requestedModel.trim();
	if (trimmed) return trimmed;
	return adapter.defaultModel ?? "";
}
function resolveEmbeddingProviderFallbackModel(providerId, fallbackSourceModel, config) {
	return getMemoryEmbeddingProvider(providerId, config)?.defaultModel ?? fallbackSourceModel;
}
async function createWithAdapter(adapter, options) {
	const result = await adapter.create({
		...options,
		model: resolveProviderModel(adapter, options.model)
	});
	return {
		provider: result.provider,
		requestedProvider: options.provider,
		runtime: result.runtime
	};
}
async function createEmbeddingProvider(options) {
	if (options.provider === "auto") {
		const reasons = [];
		for (const adapter of listAutoSelectAdapters(options)) try {
			return {
				...await createWithAdapter(adapter, {
					...options,
					provider: adapter.id
				}),
				requestedProvider: "auto"
			};
		} catch (err) {
			const message = formatProviderError(adapter, err);
			if (shouldContinueAutoSelection(adapter, err)) {
				reasons.push(message);
				continue;
			}
			const wrapped = new Error(message);
			wrapped.cause = err;
			throw wrapped;
		}
		return {
			provider: null,
			requestedProvider: "auto",
			providerUnavailableReason: reasons.length > 0 ? reasons.join("\n\n") : "No embeddings provider available."
		};
	}
	const primaryAdapter = getAdapter(options.provider, options.config);
	try {
		return await createWithAdapter(primaryAdapter, options);
	} catch (primaryErr) {
		const reason = formatProviderError(primaryAdapter, primaryErr);
		if (options.fallback && options.fallback !== "none" && options.fallback !== options.provider) {
			const fallbackAdapter = getAdapter(options.fallback, options.config);
			try {
				return {
					...await createWithAdapter(fallbackAdapter, {
						...options,
						provider: options.fallback
					}),
					requestedProvider: options.provider,
					fallbackFrom: options.provider,
					fallbackReason: reason
				};
			} catch (fallbackErr) {
				const fallbackReason = formatProviderError(fallbackAdapter, fallbackErr);
				const wrapped = /* @__PURE__ */ new Error(`${reason}\n\nFallback to ${options.fallback} failed: ${fallbackReason}`);
				wrapped.cause = primaryErr;
				throw wrapped;
			}
		}
		const wrapped = new Error(reason);
		wrapped.cause = primaryErr;
		throw wrapped;
	}
}
//#endregion
//#region extensions/memory-core/src/memory/mmr.ts
const DEFAULT_MMR_CONFIG = {
	enabled: false,
	lambda: .7
};
/**
* Regex matching CJK-family characters that lack whitespace word boundaries:
* - CJK Unified Ideographs (Chinese hanzi, Japanese kanji, Korean hanja)
* - CJK Extension A
* - Hiragana & Katakana (Japanese)
* - Hangul Syllables & Jamo (Korean)
*/
const CJK_RE = /[\u3040-\u309f\u30a0-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\u1100-\u11ff]/;
/**
* Tokenize text for Jaccard similarity computation.
* Extracts alphanumeric tokens, CJK-family characters (unigrams),
* and consecutive CJK character pairs (bigrams).
*
* Bigrams are only created from characters that are adjacent in the
* original text, so mixed content like "我喜欢hello你好" will NOT
* produce the spurious bigram "欢你".
*/
function tokenize(text) {
	const lower = normalizeLowercaseStringOrEmpty(text);
	const ascii = lower.match(/[a-z0-9_]+/g) ?? [];
	const chars = Array.from(lower);
	const cjkData = [];
	for (let i = 0; i < chars.length; i++) if (CJK_RE.test(chars[i])) cjkData.push({
		char: chars[i],
		index: i
	});
	const bigrams = [];
	for (let i = 0; i < cjkData.length - 1; i++) if (cjkData[i + 1].index === cjkData[i].index + 1) bigrams.push(cjkData[i].char + cjkData[i + 1].char);
	const unigrams = cjkData.map((d) => d.char);
	return new Set([
		...ascii,
		...bigrams,
		...unigrams
	]);
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
//#region extensions/memory-core/src/memory/temporal-decay.ts
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
	if (normalized === "MEMORY.md") return true;
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
		const stat = await fs$1.stat(absolutePath);
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
//#region extensions/memory-core/src/memory/hybrid.ts
function buildFtsQuery(raw) {
	const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
	if (tokens.length === 0) return null;
	return tokens.map((t) => `"${t.replaceAll("\"", "")}"`).join(" AND ");
}
function bm25RankToScore(rank) {
	if (!Number.isFinite(rank)) return 1 / 1e3;
	if (rank < 0) {
		const relevance = -rank;
		return relevance / (1 + relevance);
	}
	return 1 / (1 + rank);
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
				vectorScore: entry.vectorScore,
				textScore: entry.textScore,
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
//#region extensions/memory-core/src/memory/manager-async-state.ts
function startAsyncSearchSync(params) {
	if (!params.enabled || !params.dirty && !params.sessionsDirty) return;
	params.sync({ reason: "search" }).catch((err) => {
		params.onError(err);
	});
}
async function awaitPendingManagerWork(params) {
	if (params.pendingSync) try {
		await params.pendingSync;
	} catch {}
	if (params.pendingProviderInit) try {
		await params.pendingProviderInit;
	} catch {}
}
function resetMemoryBatchFailureState(state) {
	return {
		...state,
		count: 0,
		lastError: void 0,
		lastProvider: void 0
	};
}
function recordMemoryBatchFailure(state, params) {
	if (!state.enabled) return state;
	const increment = params.forceDisable ? 2 : Math.max(1, params.attempts ?? 1);
	const count = state.count + increment;
	return {
		enabled: !(params.forceDisable || count >= 2),
		count,
		lastError: params.message,
		lastProvider: params.provider
	};
}
//#endregion
//#region extensions/memory-core/src/memory/manager-cache.ts
function resolveSingletonManagedCache(cacheKey) {
	const resolved = resolveGlobalSingleton(cacheKey, () => ({
		cache: /* @__PURE__ */ new Map(),
		pending: /* @__PURE__ */ new Map()
	}));
	if (typeof resolved === "object" && resolved !== null && resolved.cache instanceof Map && resolved.pending instanceof Map) return resolved;
	const repaired = {
		cache: /* @__PURE__ */ new Map(),
		pending: /* @__PURE__ */ new Map()
	};
	globalThis[cacheKey] = repaired;
	return repaired;
}
async function getOrCreateManagedCacheEntry(params) {
	if (params.bypassCache) return await params.create();
	const existing = params.cache.get(params.key);
	if (existing) return existing;
	const pending = params.pending.get(params.key);
	if (pending) return pending;
	const createPromise = (async () => {
		const refreshed = params.cache.get(params.key);
		if (refreshed) return refreshed;
		const entry = await params.create();
		params.cache.set(params.key, entry);
		return entry;
	})();
	params.pending.set(params.key, createPromise);
	try {
		return await createPromise;
	} finally {
		if (params.pending.get(params.key) === createPromise) params.pending.delete(params.key);
	}
}
async function closeManagedCacheEntries(params) {
	const pending = Array.from(params.pending.values());
	if (pending.length > 0) await Promise.allSettled(pending);
	const entries = Array.from(params.cache.values());
	params.cache.clear();
	for (const entry of entries) {
		if (typeof entry.close !== "function") continue;
		try {
			await entry.close();
		} catch (err) {
			params.onCloseError?.(err);
		}
	}
}
//#endregion
//#region extensions/memory-core/src/memory/manager-db.ts
function openMemoryDatabaseAtPath(dbPath, allowExtension) {
	ensureDir(path.dirname(dbPath));
	const { DatabaseSync } = requireNodeSqlite();
	const db = new DatabaseSync(dbPath, { allowExtension });
	configureMemorySqliteWalMaintenance(db);
	db.exec("PRAGMA busy_timeout = 5000");
	return db;
}
function closeMemoryDatabase(db) {
	closeMemorySqliteWalMaintenance(db);
	db.close();
}
//#endregion
//#region extensions/memory-core/src/memory/manager-embedding-cache.ts
function loadMemoryEmbeddingCache(params) {
	const provider = params.provider;
	if (!params.enabled || !provider || !params.providerKey || params.hashes.length === 0) return /* @__PURE__ */ new Map();
	const unique = [];
	const seen = /* @__PURE__ */ new Set();
	for (const hash of params.hashes) {
		if (!hash || seen.has(hash)) continue;
		seen.add(hash);
		unique.push(hash);
	}
	if (unique.length === 0) return /* @__PURE__ */ new Map();
	const tableName = params.tableName ?? "embedding_cache";
	const out = /* @__PURE__ */ new Map();
	const baseParams = [
		provider.id,
		provider.model,
		params.providerKey
	];
	const batchSize = 400;
	for (let start = 0; start < unique.length; start += batchSize) {
		const batch = unique.slice(start, start + batchSize);
		const placeholders = batch.map(() => "?").join(", ");
		const rows = params.db.prepare(`SELECT hash, embedding FROM ${tableName}\n WHERE provider = ? AND model = ? AND provider_key = ? AND hash IN (${placeholders})`).all(...baseParams, ...batch);
		for (const row of rows) out.set(row.hash, parseEmbedding(row.embedding));
	}
	return out;
}
function upsertMemoryEmbeddingCache(params) {
	const provider = params.provider;
	if (!params.enabled || !provider || !params.providerKey || params.entries.length === 0) return;
	const tableName = params.tableName ?? "embedding_cache";
	const now = params.now ?? Date.now();
	const stmt = params.db.prepare(`INSERT INTO ${tableName} (provider, model, provider_key, hash, embedding, dims, updated_at)\n VALUES (?, ?, ?, ?, ?, ?, ?)\n ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET\n   embedding=excluded.embedding,\n   dims=excluded.dims,\n   updated_at=excluded.updated_at`);
	for (const entry of params.entries) {
		const embedding = entry.embedding ?? [];
		stmt.run(provider.id, provider.model, params.providerKey, entry.hash, JSON.stringify(embedding), embedding.length, now);
	}
}
function collectMemoryCachedEmbeddings(params) {
	const embeddings = Array.from({ length: params.chunks.length }, () => []);
	const missing = [];
	for (let index = 0; index < params.chunks.length; index += 1) {
		const chunk = params.chunks[index];
		const hit = chunk?.hash ? params.cached.get(chunk.hash) : void 0;
		if (hit && hit.length > 0) embeddings[index] = hit;
		else if (chunk) missing.push({
			index,
			chunk
		});
	}
	return {
		embeddings,
		missing
	};
}
//#endregion
//#region extensions/memory-core/src/memory/manager-embedding-policy.ts
function estimateUtf8Bytes(text) {
	if (!text) return 0;
	return Buffer.byteLength(text, "utf8");
}
function estimateStructuredEmbeddingInputBytes(input) {
	if (!input.parts?.length) return estimateUtf8Bytes(input.text);
	let total = 0;
	for (const part of input.parts) if (part.type === "text") total += estimateUtf8Bytes(part.text);
	else {
		total += estimateUtf8Bytes(part.mimeType);
		total += estimateUtf8Bytes(part.data);
	}
	return total;
}
function filterNonEmptyMemoryChunks(chunks) {
	return chunks.filter((chunk) => chunk.text.trim().length > 0);
}
function buildMemoryEmbeddingBatches(chunks, maxTokens) {
	const batches = [];
	let current = [];
	let currentTokens = 0;
	for (const chunk of chunks) {
		const estimate = chunk.embeddingInput ? estimateStructuredEmbeddingInputBytes(chunk.embeddingInput) : estimateUtf8Bytes(chunk.text);
		if (current.length > 0 && currentTokens + estimate > maxTokens) {
			batches.push(current);
			current = [];
			currentTokens = 0;
		}
		if (current.length === 0 && estimate > maxTokens) {
			batches.push([chunk]);
			continue;
		}
		current.push(chunk);
		currentTokens += estimate;
	}
	if (current.length > 0) batches.push(current);
	return batches;
}
function isRetryableMemoryEmbeddingError(message) {
	return /(rate[_ ]limit|too many requests|429|resource has been exhausted|5\d\d|cloudflare|tokens per day|fetch failed|other side closed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|UND_ERR_|socket hang up|network error|read ECONN|timed out)/i.test(message);
}
function resolveMemoryEmbeddingRetryDelay(delayMs, randomValue, maxDelayMs) {
	return Math.min(maxDelayMs, Math.round(delayMs * (1 + randomValue * .2)));
}
async function runMemoryEmbeddingRetryLoop(params) {
	let attempt = 0;
	let delayMs = params.baseDelayMs;
	while (true) try {
		return await params.run();
	} catch (err) {
		const message = formatErrorMessage(err);
		if (!params.isRetryable(message) || attempt >= params.maxAttempts) throw err;
		await params.waitForRetry(delayMs);
		delayMs *= 2;
		attempt += 1;
	}
}
function buildTextEmbeddingInputs(chunks) {
	return chunks.map((chunk) => chunk.embeddingInput ?? { text: chunk.text });
}
//#endregion
//#region extensions/memory-core/src/memory/manager-fts-state.ts
function deleteMemoryFtsRows(params) {
	const tableName = params.tableName ?? "chunks_fts";
	if (params.currentModel) {
		params.db.prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ? AND model = ?`).run(params.path, params.source, params.currentModel);
		return;
	}
	params.db.prepare(`DELETE FROM ${tableName} WHERE path = ? AND source = ?`).run(params.path, params.source);
}
//#endregion
//#region extensions/memory-core/src/memory/manager-atomic-reindex.ts
const defaultFileOps = {
	rename: fs$1.rename,
	rm: fs$1.rm,
	wait: setTimeout$1
};
const transientFileErrorCodes = new Set([
	"EBUSY",
	"EPERM",
	"EACCES"
]);
const defaultMaxRenameAttempts = 6;
const defaultRenameRetryDelayMs = 25;
const defaultMaxRemoveAttempts = 10;
const defaultRemoveRetryDelayMs = 50;
function isTransientFileError(err) {
	return transientFileErrorCodes.has(err.code ?? "");
}
function resolveMemoryIndexFileOptions(options = {}) {
	return {
		fileOps: options.fileOps ?? defaultFileOps,
		maxRenameAttempts: Math.max(1, options.maxRenameAttempts ?? defaultMaxRenameAttempts),
		renameRetryDelayMs: options.renameRetryDelayMs ?? defaultRenameRetryDelayMs,
		maxRemoveAttempts: Math.max(1, options.maxRemoveAttempts ?? defaultMaxRemoveAttempts),
		removeRetryDelayMs: options.removeRetryDelayMs ?? defaultRemoveRetryDelayMs
	};
}
async function renameWithRetry(source, target, options) {
	for (let attempt = 1; attempt <= options.maxRenameAttempts; attempt++) try {
		await options.fileOps.rename(source, target);
		return;
	} catch (err) {
		if (err.code === "ENOENT") return;
		if (!isTransientFileError(err) || attempt === options.maxRenameAttempts) throw err;
		await options.fileOps.wait(options.renameRetryDelayMs * attempt);
	}
	throw new Error("rename retry loop exited unexpectedly");
}
async function moveMemoryIndexFiles(sourceBase, targetBase, options = {}) {
	const resolvedOptions = resolveMemoryIndexFileOptions(options);
	for (const suffix of [
		"",
		"-wal",
		"-shm"
	]) await renameWithRetry(`${sourceBase}${suffix}`, `${targetBase}${suffix}`, resolvedOptions);
}
async function rmWithRetry(path, options) {
	for (let attempt = 1; attempt <= options.maxRemoveAttempts; attempt++) try {
		await options.fileOps.rm(path, { force: true });
		return;
	} catch (err) {
		if (err.code === "ENOENT") return;
		if (!isTransientFileError(err) || attempt === options.maxRemoveAttempts) throw err;
		await options.fileOps.wait(options.removeRetryDelayMs * attempt);
	}
	throw new Error("rm retry loop exited unexpectedly");
}
async function removeMemoryIndexFiles(basePath, options = {}) {
	const resolvedOptions = resolveMemoryIndexFileOptions(options);
	for (const suffix of [
		"",
		"-wal",
		"-shm"
	]) await rmWithRetry(`${basePath}${suffix}`, resolvedOptions);
}
async function swapMemoryIndexFiles(targetPath, tempPath) {
	const backupPath = `${targetPath}.backup-${randomUUID()}`;
	await moveMemoryIndexFiles(targetPath, backupPath);
	try {
		await moveMemoryIndexFiles(tempPath, targetPath);
	} catch (err) {
		await moveMemoryIndexFiles(backupPath, targetPath);
		throw err;
	}
	await removeMemoryIndexFiles(backupPath);
}
async function runMemoryAtomicReindex(params) {
	try {
		const result = await params.build();
		await swapMemoryIndexFiles(params.targetPath, params.tempPath);
		return result;
	} catch (err) {
		try {
			await params.beforeTempCleanup?.();
			await removeMemoryIndexFiles(params.tempPath, params.fileOptions);
		} catch (cleanupErr) {
			throw new AggregateError([err, cleanupErr], "memory atomic reindex failed and temp cleanup failed", { cause: cleanupErr });
		}
		throw err;
	}
}
//#endregion
//#region extensions/memory-core/src/memory/manager-provider-state.ts
function resolveMemoryPrimaryProviderRequest(params) {
	return {
		provider: params.settings.provider,
		model: params.settings.model,
		remote: params.settings.remote,
		inputType: params.settings.inputType,
		queryInputType: params.settings.queryInputType,
		documentInputType: params.settings.documentInputType,
		outputDimensionality: params.settings.outputDimensionality,
		fallback: params.settings.fallback,
		local: params.settings.local
	};
}
function resolveMemoryProviderState(result) {
	return {
		provider: result.provider,
		fallbackFrom: result.fallbackFrom,
		fallbackReason: result.fallbackReason,
		providerUnavailableReason: result.providerUnavailableReason,
		providerRuntime: result.runtime
	};
}
function applyMemoryFallbackProviderState(params) {
	return {
		...params.current,
		fallbackFrom: params.fallbackFrom,
		fallbackReason: params.reason,
		provider: params.result.provider,
		providerRuntime: params.result.runtime
	};
}
function resolveMemoryFallbackProviderRequest(params) {
	const fallback = params.settings.fallback;
	if (!fallback || fallback === "none" || !params.currentProviderId || fallback === params.currentProviderId) return null;
	return {
		provider: fallback,
		model: resolveEmbeddingProviderFallbackModel(fallback, params.settings.model, params.cfg),
		remote: params.settings.remote,
		inputType: params.settings.inputType,
		queryInputType: params.settings.queryInputType,
		documentInputType: params.settings.documentInputType,
		outputDimensionality: params.settings.outputDimensionality,
		fallback: "none",
		local: params.settings.local
	};
}
//#endregion
//#region extensions/memory-core/src/memory/manager-reindex-state.ts
function resolveConfiguredSourcesForMeta(sources) {
	const normalized = Array.from(sources).filter((source) => source === "memory" || source === "sessions").toSorted((left, right) => left.localeCompare(right));
	return normalized.length > 0 ? normalized : ["memory"];
}
function normalizeMetaSources(meta) {
	if (!Array.isArray(meta.sources)) return ["memory"];
	const normalized = Array.from(new Set(meta.sources.filter((source) => source === "memory" || source === "sessions"))).toSorted((left, right) => left.localeCompare(right));
	return normalized.length > 0 ? normalized : ["memory"];
}
function configuredMetaSourcesDiffer(params) {
	const metaSources = normalizeMetaSources(params.meta);
	if (metaSources.length !== params.configuredSources.length) return true;
	return metaSources.some((source, index) => source !== params.configuredSources[index]);
}
function resolveConfiguredScopeHash(params) {
	const extraPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths).map((value) => value.replace(/\\/g, "/")).toSorted();
	return hashText(JSON.stringify({
		extraPaths,
		multimodal: {
			enabled: params.multimodal.enabled,
			modalities: [...params.multimodal.modalities].toSorted(),
			maxFileBytes: params.multimodal.maxFileBytes
		}
	}));
}
function shouldRunFullMemoryReindex(params) {
	const { meta } = params;
	return !meta || (params.provider ? meta.model !== params.provider.model : meta.model !== "fts-only") || (params.provider ? meta.provider !== params.provider.id : meta.provider !== "none") || meta.providerKey !== params.providerKey || configuredMetaSourcesDiffer({
		meta,
		configuredSources: params.configuredSources
	}) || meta.scopeHash !== params.configuredScopeHash || meta.chunkTokens !== params.chunkTokens || meta.chunkOverlap !== params.chunkOverlap || params.vectorReady && !meta.vectorDims || (meta.ftsTokenizer ?? "unicode61") !== params.ftsTokenizer;
}
//#endregion
//#region extensions/memory-core/src/memory/manager-session-reindex.ts
function shouldSyncSessionsForReindex(params) {
	if (!params.hasSessionSource) return false;
	if (params.sync?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) return true;
	if (params.sync?.force) return true;
	if (params.needsFullReindex) return true;
	const reason = params.sync?.reason;
	if (reason === "session-start" || reason === "watch") return false;
	return params.sessionsDirty && params.dirtySessionFileCount > 0;
}
//#endregion
//#region extensions/memory-core/src/memory/manager-session-sync-state.ts
function resolveMemorySessionStartupDirtyFiles(params) {
	const indexedRows = new Map((params.existingRows ?? []).map((row) => [row.path, row]));
	const dirtyFiles = [];
	for (const file of params.files) {
		const existing = indexedRows.get(file.path);
		if (!existing) {
			dirtyFiles.push(file.absPath);
			continue;
		}
		const indexedMtimeMs = Number(existing.mtime);
		const indexedSize = Number(existing.size);
		if (!Number.isFinite(indexedMtimeMs) || !Number.isFinite(indexedSize)) {
			dirtyFiles.push(file.absPath);
			continue;
		}
		if (file.size !== indexedSize || file.mtimeMs > indexedMtimeMs) dirtyFiles.push(file.absPath);
	}
	return dirtyFiles;
}
function resolveMemorySessionSyncPlan(params) {
	const activePaths = params.targetSessionFiles ? null : new Set(params.files.map((file) => params.sessionPathForFile(file)));
	const existingRows = activePaths === null ? null : params.existingRows ?? [];
	return {
		activePaths,
		existingRows,
		existingHashes: existingRows ? new Map(existingRows.map((row) => [row.path, row.hash])) : null,
		indexAll: params.needsFullReindex || Boolean(params.targetSessionFiles) || params.sessionsDirtyFiles.size === 0
	};
}
//#endregion
//#region extensions/memory-core/src/memory/manager-source-state.ts
const MEMORY_SOURCE_FILE_STATE_SQL = `SELECT path, hash, mtime, size FROM files WHERE source = ?`;
const MEMORY_SOURCE_FILE_HASH_SQL = `SELECT hash FROM files WHERE path = ? AND source = ?`;
function loadMemorySourceFileState(params) {
	const normalizedRows = params.db.prepare(MEMORY_SOURCE_FILE_STATE_SQL).all(params.source) ?? [];
	return {
		rows: normalizedRows,
		hashes: new Map(normalizedRows.map((row) => [row.path, row.hash]))
	};
}
function resolveMemorySourceExistingHash(params) {
	if (params.existingHashes) return params.existingHashes.get(params.path);
	return params.db.prepare(MEMORY_SOURCE_FILE_HASH_SQL).get(params.path, params.source)?.hash;
}
//#endregion
//#region extensions/memory-core/src/memory/manager-targeted-sync.ts
function clearMemorySyncedSessionFiles(params) {
	if (!params.targetSessionFiles) params.sessionsDirtyFiles.clear();
	else for (const targetSessionFile of params.targetSessionFiles) params.sessionsDirtyFiles.delete(targetSessionFile);
	return params.sessionsDirtyFiles.size > 0;
}
async function runMemoryTargetedSessionSync(params) {
	if (!params.hasSessionSource || !params.targetSessionFiles) return {
		handled: false,
		sessionsDirty: params.sessionsDirtyFiles.size > 0
	};
	try {
		await params.syncSessionFiles({
			needsFullReindex: false,
			targetSessionFiles: Array.from(params.targetSessionFiles),
			progress: params.progress
		});
		return {
			handled: true,
			sessionsDirty: clearMemorySyncedSessionFiles({
				sessionsDirtyFiles: params.sessionsDirtyFiles,
				targetSessionFiles: params.targetSessionFiles
			})
		};
	} catch (err) {
		const reason = formatErrorMessage(err);
		if (!(params.shouldFallbackOnError(reason) && await params.activateFallbackProvider(reason))) throw err;
		const reindexParams = {
			reason: params.reason,
			force: true,
			progress: params.progress
		};
		if (params.useUnsafeReindex) await params.runUnsafeReindex(reindexParams);
		else await params.runSafeReindex(reindexParams);
		return {
			handled: true,
			sessionsDirty: params.sessionsDirtyFiles.size > 0
		};
	}
}
//#endregion
//#region extensions/memory-core/src/memory/manager-sync-ops.ts
const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE$2 = "chunks_vec";
const FTS_TABLE$2 = "chunks_fts";
const EMBEDDING_CACHE_TABLE$2 = "embedding_cache";
const SESSION_DIRTY_DEBOUNCE_MS = 5e3;
const SESSION_DELTA_READ_CHUNK_BYTES = 64 * 1024;
const SESSION_SYNC_YIELD_EVERY = 10;
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
const log$3 = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
function resolveMemoryWatchFactory() {
	if (process.env.VITEST === "true" || false) {
		const override = globalThis[TEST_MEMORY_WATCH_FACTORY_KEY];
		if (typeof override === "function") return override;
	}
	return chokidar.watch.bind(chokidar);
}
function shouldIgnoreMemoryWatchPath(watchPath, stats, multimodalSettings) {
	const normalized = path.normalize(watchPath);
	if (normalized.split(path.sep).map((segment) => normalizeLowercaseStringOrEmpty(segment)).some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment))) return true;
	if (stats?.isDirectory?.()) return false;
	if (!stats) return false;
	const extension = normalizeLowercaseStringOrEmpty(path.extname(normalized));
	if (extension.length === 0 || extension === ".md") return false;
	if (!multimodalSettings) return true;
	return classifyMemoryMultimodalPath(normalized, multimodalSettings) === null;
}
function runDetachedMemorySync(sync, reason) {
	sync().catch((err) => {
		log$3.warn(`memory sync failed (${reason}): ${String(err)}`);
	});
}
function createSessionSyncYield(total) {
	let completed = 0;
	return async () => {
		completed += 1;
		if (completed < total && completed % SESSION_SYNC_YIELD_EVERY === 0) await new Promise((resolve) => {
			setImmediate(resolve);
		});
	};
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
		this.pendingWatchPaths = /* @__PURE__ */ new Map();
		this.sessionsDirty = false;
		this.sessionsDirtyFiles = /* @__PURE__ */ new Set();
		this.sessionPendingFiles = /* @__PURE__ */ new Set();
		this.sessionDeltas = /* @__PURE__ */ new Map();
		this.vectorDegradedWriteWarningShown = false;
		this.lastMetaSerialized = null;
	}
	resetVectorState() {
		this.vectorReady = null;
		this.vector.available = null;
		this.vector.semanticAvailable = void 0;
		this.vector.loadError = void 0;
		this.vector.dims = void 0;
		this.vectorDegradedWriteWarningShown = false;
	}
	async ensureVectorReady(dimensions) {
		if (!this.vector.enabled) return false;
		if (!this.vectorReady) this.vectorReady = this.withTimeout(this.loadVectorExtension(), VECTOR_LOAD_TIMEOUT_MS, `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1e3)}s`);
		let ready = false;
		try {
			ready = await this.vectorReady || false;
		} catch (err) {
			const message = formatErrorMessage(err);
			this.vector.available = false;
			this.vector.loadError = message;
			this.vectorReady = null;
			log$3.warn(`sqlite-vec unavailable: ${message}`);
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
			const message = formatErrorMessage(err);
			this.vector.available = false;
			this.vector.loadError = message;
			log$3.warn(`sqlite-vec unavailable: ${message}`);
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
			const message = formatErrorMessage(err);
			log$3.debug(`Failed to drop ${VECTOR_TABLE$2}: ${message}`);
		}
	}
	buildSourceFilter(alias, sourcesOverride) {
		const sources = sourcesOverride ?? Array.from(this.sources);
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
		return openMemoryDatabaseAtPath(resolveUserPath(this.settings.store.path), this.settings.store.vector.enabled);
	}
	async seedEmbeddingCache(sourceDb) {
		if (!this.cache.enabled) return;
		let transactionStarted = false;
		try {
			const rows = sourceDb.prepare(`SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE$2}`).iterate();
			const SEED_EMBEDDING_YIELD_EVERY = 1e3;
			let rowCount = 0;
			let insert = null;
			for (const row of rows) {
				if (!insert) {
					insert = this.db.prepare(`INSERT INTO ${EMBEDDING_CACHE_TABLE$2} (provider, model, provider_key, hash, embedding, dims, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
               embedding=excluded.embedding,
               dims=excluded.dims,
               updated_at=excluded.updated_at`);
					this.db.exec("BEGIN");
					transactionStarted = true;
				}
				insert.run(row.provider, row.model, row.provider_key, row.hash, row.embedding, row.dims, row.updated_at);
				rowCount += 1;
				if (rowCount % SEED_EMBEDDING_YIELD_EVERY === 0) await new Promise((resolve) => {
					setImmediate(resolve);
				});
			}
			if (transactionStarted) this.db.exec("COMMIT");
		} catch (err) {
			if (transactionStarted) try {
				this.db.exec("ROLLBACK");
			} catch {}
			throw err;
		}
	}
	ensureSchema() {
		const result = ensureMemoryIndexSchema({
			db: this.db,
			embeddingCacheTable: EMBEDDING_CACHE_TABLE$2,
			cacheEnabled: this.cache.enabled,
			ftsTable: FTS_TABLE$2,
			ftsEnabled: this.fts.enabled,
			ftsTokenizer: this.settings.store.fts.tokenizer
		});
		this.fts.available = result.ftsAvailable;
		if (result.ftsError) {
			this.fts.loadError = result.ftsError;
			if (this.fts.enabled) log$3.warn(`fts unavailable: ${result.ftsError}`);
		}
	}
	ensureWatcher() {
		if (!this.sources.has("memory") || !this.settings.sync.watch || this.watcher) return;
		const watchPaths = new Set([path.join(this.workspaceDir, "MEMORY.md"), path.join(this.workspaceDir, "memory")]);
		const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
		for (const entry of additionalPaths) try {
			const stat = fs.lstatSync(entry);
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				watchPaths.add(entry);
				continue;
			}
			if (stat.isFile() && (normalizeLowercaseStringOrEmpty(entry).endsWith(".md") || classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)) watchPaths.add(entry);
		} catch {}
		this.watcher = resolveMemoryWatchFactory()(Array.from(watchPaths), {
			ignoreInitial: true,
			ignored: (watchPath, stats) => shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal)
		});
		const markDirty = (watchPath, stats) => {
			recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
			this.dirty = true;
			this.scheduleWatchSync();
		};
		this.watcher.on("add", markDirty);
		this.watcher.on("change", markDirty);
		this.watcher.on("unlink", markDirty);
		this.watcher.on("unlinkDir", markDirty);
		this.watcher.on("error", (err) => {
			const message = err instanceof Error ? err.message : String(err);
			log$3.warn(`memory watcher error: ${message}`);
		});
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
	ensureSessionStartupCatchup() {
		if (!this.sources.has("sessions")) return;
		this.runSessionStartupCatchup().catch((err) => {
			log$3.warn("memory session startup catch-up failed: " + String(err));
		});
	}
	async markSessionStartupCatchupDirtyFiles() {
		if (!this.sources.has("sessions") || this.closed) return [];
		const files = await listSessionFilesForAgent(this.agentId);
		if (files.length === 0 || this.closed) return [];
		const existingRows = loadMemorySourceFileState({
			db: this.db,
			source: "sessions"
		}).rows;
		const dirtyFiles = resolveMemorySessionStartupDirtyFiles({
			files: (await runWithConcurrency(files.map((file) => async () => {
				try {
					const stat = await fs$1.stat(file);
					if (!stat.isFile()) return null;
					return {
						absPath: file,
						path: sessionPathForFile(file),
						mtimeMs: stat.mtimeMs,
						size: stat.size
					};
				} catch (err) {
					if (isFileMissingError(err)) return null;
					throw err;
				}
			}), this.getIndexConcurrency())).filter((file) => file !== null),
			existingRows
		});
		if (dirtyFiles.length === 0 || this.closed) return dirtyFiles;
		for (const file of dirtyFiles) this.sessionsDirtyFiles.add(file);
		this.sessionsDirty = true;
		return dirtyFiles;
	}
	async runSessionStartupCatchup() {
		const dirtyFiles = await this.markSessionStartupCatchupDirtyFiles();
		if (dirtyFiles.length === 0 || this.closed) return dirtyFiles;
		this.sync({ reason: "session-startup-catchup" }).catch((err) => {
			log$3.warn("memory sync failed (session-startup-catchup): " + String(err));
		});
		return dirtyFiles;
	}
	scheduleSessionDirty(sessionFile) {
		this.sessionPendingFiles.add(sessionFile);
		if (this.sessionWatchTimer) return;
		this.sessionWatchTimer = setTimeout(() => {
			this.sessionWatchTimer = null;
			this.processSessionDeltaBatch().catch((err) => {
				log$3.warn(`memory session delta failed: ${String(err)}`);
			});
		}, SESSION_DIRTY_DEBOUNCE_MS);
	}
	async processSessionDeltaBatch() {
		if (this.sessionPendingFiles.size === 0) return;
		const pending = Array.from(this.sessionPendingFiles);
		this.sessionPendingFiles.clear();
		let shouldSync = false;
		for (const sessionFile of pending) {
			const baseName = path.basename(sessionFile);
			if (isSessionArchiveArtifactName(baseName) && isUsageCountedSessionTranscriptFileName(baseName)) {
				this.sessionsDirtyFiles.add(sessionFile);
				this.sessionsDirty = true;
				shouldSync = true;
				continue;
			}
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
			log$3.warn(`memory sync failed (session-delta): ${String(err)}`);
		});
	}
	async updateSessionDelta(sessionFile) {
		const thresholds = this.settings.sync.sessions;
		if (!thresholds) return null;
		let stat;
		try {
			stat = await fs$1.stat(sessionFile);
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
			handle = await fs$1.open(absPath, "r");
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
	normalizeTargetSessionFiles(sessionFiles) {
		if (!sessionFiles || sessionFiles.length === 0) return null;
		const normalized = /* @__PURE__ */ new Set();
		for (const sessionFile of sessionFiles) {
			const trimmed = sessionFile.trim();
			if (!trimmed) continue;
			const resolved = path.resolve(trimmed);
			if (this.isSessionFileForAgent(resolved)) normalized.add(resolved);
		}
		return normalized.size > 0 ? normalized : null;
	}
	ensureIntervalSync() {
		const minutes = this.settings.sync.intervalMinutes;
		if (!minutes || minutes <= 0 || this.intervalTimer) return;
		const ms = minutes * 60 * 1e3;
		this.intervalTimer = setInterval(() => {
			runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
		}, ms);
	}
	scheduleWatchSync() {
		if (!this.sources.has("memory") || !this.settings.sync.watch) return;
		if (this.watchTimer) clearTimeout(this.watchTimer);
		this.watchTimer = setTimeout(() => {
			this.watchTimer = null;
			runDetachedMemorySync(async () => {
				if (this.closed) return;
				if (!await settleMemoryWatchEventPaths(this.pendingWatchPaths)) {
					if (!this.closed) this.scheduleWatchSync();
					return;
				}
				if (this.closed) return;
				await this.sync({ reason: "watch" });
			}, "watch");
		}, this.settings.sync.watchDebounceMs);
	}
	shouldSyncSessions(params, needsFullReindex = false) {
		return shouldSyncSessionsForReindex({
			hasSessionSource: this.sources.has("sessions"),
			sessionsDirty: this.sessionsDirty,
			dirtySessionFileCount: this.sessionsDirtyFiles.size,
			sync: params,
			needsFullReindex
		});
	}
	async syncMemoryFiles(params) {
		const deleteFileByPathAndSource = this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`);
		const deleteChunksByPathAndSource = this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`);
		const deleteVectorRowsByPathAndSource = this.vector.enabled && this.vector.available ? this.db.prepare(`DELETE FROM ${VECTOR_TABLE$2} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`) : null;
		const deleteFtsRowsByPathAndSource = this.fts.enabled && this.fts.available ? this.db.prepare(`DELETE FROM ${FTS_TABLE$2} WHERE path = ? AND source = ?`) : null;
		const fileEntries = (await runWithConcurrency((await listMemoryFiles(this.workspaceDir, this.settings.extraPaths, this.settings.multimodal)).map((file) => async () => await buildFileEntry(file, this.workspaceDir, this.settings.multimodal)), this.getIndexConcurrency())).filter((entry) => entry !== null);
		log$3.debug("memory sync: indexing memory files", {
			files: fileEntries.length,
			needsFullReindex: params.needsFullReindex,
			batch: this.batch.enabled,
			concurrency: this.getIndexConcurrency()
		});
		const existingState = loadMemorySourceFileState({
			db: this.db,
			source: "memory"
		});
		const existingRows = existingState.rows;
		const existingHashes = existingState.hashes;
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
			if (!params.needsFullReindex && existingHashes.get(entry.path) === entry.hash) {
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
		for (const stale of existingRows) {
			if (activePaths.has(stale.path)) continue;
			deleteFileByPathAndSource.run(stale.path, "memory");
			if (deleteVectorRowsByPathAndSource) try {
				deleteVectorRowsByPathAndSource.run(stale.path, "memory");
			} catch {}
			deleteChunksByPathAndSource.run(stale.path, "memory");
			if (deleteFtsRowsByPathAndSource) try {
				deleteFtsRowsByPathAndSource.run(stale.path, "memory");
			} catch {}
		}
	}
	async syncSessionFiles(params) {
		const deleteFileByPathAndSource = this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`);
		const deleteChunksByPathAndSource = this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`);
		const deleteVectorRowsByPathAndSource = this.vector.enabled && this.vector.available ? this.db.prepare(`DELETE FROM ${VECTOR_TABLE$2} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`) : null;
		const deleteFtsRowsByPathSourceAndModel = this.fts.enabled && this.fts.available ? this.db.prepare(`DELETE FROM ${FTS_TABLE$2} WHERE path = ? AND source = ? AND model = ?`) : null;
		const targetSessionFiles = params.needsFullReindex ? null : this.normalizeTargetSessionFiles(params.targetSessionFiles);
		const files = targetSessionFiles ? Array.from(targetSessionFiles) : await listSessionFilesForAgent(this.agentId);
		const { activePaths, existingRows, existingHashes, indexAll } = resolveMemorySessionSyncPlan({
			needsFullReindex: params.needsFullReindex,
			files,
			targetSessionFiles,
			sessionsDirtyFiles: this.sessionsDirtyFiles,
			existingRows: targetSessionFiles ? null : loadMemorySourceFileState({
				db: this.db,
				source: "sessions"
			}).rows,
			sessionPathForFile
		});
		log$3.debug("memory sync: indexing session files", {
			files: files.length,
			indexAll,
			dirtyFiles: this.sessionsDirtyFiles.size,
			targetedFiles: targetSessionFiles?.size ?? 0,
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
		const yieldAfterSessionFile = createSessionSyncYield(files.length);
		await runWithConcurrency(files.map((absPath) => async () => {
			try {
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
				const existingHash = resolveMemorySourceExistingHash({
					db: this.db,
					source: "sessions",
					path: entry.path,
					existingHashes
				});
				if (!params.needsFullReindex && existingHash === entry.hash) {
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
			} finally {
				await yieldAfterSessionFile();
			}
		}), this.getIndexConcurrency());
		if (activePaths === null) return;
		const staleRows = existingRows ?? [];
		const yieldAfterStaleSessionRow = createSessionSyncYield(staleRows.length);
		for (const stale of staleRows) try {
			if (activePaths.has(stale.path)) continue;
			deleteFileByPathAndSource.run(stale.path, "sessions");
			if (deleteVectorRowsByPathAndSource) try {
				deleteVectorRowsByPathAndSource.run(stale.path, "sessions");
			} catch {}
			deleteChunksByPathAndSource.run(stale.path, "sessions");
			if (deleteFtsRowsByPathSourceAndModel) try {
				deleteFtsRowsByPathSourceAndModel.run(stale.path, "sessions", this.provider?.model ?? "fts-only");
			} catch {}
		} finally {
			await yieldAfterStaleSessionRow();
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
		const configuredSources = resolveConfiguredSourcesForMeta(this.sources);
		const configuredScopeHash = resolveConfiguredScopeHash({
			workspaceDir: this.workspaceDir,
			extraPaths: this.settings.extraPaths,
			multimodal: {
				enabled: this.settings.multimodal.enabled,
				modalities: this.settings.multimodal.modalities,
				maxFileBytes: this.settings.multimodal.maxFileBytes
			}
		});
		const targetSessionFiles = this.normalizeTargetSessionFiles(params?.sessionFiles);
		const hasTargetSessionFiles = targetSessionFiles !== null;
		if (params?.reason === "cli" && !params.force && !hasTargetSessionFiles) await this.markSessionStartupCatchupDirtyFiles();
		const targetedSessionSync = await runMemoryTargetedSessionSync({
			hasSessionSource: this.sources.has("sessions"),
			targetSessionFiles,
			reason: params?.reason,
			progress: progress ?? void 0,
			useUnsafeReindex: process.env.OPENCLAW_TEST_FAST === "1" && process.env.OPENCLAW_TEST_MEMORY_UNSAFE_REINDEX === "1",
			sessionsDirtyFiles: this.sessionsDirtyFiles,
			syncSessionFiles: async (targetedParams) => {
				await this.syncSessionFiles(targetedParams);
			},
			shouldFallbackOnError: (message) => this.shouldFallbackOnError(message),
			activateFallbackProvider: async (reason) => await this.activateFallbackProvider(reason),
			runSafeReindex: async (reindexParams) => {
				await this.runSafeReindex(reindexParams);
			},
			runUnsafeReindex: async (reindexParams) => {
				await this.runUnsafeReindex(reindexParams);
			}
		});
		if (targetedSessionSync.handled) {
			this.sessionsDirty = targetedSessionSync.sessionsDirty;
			return;
		}
		const needsFullReindex = params?.force && !hasTargetSessionFiles || shouldRunFullMemoryReindex({
			meta,
			provider: this.provider ? {
				id: this.provider.id,
				model: this.provider.model
			} : null,
			providerKey: this.providerKey ?? void 0,
			configuredSources,
			configuredScopeHash,
			chunkTokens: this.settings.chunking.tokens,
			chunkOverlap: this.settings.chunking.overlap,
			vectorReady,
			ftsTokenizer: this.settings.store.fts.tokenizer
		});
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
			const shouldSyncMemory = this.sources.has("memory") && (!hasTargetSessionFiles && params?.force || needsFullReindex || this.dirty);
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
					targetSessionFiles: targetSessionFiles ? Array.from(targetSessionFiles) : void 0,
					progress: progress ?? void 0
				});
				this.sessionsDirty = false;
				this.sessionsDirtyFiles.clear();
			} else if (this.sessionsDirtyFiles.size > 0) this.sessionsDirty = true;
			else this.sessionsDirty = false;
		} catch (err) {
			const reason = formatErrorMessage(err);
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
			enabled: Boolean(batch?.enabled && this.provider && this.providerRuntime?.batchEmbed),
			wait: batch?.wait ?? true,
			concurrency: Math.max(1, batch?.concurrency ?? 2),
			pollIntervalMs: batch?.pollIntervalMs ?? 2e3,
			timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1e3
		};
	}
	async activateFallbackProvider(reason) {
		const fallbackRequest = resolveMemoryFallbackProviderRequest({
			cfg: this.cfg,
			settings: this.settings,
			currentProviderId: this.provider?.id ?? null
		});
		if (!fallbackRequest || !this.provider) return false;
		if (this.fallbackFrom) return false;
		const fallbackFrom = this.provider.id;
		const fallbackResult = await createEmbeddingProvider({
			config: this.cfg,
			agentDir: resolveAgentDir(this.cfg, this.agentId),
			...fallbackRequest
		});
		const fallbackState = applyMemoryFallbackProviderState({
			current: {
				provider: this.provider,
				fallbackFrom: this.fallbackFrom,
				fallbackReason: this.fallbackReason,
				providerUnavailableReason: void 0,
				providerRuntime: this.providerRuntime
			},
			fallbackFrom,
			reason,
			result: fallbackResult
		});
		this.fallbackFrom = fallbackState.fallbackFrom;
		this.fallbackReason = fallbackState.fallbackReason;
		this.provider = fallbackState.provider;
		this.providerRuntime = fallbackState.providerRuntime;
		this.providerKey = this.computeProviderKey();
		this.batch = this.resolveBatchConfig();
		log$3.warn(`memory embeddings: switched to fallback provider (${fallbackRequest.provider})`, { reason });
		return true;
	}
	async runSafeReindex(params) {
		const dbPath = resolveUserPath(this.settings.store.path);
		const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
		const tempDb = openMemoryDatabaseAtPath(tempDbPath, this.settings.store.vector.enabled);
		const originalDb = this.db;
		let tempDbClosed = false;
		let originalDbClosed = false;
		const originalState = {
			ftsAvailable: this.fts.available,
			ftsError: this.fts.loadError,
			vectorAvailable: this.vector.available,
			vectorLoadError: this.vector.loadError,
			vectorDims: this.vector.dims,
			vectorDegradedWriteWarningShown: this.vectorDegradedWriteWarningShown,
			vectorReady: this.vectorReady
		};
		const restoreOriginalState = () => {
			if (originalDbClosed) this.db = openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
			else this.db = originalDb;
			this.fts.available = originalState.ftsAvailable;
			this.fts.loadError = originalState.ftsError;
			this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
			this.vector.loadError = originalState.vectorLoadError;
			this.vector.dims = originalState.vectorDims;
			this.vectorDegradedWriteWarningShown = originalState.vectorDegradedWriteWarningShown;
			this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
		};
		this.db = tempDb;
		this.resetVectorState();
		this.fts.available = false;
		this.fts.loadError = void 0;
		this.ensureSchema();
		let nextMeta = null;
		try {
			nextMeta = await runMemoryAtomicReindex({
				targetPath: dbPath,
				tempPath: tempDbPath,
				beforeTempCleanup: () => {
					if (!tempDbClosed) {
						closeMemoryDatabase(tempDb);
						tempDbClosed = true;
					}
				},
				build: async () => {
					await this.seedEmbeddingCache(originalDb);
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
					const meta = {
						model: this.provider?.model ?? "fts-only",
						provider: this.provider?.id ?? "none",
						providerKey: this.providerKey,
						sources: resolveConfiguredSourcesForMeta(this.sources),
						scopeHash: resolveConfiguredScopeHash({
							workspaceDir: this.workspaceDir,
							extraPaths: this.settings.extraPaths,
							multimodal: {
								enabled: this.settings.multimodal.enabled,
								modalities: this.settings.multimodal.modalities,
								maxFileBytes: this.settings.multimodal.maxFileBytes
							}
						}),
						chunkTokens: this.settings.chunking.tokens,
						chunkOverlap: this.settings.chunking.overlap,
						ftsTokenizer: this.settings.store.fts.tokenizer
					};
					if (this.vector.available && this.vector.dims) meta.vectorDims = this.vector.dims;
					this.writeMeta(meta);
					this.pruneEmbeddingCacheIfNeeded?.();
					closeMemoryDatabase(tempDb);
					tempDbClosed = true;
					closeMemoryDatabase(originalDb);
					originalDbClosed = true;
					return meta;
				}
			});
			this.db = openMemoryDatabaseAtPath(dbPath, this.settings.store.vector.enabled);
			this.resetVectorState();
			this.ensureSchema();
			this.vector.dims = nextMeta?.vectorDims;
		} catch (err) {
			try {
				if (!tempDbClosed && this.db === tempDb) {
					closeMemoryDatabase(tempDb);
					tempDbClosed = true;
				}
			} catch {}
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
			sources: resolveConfiguredSourcesForMeta(this.sources),
			scopeHash: resolveConfiguredScopeHash({
				workspaceDir: this.workspaceDir,
				extraPaths: this.settings.extraPaths,
				multimodal: {
					enabled: this.settings.multimodal.enabled,
					modalities: this.settings.multimodal.modalities,
					maxFileBytes: this.settings.multimodal.maxFileBytes
				}
			}),
			chunkTokens: this.settings.chunking.tokens,
			chunkOverlap: this.settings.chunking.overlap,
			ftsTokenizer: this.settings.store.fts.tokenizer
		};
		if (this.vector.available && this.vector.dims) nextMeta.vectorDims = this.vector.dims;
		this.writeMeta(nextMeta);
		this.pruneEmbeddingCacheIfNeeded?.();
	}
	resetIndex() {
		this.db.exec(`DELETE FROM files`);
		this.db.exec(`DELETE FROM chunks`);
		if (this.fts.enabled && this.fts.available) try {
			this.db.exec(`DROP TABLE IF EXISTS ${FTS_TABLE$2}`);
		} catch {}
		this.ensureSchema();
		this.dropVectorTable();
		this.vector.dims = void 0;
		this.sessionsDirtyFiles.clear();
	}
	readMeta() {
		const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY);
		if (!row?.value) {
			this.lastMetaSerialized = null;
			return null;
		}
		try {
			const parsed = JSON.parse(row.value);
			this.lastMetaSerialized = row.value;
			return parsed;
		} catch {
			this.lastMetaSerialized = null;
			return null;
		}
	}
	writeMeta(meta) {
		const value = JSON.stringify(meta);
		if (this.lastMetaSerialized === value) return;
		this.db.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(META_KEY, value);
		this.lastMetaSerialized = value;
	}
};
//#endregion
//#region extensions/memory-core/src/memory/manager-vector-warning.ts
function formatMemoryVectorDegradedWriteReason(loadError) {
	return loadError ? `sqlite-vec unavailable: ${loadError}` : "semantic vector embeddings unavailable — no vector dimensions resolved";
}
function logMemoryVectorDegradedWrite(params) {
	if (!params.vectorEnabled || params.vectorReady || params.chunkCount <= 0 || params.warningShown) return params.warningShown;
	params.warn(`chunks_vec not updated — ${formatMemoryVectorDegradedWriteReason(params.loadError)}. Vector recall degraded. Further duplicate warnings suppressed.`);
	return true;
}
//#endregion
//#region extensions/memory-core/src/memory/manager-vector-write.ts
const vectorToBlob$1 = (embedding) => Buffer.from(new Float32Array(embedding).buffer);
function replaceMemoryVectorRow(params) {
	const tableName = params.tableName ?? "chunks_vec";
	try {
		params.db.prepare(`DELETE FROM ${tableName} WHERE id = ?`).run(params.id);
	} catch {}
	params.db.prepare(`INSERT INTO ${tableName} (id, embedding) VALUES (?, ?)`).run(params.id, vectorToBlob$1(params.embedding));
}
//#endregion
//#region extensions/memory-core/src/memory/manager-embedding-ops.ts
const VECTOR_TABLE$1 = "chunks_vec";
const FTS_TABLE$1 = "chunks_fts";
const EMBEDDING_CACHE_TABLE$1 = "embedding_cache";
const EMBEDDING_BATCH_MAX_TOKENS = 8e3;
const EMBEDDING_INDEX_CONCURRENCY = 4;
const EMBEDDING_RETRY_MAX_ATTEMPTS = 3;
const EMBEDDING_RETRY_BASE_DELAY_MS = 500;
const EMBEDDING_RETRY_MAX_DELAY_MS = 8e3;
const EMBEDDING_QUERY_TIMEOUT_REMOTE_MS = 6e4;
const EMBEDDING_QUERY_TIMEOUT_LOCAL_MS = 5 * 6e4;
const EMBEDDING_BATCH_TIMEOUT_REMOTE_MS = 2 * 6e4;
const EMBEDDING_BATCH_TIMEOUT_LOCAL_MS = 10 * 6e4;
const log$2 = createSubsystemLogger("memory");
function resolveEmbeddingTimeoutMs(params) {
	if (params.kind === "query") {
		const runtimeTimeoutMs = params.providerRuntime?.inlineQueryTimeoutMs;
		if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) return runtimeTimeoutMs;
		return params.providerId === "local" ? EMBEDDING_QUERY_TIMEOUT_LOCAL_MS : EMBEDDING_QUERY_TIMEOUT_REMOTE_MS;
	}
	const configuredTimeoutSeconds = params.configuredBatchTimeoutSeconds;
	if (typeof configuredTimeoutSeconds === "number" && configuredTimeoutSeconds > 0) return configuredTimeoutSeconds * 1e3;
	const runtimeTimeoutMs = params.providerRuntime?.inlineBatchTimeoutMs;
	if (typeof runtimeTimeoutMs === "number" && runtimeTimeoutMs > 0) return runtimeTimeoutMs;
	return params.providerId === "local" ? EMBEDDING_BATCH_TIMEOUT_LOCAL_MS : EMBEDDING_BATCH_TIMEOUT_REMOTE_MS;
}
function resolveMemoryIndexConcurrency(params) {
	if (params.batch.enabled) return params.batch.concurrency;
	const configured = params.configuredNonBatchConcurrency;
	if (typeof configured === "number" && Number.isFinite(configured)) return Math.max(1, Math.floor(configured));
	return params.providerId === "ollama" ? 1 : EMBEDDING_INDEX_CONCURRENCY;
}
async function runEmbeddingOperationWithTimeout(params) {
	const controller = new AbortController();
	if (!Number.isFinite(params.timeoutMs) || params.timeoutMs <= 0) return await params.run(controller.signal);
	let timer = null;
	const timeoutPromise = new Promise((_, reject) => {
		timer = setTimeout(() => {
			const error = new Error(params.message);
			reject(error);
			controller.abort(error);
		}, params.timeoutMs);
		timer.unref?.();
	});
	try {
		const operation = params.run(controller.signal);
		return await Promise.race([operation, timeoutPromise]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
var MemoryManagerEmbeddingOps = class extends MemoryManagerSyncOps {
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
		const batches = buildMemoryEmbeddingBatches(missing.map((m) => m.chunk), EMBEDDING_BATCH_MAX_TOKENS);
		const toCache = [];
		const provider = this.provider;
		if (!provider) throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
		let cursor = 0;
		for (const batch of batches) {
			const inputs = buildTextEmbeddingInputs(batch);
			const hasStructuredInputs = inputs.some((input) => hasNonTextEmbeddingParts(input));
			if (hasStructuredInputs && !provider.embedBatchInputs) throw new Error(`Embedding provider "${provider.id}" does not support multimodal memory inputs.`);
			const batchEmbeddings = hasStructuredInputs ? await this.embedBatchInputsWithRetry(inputs) : await this.embedBatchWithRetry(batch.map((chunk) => chunk.text));
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
		upsertMemoryEmbeddingCache({
			db: this.db,
			enabled: this.cache.enabled,
			provider: this.provider,
			providerKey: this.providerKey,
			entries: toCache,
			tableName: EMBEDDING_CACHE_TABLE$1
		});
		return embeddings;
	}
	computeProviderKey() {
		if (!this.provider) return hashText(JSON.stringify({
			provider: "none",
			model: "fts-only"
		}));
		if (this.providerRuntime?.cacheKeyData) return hashText(JSON.stringify(this.providerRuntime.cacheKeyData));
		return hashText(JSON.stringify({
			provider: this.provider.id,
			model: this.provider.model
		}));
	}
	buildBatchDebug(source, chunks) {
		return (message, data) => log$2.debug(message, data ? {
			...data,
			source,
			chunks: chunks.length
		} : {
			source,
			chunks: chunks.length
		});
	}
	async embedChunksWithBatch(chunks, _entry, source) {
		const provider = this.provider;
		const batchEmbed = this.providerRuntime?.batchEmbed;
		if (!provider || !batchEmbed) return this.embedChunksInBatches(chunks);
		if (chunks.length === 0) return [];
		const { embeddings, missing } = this.collectCachedEmbeddings(chunks);
		if (missing.length === 0) return embeddings;
		const missingChunks = missing.map((item) => item.chunk);
		const batchResult = await this.runBatchWithFallback({
			provider: provider.id,
			run: async () => await batchEmbed({
				agentId: this.agentId,
				chunks: missingChunks,
				wait: this.batch.wait,
				concurrency: this.batch.concurrency,
				pollIntervalMs: this.batch.pollIntervalMs,
				timeoutMs: this.batch.timeoutMs,
				debug: this.buildBatchDebug(source, chunks)
			}),
			fallback: async () => await this.embedChunksInBatches(chunks)
		});
		if (!batchResult) return this.embedChunksInBatches(chunks);
		const toCache = [];
		for (let index = 0; index < missing.length; index += 1) {
			const item = missing[index];
			const embedding = batchResult[index] ?? [];
			if (!item) continue;
			embeddings[item.index] = embedding;
			toCache.push({
				hash: item.chunk.hash,
				embedding
			});
		}
		upsertMemoryEmbeddingCache({
			db: this.db,
			enabled: this.cache.enabled,
			provider,
			providerKey: this.providerKey,
			entries: toCache,
			tableName: EMBEDDING_CACHE_TABLE$1
		});
		return embeddings;
	}
	collectCachedEmbeddings(chunks) {
		return collectMemoryCachedEmbeddings({
			chunks,
			cached: loadMemoryEmbeddingCache({
				db: this.db,
				enabled: this.cache.enabled,
				provider: this.provider,
				providerKey: this.providerKey,
				hashes: chunks.map((chunk) => chunk.hash),
				tableName: EMBEDDING_CACHE_TABLE$1
			})
		});
	}
	async embedBatchWithRetry(texts) {
		if (texts.length === 0) return [];
		const provider = this.provider;
		if (!provider) throw new Error("Cannot embed batch in FTS-only mode (no embedding provider)");
		return await runMemoryEmbeddingRetryLoop({
			run: async () => {
				const timeoutMs = this.resolveEmbeddingTimeout("batch");
				log$2.debug("memory embeddings: batch start", {
					provider: provider.id,
					items: texts.length,
					timeoutMs
				});
				return await runEmbeddingOperationWithTimeout({
					timeoutMs,
					message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1e3)}s`,
					run: async (signal) => await provider.embedBatch(texts, { signal })
				});
			},
			isRetryable: isRetryableMemoryEmbeddingError,
			waitForRetry: async (delayMs) => {
				await this.waitForEmbeddingRetry(delayMs, "retrying");
			},
			maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
			baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS
		});
	}
	async embedBatchInputsWithRetry(inputs) {
		if (inputs.length === 0) return [];
		const provider = this.provider;
		const embedBatchInputs = provider?.embedBatchInputs;
		if (!embedBatchInputs) return await this.embedBatchWithRetry(inputs.map((input) => input.text));
		return await runMemoryEmbeddingRetryLoop({
			run: async () => {
				const timeoutMs = this.resolveEmbeddingTimeout("batch");
				log$2.debug("memory embeddings: structured batch start", {
					provider: provider.id,
					items: inputs.length,
					timeoutMs
				});
				return await runEmbeddingOperationWithTimeout({
					timeoutMs,
					message: `memory embeddings batch timed out after ${Math.round(timeoutMs / 1e3)}s`,
					run: async (signal) => await embedBatchInputs(inputs, { signal })
				});
			},
			isRetryable: isRetryableMemoryEmbeddingError,
			waitForRetry: async (delayMs) => {
				await this.waitForEmbeddingRetry(delayMs, "retrying structured batch");
			},
			maxAttempts: EMBEDDING_RETRY_MAX_ATTEMPTS,
			baseDelayMs: EMBEDDING_RETRY_BASE_DELAY_MS
		});
	}
	async waitForEmbeddingRetry(delayMs, action) {
		const waitMs = resolveMemoryEmbeddingRetryDelay(delayMs, Math.random(), EMBEDDING_RETRY_MAX_DELAY_MS);
		log$2.warn(`memory embeddings rate limited; ${action} in ${waitMs}ms`);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
	resolveEmbeddingTimeout(kind) {
		return resolveEmbeddingTimeoutMs({
			kind,
			providerId: this.provider?.id,
			providerRuntime: this.providerRuntime,
			configuredBatchTimeoutSeconds: this.settings.sync.embeddingBatchTimeoutSeconds
		});
	}
	async embedQueryWithTimeout(text) {
		const provider = this.provider;
		if (!provider) throw new Error("Cannot embed query in FTS-only mode (no embedding provider)");
		const timeoutMs = this.resolveEmbeddingTimeout("query");
		log$2.debug("memory embeddings: query start", {
			provider: provider.id,
			timeoutMs
		});
		return await runEmbeddingOperationWithTimeout({
			timeoutMs,
			message: `memory embeddings query timed out after ${Math.round(timeoutMs / 1e3)}s`,
			run: async (signal) => await provider.embedQuery(text, { signal })
		});
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
			if (this.batchFailureCount > 0) log$2.debug("memory embeddings: batch recovered; resetting failure count");
			const nextState = resetMemoryBatchFailureState({
				enabled: this.batch.enabled,
				count: this.batchFailureCount,
				lastError: this.batchFailureLastError,
				lastProvider: this.batchFailureLastProvider
			});
			this.batch.enabled = nextState.enabled;
			this.batchFailureCount = nextState.count;
			this.batchFailureLastError = nextState.lastError;
			this.batchFailureLastProvider = nextState.lastProvider;
		});
	}
	async recordBatchFailure(params) {
		return await this.withBatchFailureLock(async () => {
			if (!this.batch.enabled) return {
				disabled: true,
				count: this.batchFailureCount
			};
			const nextState = recordMemoryBatchFailure({
				enabled: this.batch.enabled,
				count: this.batchFailureCount,
				lastError: this.batchFailureLastError,
				lastProvider: this.batchFailureLastProvider
			}, params);
			this.batch.enabled = nextState.enabled;
			this.batchFailureCount = nextState.count;
			this.batchFailureLastError = nextState.lastError;
			this.batchFailureLastProvider = nextState.lastProvider;
			return {
				disabled: !nextState.enabled,
				count: nextState.count
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
			const message = formatErrorMessage(err);
			if (this.isBatchTimeoutError(message)) {
				log$2.warn(`memory embeddings: ${params.provider} batch timed out; retrying once`);
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
			const message = formatErrorMessage(err);
			const attempts = err.batchAttempts ?? 1;
			const forceDisable = /asyncBatchEmbedContent not available/i.test(message);
			const failure = await this.recordBatchFailure({
				provider: params.provider,
				message,
				attempts,
				forceDisable
			});
			const suffix = failure.disabled ? "disabling batch" : "keeping batch enabled";
			log$2.warn(`memory embeddings: ${params.provider} batch failed (${failure.count}/2); ${suffix}; falling back to non-batch embeddings: ${message}`);
			return await params.fallback();
		}
	}
	getIndexConcurrency() {
		return resolveMemoryIndexConcurrency({
			batch: this.batch,
			configuredNonBatchConcurrency: this.settings.remote?.nonBatchConcurrency,
			providerId: this.provider?.id
		});
	}
	clearIndexedFileData(pathname, source) {
		if (this.vector.enabled) try {
			this.db.prepare(`DELETE FROM ${VECTOR_TABLE$1} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`).run(pathname, source);
		} catch {}
		if (this.fts.enabled && this.fts.available) try {
			deleteMemoryFtsRows({
				db: this.db,
				tableName: FTS_TABLE$1,
				path: pathname,
				source,
				currentModel: this.provider?.model
			});
		} catch {}
		this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(pathname, source);
	}
	upsertFileRecord(entry, source) {
		this.db.prepare(`INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           source=excluded.source,
           hash=excluded.hash,
           mtime=excluded.mtime,
           size=excluded.size`).run(entry.path, source, entry.hash, entry.mtimeMs, entry.size);
	}
	deleteFileRecord(pathname, source) {
		this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(pathname, source);
	}
	/**
	* Write chunks (and optional embeddings) for a file into the index.
	* Handles both the chunks table, the vector table, and the FTS table.
	* Pass an empty embeddings array to skip vector writes (FTS-only mode).
	*/
	writeChunks(entry, source, model, chunks, embeddings, vectorReady) {
		const now = Date.now();
		this.clearIndexedFileData(entry.path, source);
		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const embedding = embeddings[i] ?? [];
			const id = hashText(`${source}:${entry.path}:${chunk.startLine}:${chunk.endLine}:${chunk.hash}:${model}`);
			this.db.prepare(`INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             hash=excluded.hash,
             model=excluded.model,
             text=excluded.text,
             embedding=excluded.embedding,
             updated_at=excluded.updated_at`).run(id, entry.path, source, chunk.startLine, chunk.endLine, chunk.hash, model, chunk.text, JSON.stringify(embedding), now);
			if (vectorReady && embedding.length > 0) replaceMemoryVectorRow({
				db: this.db,
				tableName: VECTOR_TABLE$1,
				id,
				embedding
			});
			if (this.fts.enabled && this.fts.available) this.db.prepare(`INSERT INTO ${FTS_TABLE$1} (text, id, path, source, model, start_line, end_line)\n VALUES (?, ?, ?, ?, ?, ?, ?)`).run(chunk.text, id, entry.path, source, model, chunk.startLine, chunk.endLine);
		}
		this.vectorDegradedWriteWarningShown = logMemoryVectorDegradedWrite({
			vectorEnabled: this.vector.enabled,
			vectorReady,
			chunkCount: chunks.length,
			warningShown: this.vectorDegradedWriteWarningShown,
			loadError: this.vector.loadError,
			warn: (message) => log$2.warn(message)
		});
		this.upsertFileRecord(entry, source);
	}
	async indexFile(entry, options) {
		if (!this.provider) {
			if ("kind" in entry && entry.kind === "multimodal") return;
			const chunks = filterNonEmptyMemoryChunks(chunkMarkdown(options.content ?? await fs$1.readFile(entry.absPath, "utf-8"), this.settings.chunking));
			if (options.source === "sessions" && "lineMap" in entry) remapChunkLines(chunks, entry.lineMap);
			this.writeChunks(entry, options.source, "fts-only", chunks, [], false);
			return;
		}
		let chunks;
		let structuredInputBytes;
		if ("kind" in entry && entry.kind === "multimodal") {
			if (!this.provider) {
				log$2.debug("Skipping multimodal indexing in FTS-only mode", {
					path: entry.path,
					source: options.source
				});
				this.clearIndexedFileData(entry.path, options.source);
				this.upsertFileRecord(entry, options.source);
				return;
			}
			const multimodalChunk = await buildMultimodalChunkForIndexing(entry);
			if (!multimodalChunk) {
				this.clearIndexedFileData(entry.path, options.source);
				this.deleteFileRecord(entry.path, options.source);
				return;
			}
			structuredInputBytes = multimodalChunk.structuredInputBytes;
			chunks = [multimodalChunk.chunk];
		} else {
			const baseChunks = filterNonEmptyMemoryChunks(chunkMarkdown(options.content ?? await fs$1.readFile(entry.absPath, "utf-8"), this.settings.chunking));
			chunks = this.provider ? enforceEmbeddingMaxInputTokens(this.provider, baseChunks, EMBEDDING_BATCH_MAX_TOKENS) : baseChunks;
			if (options.source === "sessions" && "lineMap" in entry) remapChunkLines(chunks, entry.lineMap);
		}
		if (!this.provider) {
			this.writeChunks(entry, options.source, "fts-only", chunks, [], false);
			return;
		}
		let embeddings;
		try {
			embeddings = this.batch.enabled ? await this.embedChunksWithBatch(chunks, entry, options.source) : await this.embedChunksInBatches(chunks);
		} catch (err) {
			const message = formatErrorMessage(err);
			if ("kind" in entry && entry.kind === "multimodal" && /(413|payload too large|request too large|input too large|too many tokens|input limit|request size)/i.test(message)) {
				log$2.warn("memory embeddings: skipping multimodal file rejected as too large", {
					path: entry.path,
					bytes: structuredInputBytes,
					provider: this.provider.id,
					model: this.provider.model,
					error: message
				});
				this.clearIndexedFileData(entry.path, options.source);
				this.upsertFileRecord(entry, options.source);
				return;
			}
			throw err;
		}
		const sample = embeddings.find((embedding) => embedding.length > 0);
		const vectorReady = sample ? await this.ensureVectorReady(sample.length) : false;
		this.writeChunks(entry, options.source, this.provider.model, chunks, embeddings, vectorReady);
	}
};
//#endregion
//#region extensions/memory-core/src/memory/manager-search-preflight.ts
function resolveMemorySearchPreflight(params) {
	const normalizedQuery = params.query.trim();
	if (!normalizedQuery) return {
		normalizedQuery,
		shouldInitializeProvider: false,
		shouldSearch: false
	};
	if (!params.hasIndexedContent) return {
		normalizedQuery,
		shouldInitializeProvider: false,
		shouldSearch: false
	};
	return {
		normalizedQuery,
		shouldInitializeProvider: true,
		shouldSearch: true
	};
}
//#endregion
//#region extensions/memory-core/src/memory/manager-search.ts
const vectorToBlob = (embedding) => Buffer.from(new Float32Array(embedding).buffer);
const FTS_QUERY_TOKEN_RE = /[\p{L}\p{N}_]+/gu;
const SHORT_CJK_TRIGRAM_RE = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af\u3131-\u3163]/u;
const VECTOR_KNN_OVERSAMPLE_FACTOR = 8;
const FALLBACK_VECTOR_BATCH_SIZE = 256;
function yieldToEventLoop() {
	return new Promise((resolve) => {
		setImmediate(resolve);
	});
}
function normalizeSearchTokens(raw) {
	return raw.match(FTS_QUERY_TOKEN_RE)?.map((token) => token.trim().toLowerCase()).filter(Boolean) ?? [];
}
function scoreFallbackKeywordResult(params) {
	const queryTokens = [...new Set(normalizeSearchTokens(params.query))];
	if (queryTokens.length === 0) return params.ftsScore;
	const textTokens = normalizeSearchTokens(params.text);
	const textTokenSet = new Set(textTokens);
	const pathLower = params.path.toLowerCase();
	const overlap = queryTokens.filter((token) => textTokenSet.has(token)).length;
	const uniqueQueryOverlap = overlap / Math.max(new Set(queryTokens).size, 1);
	const density = overlap / Math.max(textTokenSet.size, 1);
	const pathBoost = queryTokens.reduce((score, token) => score + (pathLower.includes(token) ? .18 : 0), 0);
	const textLengthBoost = Math.min(params.text.length / 160, .18);
	const lexicalBoost = uniqueQueryOverlap * .45 + density * .2 + pathBoost + textLengthBoost;
	return Math.min(1, params.ftsScore + lexicalBoost);
}
function escapeLikePattern(term) {
	return term.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}
function buildMatchQueryFromTerms(terms) {
	if (terms.length === 0) return null;
	return terms.map((term) => `"${term.replaceAll("\"", "")}"`).join(" AND ");
}
function readCount(row) {
	if (typeof row?.count === "bigint") return Number(row.count);
	if (typeof row?.count === "number") return row.count;
	return 0;
}
function planKeywordSearch(params) {
	if (params.ftsTokenizer !== "trigram") return {
		matchQuery: params.buildFtsQuery(params.query),
		substringTerms: []
	};
	const tokens = params.query.match(FTS_QUERY_TOKEN_RE)?.map((token) => token.trim()).filter(Boolean) ?? [];
	if (tokens.length === 0) return {
		matchQuery: null,
		substringTerms: []
	};
	const matchTerms = [];
	const substringTerms = [];
	for (const token of tokens) {
		if (SHORT_CJK_TRIGRAM_RE.test(token) && Array.from(token).length < 3) {
			substringTerms.push(token);
			continue;
		}
		matchTerms.push(token);
	}
	return {
		matchQuery: buildMatchQueryFromTerms(matchTerms),
		substringTerms
	};
}
async function searchVector(params) {
	if (params.queryVec.length === 0 || params.limit <= 0) return [];
	if (await params.ensureVectorReady(params.queryVec.length)) {
		const qBlob = vectorToBlob(params.queryVec);
		const runVectorQuery = (candidateLimit) => params.db.prepare(`SELECT c.id, c.path, c.start_line, c.end_line, c.text,
       c.source,
       vec_distance_cosine(v.embedding, ?) AS dist
  FROM ${params.vectorTable} v\n  JOIN chunks c ON c.id = v.id\n WHERE v.embedding MATCH ? AND k = ? AND c.model = ?${params.sourceFilterVec.sql}\n ORDER BY dist ASC\n LIMIT ?`).all(qBlob, qBlob, candidateLimit, params.providerModel, ...params.sourceFilterVec.params, params.limit);
		const candidateLimit = params.limit * VECTOR_KNN_OVERSAMPLE_FACTOR;
		let rows = runVectorQuery(candidateLimit);
		if (rows.length < params.limit) {
			if (readCount(params.db.prepare(`SELECT COUNT(*) AS count FROM chunks c WHERE c.model = ?${params.sourceFilterVec.sql}`).get(params.providerModel, ...params.sourceFilterVec.params)) > rows.length) {
				const vectorCount = readCount(params.db.prepare(`SELECT COUNT(*) AS count FROM ${params.vectorTable}`).get());
				if (vectorCount > candidateLimit) rows = runVectorQuery(vectorCount);
			}
		}
		return rows.map((row) => ({
			id: row.id,
			path: row.path,
			startLine: row.start_line,
			endLine: row.end_line,
			score: 1 - row.dist,
			snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
			source: row.source
		}));
	}
	return await searchChunksByEmbedding({
		db: params.db,
		providerModel: params.providerModel,
		sourceFilter: params.sourceFilterChunks,
		queryVec: params.queryVec,
		limit: params.limit,
		snippetMaxChars: params.snippetMaxChars
	});
}
async function searchChunksByEmbedding(params) {
	if (params.limit <= 0) return [];
	const stmt = params.db.prepare(`SELECT rowid, id, path, start_line, end_line, text, embedding, source
  FROM chunks
 WHERE model = ? AND rowid > ?${params.sourceFilter.sql}\n ORDER BY rowid ASC\n LIMIT ?`);
	const topResults = [];
	let lastRowid = 0;
	while (true) {
		const batch = stmt.all(params.providerModel, lastRowid, ...params.sourceFilter.params, FALLBACK_VECTOR_BATCH_SIZE);
		if (batch.length === 0) break;
		for (const row of batch) {
			const score = cosineSimilarity(params.queryVec, parseEmbedding(row.embedding));
			if (Number.isFinite(score)) {
				const result = {
					id: row.id,
					path: row.path,
					startLine: row.start_line,
					endLine: row.end_line,
					score,
					snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
					source: row.source
				};
				if (topResults.length < params.limit) {
					topResults.push(result);
					if (topResults.length === params.limit) topResults.sort((a, b) => b.score - a.score);
				} else {
					const lowest = topResults.at(-1);
					if (lowest && result.score > lowest.score) {
						topResults[topResults.length - 1] = result;
						topResults.sort((a, b) => b.score - a.score);
					}
				}
			}
		}
		const nextRowid = batch.at(-1)?.rowid;
		lastRowid = typeof nextRowid === "bigint" ? Number(nextRowid) : nextRowid ?? lastRowid;
		if (batch.length < FALLBACK_VECTOR_BATCH_SIZE) break;
		await yieldToEventLoop();
	}
	topResults.sort((a, b) => b.score - a.score);
	return topResults;
}
async function searchKeyword(params) {
	if (params.limit <= 0) return [];
	const plan = planKeywordSearch({
		query: params.query,
		ftsTokenizer: params.ftsTokenizer,
		buildFtsQuery: params.buildFtsQuery
	});
	if (!plan.matchQuery && plan.substringTerms.length === 0) return [];
	const modelClause = params.providerModel ? " AND model = ?" : "";
	const modelParams = params.providerModel ? [params.providerModel] : [];
	const substringClause = plan.substringTerms.map(() => " AND text LIKE ? ESCAPE '\\'").join("");
	const substringParams = plan.substringTerms.map((term) => `%${escapeLikePattern(term)}%`);
	let rows;
	let usedMatch = false;
	if (plan.matchQuery) try {
		rows = params.db.prepare(`SELECT id, path, source, start_line, end_line, text,\n       bm25(${params.ftsTable}) AS rank\n  FROM ${params.ftsTable}\n WHERE ${params.ftsTable} MATCH ?${substringClause}${modelClause}${params.sourceFilter.sql}\n ORDER BY rank ASC\n LIMIT ?`).all(plan.matchQuery, ...substringParams, ...modelParams, ...params.sourceFilter.params, params.limit);
		usedMatch = true;
	} catch (matchErr) {
		console.warn(`memory search: FTS5 MATCH failed, falling back to LIKE: ${String(matchErr)}`);
		const queryTokens = params.query.match(FTS_QUERY_TOKEN_RE)?.map((t) => t.trim()).filter(Boolean) ?? [];
		const allTerms = [...new Set([...queryTokens, ...plan.substringTerms])];
		const fallbackLikeClause = allTerms.map(() => " AND text LIKE ? ESCAPE '\\'").join("");
		const fallbackLikeParams = allTerms.map((term) => `%${escapeLikePattern(term)}%`);
		rows = params.db.prepare(`SELECT id, path, source, start_line, end_line, text,
       0 AS rank
  FROM ${params.ftsTable}\n WHERE 1=1${fallbackLikeClause}${modelClause}${params.sourceFilter.sql}\n LIMIT ?`).all(...fallbackLikeParams, ...modelParams, ...params.sourceFilter.params, params.limit);
	}
	else rows = params.db.prepare(`SELECT id, path, source, start_line, end_line, text,
       0 AS rank
  FROM ${params.ftsTable}\n WHERE 1=1${substringClause}${modelClause}${params.sourceFilter.sql}\n LIMIT ?`).all(...substringParams, ...modelParams, ...params.sourceFilter.params, params.limit);
	return rows.map((row) => {
		const textScore = usedMatch ? params.bm25RankToScore(row.rank) : 1;
		const score = params.boostFallbackRanking ? scoreFallbackKeywordResult({
			query: params.query,
			path: row.path,
			text: row.text,
			ftsScore: textScore
		}) : textScore;
		return {
			id: row.id,
			path: row.path,
			startLine: row.start_line,
			endLine: row.end_line,
			score,
			textScore,
			snippet: truncateUtf16Safe(row.text, params.snippetMaxChars),
			source: row.source
		};
	});
}
//#endregion
//#region extensions/memory-core/src/memory/manager-status-state.ts
const MEMORY_STATUS_AGGREGATE_SQL = "SELECT 'files' AS kind, source, COUNT(*) as c FROM files WHERE 1=1__FILTER__ GROUP BY source\nUNION ALL\nSELECT 'chunks' AS kind, source, COUNT(*) as c FROM chunks WHERE 1=1__FILTER__ GROUP BY source";
function resolveInitialMemoryDirty(params) {
	return params.hasMemorySource && (params.statusOnly ? !params.hasIndexedMeta : true);
}
function resolveStatusProviderInfo(params) {
	if (params.provider) return {
		provider: params.provider.id,
		model: params.provider.model,
		searchMode: "hybrid"
	};
	if (params.providerInitialized) return {
		provider: "none",
		model: void 0,
		searchMode: "fts-only"
	};
	return {
		provider: params.requestedProvider,
		model: params.configuredModel || void 0,
		searchMode: "hybrid"
	};
}
function collectMemoryStatusAggregate(params) {
	const sources = Array.from(params.sources);
	const bySource = /* @__PURE__ */ new Map();
	for (const source of sources) bySource.set(source, {
		files: 0,
		chunks: 0
	});
	const sourceFilterSql = params.sourceFilterSql ?? "";
	const sourceFilterParams = params.sourceFilterParams ?? [];
	const aggregateRows = params.db.prepare(MEMORY_STATUS_AGGREGATE_SQL.replaceAll("__FILTER__", sourceFilterSql)).all(...sourceFilterParams, ...sourceFilterParams);
	let files = 0;
	let chunks = 0;
	for (const row of aggregateRows) {
		const count = row.c ?? 0;
		const entry = bySource.get(row.source) ?? {
			files: 0,
			chunks: 0
		};
		if (row.kind === "files") {
			entry.files = count;
			files += count;
		} else {
			entry.chunks = count;
			chunks += count;
		}
		bySource.set(row.source, entry);
	}
	return {
		files,
		chunks,
		sourceCounts: sources.map((source) => Object.assign({ source }, bySource.get(source)))
	};
}
//#endregion
//#region extensions/memory-core/src/memory/manager-sync-control.ts
const log$1 = createSubsystemLogger("memory");
function isMemoryReadonlyDbError(err) {
	const readonlyPattern = /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
	const messages = /* @__PURE__ */ new Set();
	const pushValue = (value) => {
		if (typeof value !== "string") return;
		const normalized = value.trim();
		if (!normalized) return;
		messages.add(normalized);
	};
	pushValue(formatErrorMessage(err));
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
function extractMemoryErrorReason(err) {
	if (err instanceof Error && err.message.trim()) return err.message;
	if (err && typeof err === "object") {
		const record = err;
		if (typeof record.message === "string" && record.message.trim()) return record.message;
		if (typeof record.code === "string" && record.code.trim()) return record.code;
	}
	return String(err);
}
async function runMemorySyncWithReadonlyRecovery(state, params) {
	try {
		await state.runSync(params);
		return;
	} catch (err) {
		if (!isMemoryReadonlyDbError(err) || state.closed) throw err;
		const reason = extractMemoryErrorReason(err);
		state.readonlyRecoveryAttempts += 1;
		state.readonlyRecoveryLastError = reason;
		log$1.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
		try {
			state.closeDatabase(state.db);
		} catch {}
		const previousVectorDims = state.vector.dims;
		state.db = state.openDatabase();
		state.resetVectorState();
		state.ensureSchema();
		const meta = state.readMeta();
		state.vector.dims = meta?.vectorDims ?? previousVectorDims;
		try {
			await state.runSync(params);
			state.readonlyRecoverySuccesses += 1;
		} catch (retryErr) {
			state.readonlyRecoveryFailures += 1;
			throw retryErr;
		}
	}
}
function enqueueMemoryTargetedSessionSync(state, sessionFiles) {
	const queuedSessionFiles = state.getQueuedSessionFiles();
	for (const sessionFile of sessionFiles ?? []) {
		const trimmed = sessionFile.trim();
		if (trimmed) queuedSessionFiles.add(trimmed);
	}
	if (queuedSessionFiles.size === 0) return state.getSyncing() ?? Promise.resolve();
	if (!state.getQueuedSessionSync()) state.setQueuedSessionSync((async () => {
		try {
			await state.getSyncing()?.catch(() => void 0);
			while (!state.isClosed() && state.getQueuedSessionFiles().size > 0) {
				const pendingSessionFiles = Array.from(state.getQueuedSessionFiles());
				state.getQueuedSessionFiles().clear();
				await state.sync({
					reason: "queued-session-files",
					sessionFiles: pendingSessionFiles
				});
			}
		} finally {
			state.setQueuedSessionSync(null);
		}
	})());
	return state.getQueuedSessionSync() ?? Promise.resolve();
}
//#endregion
//#region extensions/memory-core/src/memory/manager.ts
const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const MEMORY_INDEX_MANAGER_CACHE_KEY = Symbol.for("openclaw.memoryIndexManagerCache");
const EMBEDDING_PROBE_CACHE_TTL_MS = 3e4;
const log = createSubsystemLogger("memory");
const { cache: INDEX_CACHE, pending: INDEX_CACHE_PENDING } = resolveSingletonManagedCache(MEMORY_INDEX_MANAGER_CACHE_KEY);
const EMBEDDING_PROBE_CACHE = /* @__PURE__ */ new Map();
async function closeAllMemoryIndexManagers() {
	EMBEDDING_PROBE_CACHE.clear();
	await closeManagedCacheEntries({
		cache: INDEX_CACHE,
		pending: INDEX_CACHE_PENDING,
		onCloseError: (err) => {
			log.warn(`failed to close memory index manager: ${String(err)}`);
		}
	});
}
async function closeMemoryIndexManagersForAgent(params) {
	const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
	if (!settings) return;
	const workspaceDir = resolveAgentWorkspaceDir(params.cfg, params.agentId);
	const key = `${params.agentId}:${workspaceDir}:${JSON.stringify(settings)}:default`;
	const pending = INDEX_CACHE_PENDING.get(key);
	if (pending) await Promise.allSettled([pending]);
	const manager = INDEX_CACHE.get(key);
	if (!manager) return;
	INDEX_CACHE.delete(key);
	try {
		await manager.close();
	} catch (err) {
		log.warn(`failed to close memory index manager for agent ${params.agentId}: ${String(err)}`);
	}
}
var MemoryIndexManager = class MemoryIndexManager extends MemoryManagerEmbeddingOps {
	static async loadProviderResult(params) {
		return await createEmbeddingProvider({
			config: params.cfg,
			agentDir: resolveAgentDir(params.cfg, params.agentId),
			...resolveMemoryPrimaryProviderRequest({ settings: params.settings })
		});
	}
	static async get(params) {
		const { cfg, agentId } = params;
		const settings = resolveMemorySearchConfig(cfg, agentId);
		if (!settings) return null;
		const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
		const purpose = params.purpose === "status" || params.purpose === "cli" ? params.purpose : "default";
		const key = `${agentId}:${workspaceDir}:${JSON.stringify(settings)}:${purpose}`;
		return await getOrCreateManagedCacheEntry({
			cache: INDEX_CACHE,
			pending: INDEX_CACHE_PENDING,
			key,
			bypassCache: purpose === "status" || purpose === "cli",
			create: async () => new MemoryIndexManager({
				cacheKey: key,
				cfg,
				agentId,
				workspaceDir,
				settings,
				purpose: params.purpose
			})
		});
	}
	constructor(params) {
		super();
		this.providerInitPromise = null;
		this.providerInitialized = false;
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
		this.queuedSessionFiles = /* @__PURE__ */ new Set();
		this.queuedSessionSync = null;
		this.readonlyRecoveryAttempts = 0;
		this.readonlyRecoverySuccesses = 0;
		this.readonlyRecoveryFailures = 0;
		this.cacheKey = params.cacheKey;
		this.cfg = params.cfg;
		this.agentId = params.agentId;
		this.workspaceDir = params.workspaceDir;
		this.settings = params.settings;
		this.provider = null;
		this.requestedProvider = params.settings.provider;
		if (params.providerResult) this.applyProviderResult(params.providerResult);
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
		const transient = params.purpose === "status" || params.purpose === "cli";
		if (!transient) {
			this.ensureWatcher();
			this.ensureSessionListener();
			this.ensureIntervalSync();
		}
		this.dirty = resolveInitialMemoryDirty({
			hasMemorySource: this.sources.has("memory"),
			statusOnly: params.purpose === "status",
			hasIndexedMeta: Boolean(meta)
		});
		this.batch = this.resolveBatchConfig();
		if (!transient) this.ensureSessionStartupCatchup();
	}
	applyProviderResult(providerResult) {
		const providerState = resolveMemoryProviderState(providerResult);
		this.provider = providerState.provider;
		this.fallbackFrom = providerState.fallbackFrom;
		this.fallbackReason = providerState.fallbackReason;
		this.providerUnavailableReason = providerState.providerUnavailableReason;
		this.providerRuntime = providerState.providerRuntime;
		this.providerInitialized = true;
	}
	async ensureProviderInitialized() {
		if (this.providerInitialized) return;
		if (!this.providerInitPromise) this.providerInitPromise = (async () => {
			const providerResult = await MemoryIndexManager.loadProviderResult({
				cfg: this.cfg,
				agentId: this.agentId,
				settings: this.settings
			});
			this.applyProviderResult(providerResult);
			this.providerKey = this.computeProviderKey();
			this.batch = this.resolveBatchConfig();
		})();
		try {
			await this.providerInitPromise;
		} finally {
			if (this.providerInitialized) this.providerInitPromise = null;
		}
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
		opts?.onDebug?.({ backend: "builtin" });
		let hasIndexedContent = this.hasIndexedContent();
		if (!hasIndexedContent) {
			try {
				await this.sync({
					reason: "search",
					force: true
				});
			} catch (err) {
				log.warn(`memory sync failed (search-bootstrap): ${String(err)}`);
			}
			hasIndexedContent = this.hasIndexedContent();
		}
		const preflight = resolveMemorySearchPreflight({
			query,
			hasIndexedContent
		});
		if (!preflight.shouldSearch) return [];
		const cleaned = preflight.normalizedQuery;
		this.warmSession(opts?.sessionKey);
		startAsyncSearchSync({
			enabled: this.settings.sync.onSearch,
			dirty: this.dirty,
			sessionsDirty: this.sessionsDirty,
			sync: async (params) => await this.sync(params),
			onError: (err) => {
				log.warn(`memory sync failed (search): ${String(err)}`);
			}
		});
		if (preflight.shouldInitializeProvider) await this.ensureProviderInitialized();
		const minScore = opts?.minScore ?? this.settings.query.minScore;
		const maxResults = opts?.maxResults ?? this.settings.query.maxResults;
		const searchSources = opts?.sources && opts.sources.length > 0 ? [...new Set(opts.sources)].filter((s) => this.sources.has(s)) : void 0;
		if (opts?.sources && opts.sources.length > 0 && (!searchSources || searchSources.length === 0)) return [];
		const sourceFilterList = searchSources ?? [...this.sources];
		const hybrid = this.settings.query.hybrid;
		const candidates = Math.min(200, Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)));
		if (!this.provider) {
			if (!this.fts.enabled || !this.fts.available) {
				log.warn("memory search: no provider and FTS unavailable");
				return [];
			}
			const fullQueryResults = await this.searchKeyword(cleaned, candidates, { boostFallbackRanking: true }, sourceFilterList).catch((err) => {
				log.warn(`memory search: FTS keyword query failed: ${formatErrorMessage(err)}`);
				return [];
			});
			const resultSets = fullQueryResults.length > 0 ? [fullQueryResults] : await Promise.all((() => {
				const keywords = extractKeywords(cleaned, { ftsTokenizer: this.settings.store.fts.tokenizer });
				return (keywords.length > 0 ? keywords : [cleaned]).map((term) => this.searchKeyword(term, candidates, { boostFallbackRanking: true }, sourceFilterList).catch((err) => {
					log.warn(`memory search: FTS per-keyword query failed for "${term}": ${formatErrorMessage(err)}`);
					return [];
				}));
			})());
			const seenIds = /* @__PURE__ */ new Map();
			for (const results of resultSets) for (const result of results) {
				const existing = seenIds.get(result.id);
				if (!existing || result.score > existing.score) seenIds.set(result.id, result);
			}
			const sorted = (await applyTemporalDecayToHybridResults({
				results: [...seenIds.values()],
				temporalDecay: hybrid.temporalDecay,
				workspaceDir: this.workspaceDir
			})).toSorted((a, b) => b.score - a.score);
			return this.selectScoredResults(sorted, maxResults, minScore, 0);
		}
		const keywordResults = hybrid.enabled && this.fts.enabled && this.fts.available ? await this.searchKeyword(cleaned, candidates, { boostFallbackRanking: true }, sourceFilterList).catch((err) => {
			log.warn(`memory search: FTS hybrid keyword query failed: ${formatErrorMessage(err)}`);
			return [];
		}) : [];
		const queryVec = await this.embedQueryWithTimeout(cleaned);
		const vectorResults = queryVec.some((v) => v !== 0) ? await this.searchVector(queryVec, candidates, sourceFilterList).catch((err) => {
			log.warn(`memory search: vector query failed: ${formatErrorMessage(err)}`);
			return [];
		}) : [];
		if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
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
		const relaxedMinScore = 0;
		const keywordKeys = new Set(keywordResults.map((entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`));
		return this.selectScoredResults(merged.filter((entry) => keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`)), maxResults, minScore, relaxedMinScore);
	}
	selectScoredResults(results, maxResults, minScore, relaxedMinScore = minScore) {
		const strict = results.filter((entry) => entry.score >= minScore);
		if (strict.length > 0) return strict.slice(0, maxResults);
		return results.filter((entry) => entry.score >= relaxedMinScore).slice(0, maxResults);
	}
	hasIndexedContent() {
		if (this.db.prepare(`SELECT 1 as found FROM chunks LIMIT 1`).get()?.found === 1) return true;
		if (!this.fts.enabled || !this.fts.available) return false;
		return this.db.prepare(`SELECT 1 as found FROM ${FTS_TABLE} LIMIT 1`).get()?.found === 1;
	}
	async searchVector(queryVec, limit, sourceFilterList) {
		if (!this.provider) return [];
		return (await searchVector({
			db: this.db,
			vectorTable: VECTOR_TABLE,
			providerModel: this.provider.model,
			queryVec,
			limit,
			snippetMaxChars: SNIPPET_MAX_CHARS,
			ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
			sourceFilterVec: this.buildSourceFilter("c", sourceFilterList),
			sourceFilterChunks: this.buildSourceFilter(void 0, sourceFilterList)
		})).map((entry) => entry);
	}
	buildFtsQuery(raw) {
		return buildFtsQuery(raw);
	}
	async searchKeyword(query, limit, options, sourceFilterList) {
		if (!this.fts.enabled || !this.fts.available) return [];
		const sourceFilter = this.buildSourceFilter(void 0, sourceFilterList);
		const providerModel = this.provider?.model;
		return (await searchKeyword({
			db: this.db,
			ftsTable: FTS_TABLE,
			providerModel,
			query,
			ftsTokenizer: this.settings.store.fts.tokenizer,
			limit,
			snippetMaxChars: SNIPPET_MAX_CHARS,
			sourceFilter,
			buildFtsQuery: (raw) => this.buildFtsQuery(raw),
			bm25RankToScore,
			boostFallbackRanking: options?.boostFallbackRanking
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
		await this.ensureProviderInitialized();
		if (this.syncing) {
			if (params?.sessionFiles?.some((sessionFile) => sessionFile.trim().length > 0)) return this.enqueueTargetedSessionSync(params.sessionFiles);
			return this.syncing;
		}
		this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
			this.syncing = null;
		});
		return this.syncing ?? Promise.resolve();
	}
	enqueueTargetedSessionSync(sessionFiles) {
		return enqueueMemoryTargetedSessionSync({
			isClosed: () => this.closed,
			getSyncing: () => this.syncing,
			getQueuedSessionFiles: () => this.queuedSessionFiles,
			getQueuedSessionSync: () => this.queuedSessionSync,
			setQueuedSessionSync: (value) => {
				this.queuedSessionSync = value;
			},
			sync: async (params) => await this.sync(params)
		}, sessionFiles);
	}
	async runSyncWithReadonlyRecovery(params) {
		const getClosed = () => this.closed;
		const getDb = () => this.db;
		const setDb = (value) => {
			this.db = value;
		};
		const getReadonlyRecoveryAttempts = () => this.readonlyRecoveryAttempts;
		const setReadonlyRecoveryAttempts = (value) => {
			this.readonlyRecoveryAttempts = value;
		};
		const getReadonlyRecoverySuccesses = () => this.readonlyRecoverySuccesses;
		const setReadonlyRecoverySuccesses = (value) => {
			this.readonlyRecoverySuccesses = value;
		};
		const getReadonlyRecoveryFailures = () => this.readonlyRecoveryFailures;
		const setReadonlyRecoveryFailures = (value) => {
			this.readonlyRecoveryFailures = value;
		};
		const getReadonlyRecoveryLastError = () => this.readonlyRecoveryLastError;
		const setReadonlyRecoveryLastError = (value) => {
			this.readonlyRecoveryLastError = value;
		};
		await runMemorySyncWithReadonlyRecovery({
			get closed() {
				return getClosed();
			},
			get db() {
				return getDb();
			},
			set db(value) {
				setDb(value);
			},
			vector: this.vector,
			get readonlyRecoveryAttempts() {
				return getReadonlyRecoveryAttempts();
			},
			set readonlyRecoveryAttempts(value) {
				setReadonlyRecoveryAttempts(value);
			},
			get readonlyRecoverySuccesses() {
				return getReadonlyRecoverySuccesses();
			},
			set readonlyRecoverySuccesses(value) {
				setReadonlyRecoverySuccesses(value);
			},
			get readonlyRecoveryFailures() {
				return getReadonlyRecoveryFailures();
			},
			set readonlyRecoveryFailures(value) {
				setReadonlyRecoveryFailures(value);
			},
			get readonlyRecoveryLastError() {
				return getReadonlyRecoveryLastError();
			},
			set readonlyRecoveryLastError(value) {
				setReadonlyRecoveryLastError(value);
			},
			runSync: (nextParams) => this.runSync(nextParams),
			openDatabase: () => this.openDatabase(),
			closeDatabase: (db) => closeMemoryDatabase(db),
			resetVectorState: () => this.resetVectorState(),
			ensureSchema: () => this.ensureSchema(),
			readMeta: () => this.readMeta() ?? void 0
		}, params);
	}
	async readFile(params) {
		return await readMemoryFile({
			workspaceDir: this.workspaceDir,
			extraPaths: this.settings.extraPaths,
			relPath: params.relPath,
			from: params.from,
			lines: params.lines
		});
	}
	status() {
		const sourceFilter = this.buildSourceFilter();
		const aggregateState = collectMemoryStatusAggregate({
			db: { prepare: (sql) => ({ all: (...args) => this.db.prepare(sql).all(...args) }) },
			sources: this.sources,
			sourceFilterSql: sourceFilter.sql,
			sourceFilterParams: sourceFilter.params
		});
		const providerInfo = resolveStatusProviderInfo({
			provider: this.provider,
			providerInitialized: this.providerInitialized,
			requestedProvider: this.requestedProvider,
			configuredModel: this.settings.model || void 0
		});
		return {
			backend: "builtin",
			files: aggregateState.files,
			chunks: aggregateState.chunks,
			dirty: this.dirty || this.sessionsDirty,
			workspaceDir: this.workspaceDir,
			dbPath: this.settings.store.path,
			provider: providerInfo.provider,
			model: providerInfo.model,
			requestedProvider: this.requestedProvider,
			sources: Array.from(this.sources),
			extraPaths: this.settings.extraPaths,
			sourceCounts: aggregateState.sourceCounts,
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
				storeAvailable: this.vector.available ?? void 0,
				semanticAvailable: this.vector.semanticAvailable,
				available: this.vector.semanticAvailable,
				extensionPath: this.vector.extensionPath,
				loadError: this.vector.loadError,
				dims: this.vector.dims
			},
			batch: {
				enabled: this.batch.enabled,
				failures: this.batchFailureCount,
				limit: 2,
				wait: this.batch.wait,
				concurrency: this.batch.concurrency,
				pollIntervalMs: this.batch.pollIntervalMs,
				timeoutMs: this.batch.timeoutMs,
				lastError: this.batchFailureLastError,
				lastProvider: this.batchFailureLastProvider
			},
			custom: {
				searchMode: providerInfo.searchMode,
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
		if (!this.vector.enabled) {
			this.vector.semanticAvailable = false;
			return false;
		}
		await this.ensureProviderInitialized();
		if (!this.provider) {
			this.vector.semanticAvailable = false;
			return false;
		}
		const ready = await this.probeVectorStoreAvailability();
		this.vector.semanticAvailable = ready;
		return ready;
	}
	async probeVectorStoreAvailability() {
		if (!this.vector.enabled) {
			this.vector.available = false;
			return false;
		}
		return await this.ensureVectorReady();
	}
	cacheProbeResult(result) {
		const checkedAtMs = Date.now();
		EMBEDDING_PROBE_CACHE.set(this.cacheKey, {
			result,
			checkedAtMs,
			expireAtMs: checkedAtMs + EMBEDDING_PROBE_CACHE_TTL_MS
		});
		return result;
	}
	getCachedEmbeddingAvailability() {
		const cached = EMBEDDING_PROBE_CACHE.get(this.cacheKey);
		if (!cached) return null;
		if (Date.now() >= cached.expireAtMs) {
			EMBEDDING_PROBE_CACHE.delete(this.cacheKey);
			return null;
		}
		return {
			...cached.result,
			checked: true,
			cached: true,
			checkedAtMs: cached.checkedAtMs,
			cacheExpiresAtMs: cached.expireAtMs
		};
	}
	async probeEmbeddingAvailability() {
		const cached = this.getCachedEmbeddingAvailability();
		if (cached) return cached;
		await this.ensureProviderInitialized();
		if (!this.provider) return this.cacheProbeResult({
			ok: false,
			error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)"
		});
		try {
			await this.embedBatchWithRetry(["ping"]);
			return this.cacheProbeResult({ ok: true });
		} catch (err) {
			const message = formatErrorMessage(err);
			return this.cacheProbeResult({
				ok: false,
				error: message
			});
		}
	}
	async close() {
		if (this.closed) return;
		this.closed = true;
		const pendingSync = this.syncing;
		const pendingProviderInit = this.providerInitPromise;
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
		const closeErrors = /* @__PURE__ */ new Map();
		const closeCurrentProvider = async () => {
			const provider = this.provider;
			if (!provider) return;
			try {
				await provider.close?.();
				closeErrors.delete(provider);
				if (this.provider === provider) this.provider = null;
			} catch (err) {
				closeErrors.set(provider, err);
			}
		};
		await awaitPendingManagerWork({ pendingProviderInit });
		await closeCurrentProvider();
		try {
			await awaitPendingManagerWork({ pendingSync });
			await closeCurrentProvider();
		} finally {
			closeMemoryDatabase(this.db);
			if (INDEX_CACHE.get(this.cacheKey) === this) INDEX_CACHE.delete(this.cacheKey);
		}
		const closeError = closeErrors.values().next().value;
		if (closeError) throw closeError;
	}
};
//#endregion
export { createEmbeddingProvider as a, formatMemoryVectorDegradedWriteReason as i, closeAllMemoryIndexManagers as n, closeMemoryIndexManagersForAgent as r, MemoryIndexManager as t };
