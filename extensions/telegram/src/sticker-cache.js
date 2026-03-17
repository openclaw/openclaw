import fs from "node:fs/promises";
import path from "node:path";
import { resolveApiKeyForProvider } from "../../../src/agents/model-auth.js";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision
} from "../../../src/agents/model-catalog.js";
import { resolveDefaultModelForAgent } from "../../../src/agents/model-selection.js";
import { STATE_DIR } from "../../../src/config/paths.js";
import { logVerbose } from "../../../src/globals.js";
import { loadJsonFile, saveJsonFile } from "../../../src/infra/json-file.js";
import {
  AUTO_IMAGE_KEY_PROVIDERS,
  DEFAULT_IMAGE_MODELS
} from "../../../src/media-understanding/defaults.js";
import { resolveAutoImageModel } from "../../../src/media-understanding/runner.js";
const CACHE_FILE = path.join(STATE_DIR, "telegram", "sticker-cache.json");
const CACHE_VERSION = 1;
function loadCache() {
  const data = loadJsonFile(CACHE_FILE);
  if (!data || typeof data !== "object") {
    return { version: CACHE_VERSION, stickers: {} };
  }
  const cache = data;
  if (cache.version !== CACHE_VERSION) {
    return { version: CACHE_VERSION, stickers: {} };
  }
  return cache;
}
function saveCache(cache) {
  saveJsonFile(CACHE_FILE, cache);
}
function getCachedSticker(fileUniqueId) {
  const cache = loadCache();
  return cache.stickers[fileUniqueId] ?? null;
}
function cacheSticker(sticker) {
  const cache = loadCache();
  cache.stickers[sticker.fileUniqueId] = sticker;
  saveCache(cache);
}
function searchStickers(query, limit = 10) {
  const cache = loadCache();
  const queryLower = query.toLowerCase();
  const results = [];
  for (const sticker of Object.values(cache.stickers)) {
    let score = 0;
    const descLower = sticker.description.toLowerCase();
    if (descLower.includes(queryLower)) {
      score += 10;
    }
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }
    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }
    if (sticker.setName?.toLowerCase().includes(queryLower)) {
      score += 3;
    }
    if (score > 0) {
      results.push({ sticker, score });
    }
  }
  return results.toSorted((a, b) => b.score - a.score).slice(0, limit).map((r) => r.sticker);
}
function getAllCachedStickers() {
  const cache = loadCache();
  return Object.values(cache.stickers);
}
function getCacheStats() {
  const cache = loadCache();
  const stickers = Object.values(cache.stickers);
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = [...stickers].toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime()
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt
  };
}
const STICKER_DESCRIPTION_PROMPT = "Describe this sticker image in 1-2 sentences. Focus on what the sticker depicts (character, object, action, emotion). Be concise and objective.";
let imageRuntimePromise = null;
function loadImageRuntime() {
  imageRuntimePromise ??= import("../../../src/media-understanding/providers/image-runtime.js");
  return imageRuntimePromise;
}
async function describeStickerImage(params) {
  const { imagePath, cfg, agentDir, agentId } = params;
  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
  let activeModel = void 0;
  let catalog = [];
  try {
    catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    const supportsVision = modelSupportsVision(entry);
    if (supportsVision) {
      activeModel = { provider: defaultModel.provider, model: defaultModel.model };
    }
  } catch {
  }
  const hasProviderKey = async (provider2) => {
    try {
      await resolveApiKeyForProvider({ provider: provider2, cfg, agentDir });
      return true;
    } catch {
      return false;
    }
  };
  const selectCatalogModel = (provider2) => {
    const entries = catalog.filter(
      (entry) => entry.provider.toLowerCase() === provider2.toLowerCase() && modelSupportsVision(entry)
    );
    if (entries.length === 0) {
      return void 0;
    }
    const defaultId = DEFAULT_IMAGE_MODELS[provider2];
    const preferred = entries.find((entry) => entry.id === defaultId);
    return preferred ?? entries[0];
  };
  let resolved = null;
  if (activeModel && AUTO_IMAGE_KEY_PROVIDERS.includes(
    activeModel.provider
  ) && await hasProviderKey(activeModel.provider)) {
    resolved = activeModel;
  }
  if (!resolved) {
    for (const provider2 of AUTO_IMAGE_KEY_PROVIDERS) {
      if (!await hasProviderKey(provider2)) {
        continue;
      }
      const entry = selectCatalogModel(provider2);
      if (entry) {
        resolved = { provider: provider2, model: entry.id };
        break;
      }
    }
  }
  if (!resolved) {
    resolved = await resolveAutoImageModel({
      cfg,
      agentDir,
      activeModel
    });
  }
  if (!resolved?.model) {
    logVerbose("telegram: no vision provider available for sticker description");
    return null;
  }
  const { provider, model } = resolved;
  logVerbose(`telegram: describing sticker with ${provider}/${model}`);
  try {
    const buffer = await fs.readFile(imagePath);
    const { describeImageWithModel } = await loadImageRuntime();
    const result = await describeImageWithModel({
      buffer,
      fileName: "sticker.webp",
      mime: "image/webp",
      prompt: STICKER_DESCRIPTION_PROMPT,
      cfg,
      agentDir: agentDir ?? "",
      provider,
      model,
      maxTokens: 150,
      timeoutMs: 3e4
    });
    return result.text;
  } catch (err) {
    logVerbose(`telegram: failed to describe sticker: ${String(err)}`);
    return null;
  }
}
export {
  cacheSticker,
  describeStickerImage,
  getAllCachedStickers,
  getCacheStats,
  getCachedSticker,
  searchStickers
};
