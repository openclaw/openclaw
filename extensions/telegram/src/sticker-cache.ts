import path from "node:path";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/agent-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { loadJsonFile, saveJsonFile } from "openclaw/plugin-sdk/json-store";
import { AUTO_IMAGE_KEY_PROVIDERS, DEFAULT_IMAGE_MODELS } from "openclaw/plugin-sdk/media-runtime";
import { resolveAutoImageModel } from "openclaw/plugin-sdk/media-runtime";
import { describeImageFileWithModel } from "openclaw/plugin-sdk/media-understanding-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { STATE_DIR } from "openclaw/plugin-sdk/state-paths";

const CACHE_FILE = path.join(STATE_DIR, "telegram", "sticker-cache.json");
const CACHE_VERSION = 1;
const SAVE_DEBOUNCE_MS = 2_000;

export interface CachedSticker {
  fileId: string;
  fileUniqueId: string;
  emoji?: string;
  setName?: string;
  description: string;
  cachedAt: string;
  receivedFrom?: string;
}

interface StickerCache {
  version: number;
  stickers: Record<string, CachedSticker>;
}

// In-memory cache: lazily loaded from disk on first access, written back with debounce.
let memCache: StickerCache | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function getCache(): StickerCache {
  if (memCache) {
    return memCache;
  }
  const data = loadJsonFile(CACHE_FILE);
  if (data && typeof data === "object" && (data as StickerCache).version === CACHE_VERSION) {
    memCache = data as StickerCache;
  } else {
    memCache = { version: CACHE_VERSION, stickers: {} };
  }
  return memCache;
}

function scheduleSave(): void {
  if (saveTimer) {
    return;
  }
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (memCache) {
      saveJsonFile(CACHE_FILE, memCache);
    }
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Get a cached sticker by its unique ID.
 */
export function getCachedSticker(fileUniqueId: string): CachedSticker | null {
  return getCache().stickers[fileUniqueId] ?? null;
}

/**
 * Add or update a sticker in the cache.
 */
export function cacheSticker(sticker: CachedSticker): void {
  getCache().stickers[sticker.fileUniqueId] = sticker;
  scheduleSave();
}

/**
 * Search cached stickers by text query (fuzzy match on description + emoji + setName).
 */
export function searchStickers(query: string, limit = 10): CachedSticker[] {
  const cache = getCache();
  const queryLower = query.toLowerCase();
  const results: Array<{ sticker: CachedSticker; score: number }> = [];

  for (const sticker of Object.values(cache.stickers)) {
    let score = 0;
    const descLower = sticker.description.toLowerCase();

    // Exact substring match in description
    if (descLower.includes(queryLower)) {
      score += 10;
    }

    // Word-level matching
    const queryWords = queryLower.split(/\s+/).filter(Boolean);
    const descWords = descLower.split(/\s+/);
    for (const qWord of queryWords) {
      if (descWords.some((dWord) => dWord.includes(qWord))) {
        score += 5;
      }
    }

    // Emoji match
    if (sticker.emoji && query.includes(sticker.emoji)) {
      score += 8;
    }

    // Set name match
    if (sticker.setName?.toLowerCase().includes(queryLower)) {
      score += 3;
    }

    if (score > 0) {
      results.push({ sticker, score });
    }
  }

  return results
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((r) => r.sticker);
}

/**
 * Get all cached stickers (for debugging/listing).
 */
export function getAllCachedStickers(): CachedSticker[] {
  return Object.values(getCache().stickers);
}

/**
 * Get cache statistics.
 */
export function getCacheStats(): { count: number; oldestAt?: string; newestAt?: string } {
  const cache = getCache();
  const stickers = Object.values(cache.stickers);
  if (stickers.length === 0) {
    return { count: 0 };
  }
  const sorted = [...stickers].toSorted(
    (a, b) => new Date(a.cachedAt).getTime() - new Date(b.cachedAt).getTime(),
  );
  return {
    count: stickers.length,
    oldestAt: sorted[0]?.cachedAt,
    newestAt: sorted[sorted.length - 1]?.cachedAt,
  };
}

const STICKER_DESCRIPTION_PROMPT =
  "Describe this sticker image in 1-2 sentences. Focus on what the sticker depicts (character, object, action, emotion). Be concise and objective.";

export interface DescribeStickerParams {
  imagePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
}

/**
 * Describe a sticker image using vision API.
 * Auto-detects an available vision provider based on configured API keys.
 * Returns null if no vision provider is available.
 */
export async function describeStickerImage(params: DescribeStickerParams): Promise<string | null> {
  const { imagePath, cfg, agentDir, agentId } = params;

  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
  let activeModel = undefined as { provider: string; model: string } | undefined;
  let catalog: ModelCatalogEntry[] = [];
  try {
    catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    const supportsVision = modelSupportsVision(entry);
    if (supportsVision) {
      activeModel = { provider: defaultModel.provider, model: defaultModel.model };
    }
  } catch {
    // Ignore catalog failures; fall back to auto selection.
  }

  const hasProviderKey = async (provider: string) => {
    try {
      await resolveApiKeyForProvider({ provider, cfg, agentDir });
      return true;
    } catch {
      return false;
    }
  };

  const selectCatalogModel = (provider: string) => {
    const entries = catalog.filter(
      (entry) =>
        entry.provider.toLowerCase() === provider.toLowerCase() && modelSupportsVision(entry),
    );
    if (entries.length === 0) {
      return undefined;
    }
    const defaultId = DEFAULT_IMAGE_MODELS[provider];
    const preferred = entries.find((entry) => entry.id === defaultId);
    return preferred ?? entries[0];
  };

  let resolved = null as { provider: string; model?: string } | null;
  if (
    activeModel &&
    AUTO_IMAGE_KEY_PROVIDERS.includes(
      activeModel.provider as (typeof AUTO_IMAGE_KEY_PROVIDERS)[number],
    ) &&
    (await hasProviderKey(activeModel.provider))
  ) {
    resolved = activeModel;
  }

  if (!resolved) {
    for (const provider of AUTO_IMAGE_KEY_PROVIDERS) {
      if (!(await hasProviderKey(provider))) {
        continue;
      }
      const entry = selectCatalogModel(provider);
      if (entry) {
        resolved = { provider, model: entry.id };
        break;
      }
    }
  }

  if (!resolved) {
    resolved = await resolveAutoImageModel({
      cfg,
      agentDir,
      activeModel,
    });
  }

  if (!resolved?.model) {
    logVerbose("telegram: no vision provider available for sticker description");
    return null;
  }

  const { provider, model } = resolved;
  logVerbose(`telegram: describing sticker with ${provider}/${model}`);

  try {
    const result = await describeImageFileWithModel({
      filePath: imagePath,
      mime: "image/webp",
      cfg,
      agentDir,
      provider,
      model,
      prompt: STICKER_DESCRIPTION_PROMPT,
      maxTokens: 150,
      timeoutMs: 30_000,
    });
    return result.text ?? null;
  } catch (err) {
    logVerbose(`telegram: failed to describe sticker: ${String(err)}`);
    return null;
  }
}
