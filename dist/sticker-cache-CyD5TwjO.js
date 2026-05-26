import { a as normalizeLowercaseStringOrEmpty } from "./string-coerce-LndEvhRk.js";
import { v as resolveStateDir } from "./paths-Cnwfh6dH.js";
import { r as logVerbose } from "./globals-CouSpJO4.js";
import { C as findModelInCatalog } from "./model-selection-shared-Dh1KrVmr.js";
import { s as resolveDefaultModelForAgent } from "./model-selection-VRXWv5rs.js";
import { a as modelSupportsVision, r as loadModelCatalog } from "./model-catalog-Bej-qOX2.js";
import { r as saveJsonFile, t as loadJsonFile } from "./json-store-BUuXUY1y.js";
import { l as resolveApiKeyForProvider } from "./model-auth-_bXIM30P.js";
import { n as resolveAutoMediaKeyProviders, r as resolveDefaultMediaModel } from "./defaults-C7Hv5EKy.js";
import { r as resolveAutoImageModel } from "./runner-DjFT6is3.js";
import "./runtime-env-AKjXcC53.js";
import "./string-coerce-runtime-Ce59bOpy.js";
import "./state-paths-DTRyq4vN.js";
import "./media-runtime-DWh6m_8p.js";
import "./agent-runtime-C0lBBqMR.js";
import { t as getTelegramRuntime } from "./runtime-D_DhIHtY.js";
import path from "node:path";
//#region extensions/telegram/src/sticker-cache-store.ts
const CACHE_VERSION = 1;
function getCacheFile() {
	return path.join(resolveStateDir(), "telegram", "sticker-cache.json");
}
function loadCache() {
	const data = loadJsonFile(getCacheFile());
	if (!data || typeof data !== "object") return {
		version: CACHE_VERSION,
		stickers: {}
	};
	const cache = data;
	if (cache.version !== CACHE_VERSION) return {
		version: CACHE_VERSION,
		stickers: {}
	};
	return cache;
}
function saveCache(cache) {
	saveJsonFile(getCacheFile(), cache);
}
function normalizeStickerSearchText(value) {
	return typeof value === "string" ? value.trim().toLowerCase() : "";
}
/**
* Get a cached sticker by its unique ID.
*/
function getCachedSticker(fileUniqueId) {
	return loadCache().stickers[fileUniqueId] ?? null;
}
/**
* Add or update a sticker in the cache.
*/
function cacheSticker(sticker) {
	const cache = loadCache();
	cache.stickers[sticker.fileUniqueId] = sticker;
	saveCache(cache);
}
/**
* Search cached stickers by text query (fuzzy match on description + emoji + setName).
*/
function searchStickers(query, limit = 10) {
	const cache = loadCache();
	const queryLower = normalizeStickerSearchText(query);
	const results = [];
	for (const sticker of Object.values(cache.stickers)) {
		let score = 0;
		const descLower = normalizeStickerSearchText(sticker.description);
		if (descLower.includes(queryLower)) score += 10;
		const queryWords = queryLower.split(/\s+/).filter(Boolean);
		const descWords = descLower.split(/\s+/);
		for (const qWord of queryWords) if (descWords.some((dWord) => dWord.includes(qWord))) score += 5;
		if (sticker.emoji && query.includes(sticker.emoji)) score += 8;
		if (normalizeStickerSearchText(sticker.setName).includes(queryLower)) score += 3;
		if (score > 0) results.push({
			sticker,
			score
		});
	}
	return results.toSorted((a, b) => b.score - a.score).slice(0, limit).map((r) => r.sticker);
}
/**
* Get all cached stickers (for debugging/listing).
*/
function getAllCachedStickers() {
	const cache = loadCache();
	return Object.values(cache.stickers);
}
/**
* Get cache statistics.
*/
function getCacheStats() {
	const cache = loadCache();
	const stickers = Object.values(cache.stickers);
	if (stickers.length === 0) return { count: 0 };
	const sorted = [...stickers].toSorted((a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime());
	return {
		count: stickers.length,
		oldestAt: sorted[0]?.cachedAt,
		newestAt: sorted[sorted.length - 1]?.cachedAt
	};
}
//#endregion
//#region extensions/telegram/src/sticker-cache.ts
const STICKER_DESCRIPTION_PROMPT = "Describe this sticker image in 1-2 sentences. Focus on what the sticker depicts (character, object, action, emotion). Be concise and objective.";
/**
* Describe a sticker image using vision API.
* Auto-detects an available vision provider based on configured API keys.
* Returns null if no vision provider is available.
*/
async function describeStickerImage(params) {
	const { imagePath, cfg, agentDir, agentId } = params;
	const defaultModel = resolveDefaultModelForAgent({
		cfg,
		agentId
	});
	let activeModel = void 0;
	let catalog = [];
	try {
		catalog = await loadModelCatalog({ config: cfg });
		if (modelSupportsVision(findModelInCatalog(catalog, defaultModel.provider, defaultModel.model))) activeModel = {
			provider: defaultModel.provider,
			model: defaultModel.model
		};
	} catch {}
	const hasProviderKey = async (provider) => {
		try {
			await resolveApiKeyForProvider({
				provider,
				cfg,
				agentDir
			});
			return true;
		} catch {
			return false;
		}
	};
	const autoProviders = resolveAutoMediaKeyProviders({
		cfg,
		capability: "image"
	});
	const selectCatalogModel = (provider) => {
		const entries = catalog.filter((entry) => normalizeLowercaseStringOrEmpty(entry.provider) === normalizeLowercaseStringOrEmpty(provider) && modelSupportsVision(entry));
		if (entries.length === 0) return;
		const defaultId = resolveDefaultMediaModel({
			cfg,
			providerId: provider,
			capability: "image"
		});
		return entries.find((entry) => entry.id === defaultId) ?? entries[0];
	};
	let resolved = null;
	if (activeModel && autoProviders.includes(activeModel.provider) && await hasProviderKey(activeModel.provider)) resolved = activeModel;
	if (!resolved) for (const provider of autoProviders) {
		if (!await hasProviderKey(provider)) continue;
		const entry = selectCatalogModel(provider);
		if (entry) {
			resolved = {
				provider,
				model: entry.id
			};
			break;
		}
	}
	if (!resolved) resolved = await resolveAutoImageModel({
		cfg,
		agentDir,
		activeModel
	});
	if (!resolved?.model) {
		logVerbose("telegram: no vision provider available for sticker description");
		return null;
	}
	const { provider, model } = resolved;
	logVerbose(`telegram: describing sticker with ${provider}/${model}`);
	try {
		return (await getTelegramRuntime().mediaUnderstanding.describeImageFileWithModel({
			filePath: imagePath,
			mime: "image/webp",
			cfg,
			agentDir,
			provider,
			model,
			prompt: STICKER_DESCRIPTION_PROMPT,
			maxTokens: 150,
			timeoutMs: 3e4
		})).text ?? null;
	} catch (err) {
		logVerbose(`telegram: failed to describe sticker: ${String(err)}`);
		return null;
	}
}
//#endregion
export { getCachedSticker as a, getCacheStats as i, cacheSticker as n, searchStickers as o, getAllCachedStickers as r, describeStickerImage as t };
