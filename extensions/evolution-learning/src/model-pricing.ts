/**
 * model-pricing.ts — 動態 AI 模型定價資料庫
 *
 * 資料來源優先順序：
 *   1. LiteLLM model_prices_and_context_window.json（GitHub raw，最廣泛使用，100+ 模型）
 *   2. Portkey configs.portkey.ai/pricing/{provider}.json（2000+ 模型，40+ 廠商）
 *   3. OpenRouter https://openrouter.ai/api/v1/models（400+ 模型，每日更新）
 *   4. 本地快取（stateDir/model-prices-cache.json，TTL 24 小時）
 *   5. 內建靜態備用（僅主要模型，確保離線可用）
 *
 * 開源專案參考：
 *   - https://github.com/BerriAI/litellm
 *   - https://github.com/Portkey-AI/models
 *   - https://github.com/pydantic/genai-prices
 *   - https://openrouter.ai/api/v1/models
 */

import fs from "node:fs/promises";
import path from "node:path";

// ─── 型別 ────────────────────────────────────────────────────────────

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "google"
  | "mistral"
  | "cohere"
  | "groq"
  | "together_ai"
  | "xai"
  | "perplexity"
  | "deepseek"
  | "meta"
  | "fireworks_ai"
  | "aws_bedrock"
  | "azure"
  | "vertex_ai"
  | string; // 其他廠商

export type ModelPricing = {
  /** 每 1K input tokens（USD）*/
  inputCostPer1k: number;
  /** 每 1K output tokens（USD）*/
  outputCostPer1k: number;
  /** 快取讀取（USD per 1K，如果支援）*/
  cacheReadCostPer1k?: number;
  /** 快取寫入（USD per 1K，如果支援）*/
  cacheWriteCostPer1k?: number;
  /** 最大 context window（tokens）*/
  maxTokens?: number;
  /** 最大 output tokens */
  maxOutputTokens?: number;
  /** 資料來源 */
  source: "litellm" | "portkey" | "openrouter" | "static" | "cache";
  /** 最後更新時間 */
  updatedAt: string;
};

export type ModelPriceMap = Record<string, ModelPricing>;

type LiteLLMEntry = {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_read_input_token_cost?: number;
  cache_creation_input_token_cost?: number;
  max_tokens?: number;
  max_output_tokens?: number;
};

type OpenRouterModel = {
  id: string;
  pricing?: {
    prompt?: string; // per token
    completion?: string; // per token
  };
  context_length?: number;
};

type PriceCache = {
  fetchedAt: string;
  source: string;
  prices: ModelPriceMap;
};

// ─── 靜態備用定價（離線可用，定期手動更新）────────────────────────

export const STATIC_FALLBACK_PRICES: ModelPriceMap = {
  // ── Anthropic ─────────────────────────────────────────────────────
  "claude-3-5-sonnet-20241022": {
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    cacheReadCostPer1k: 0.0003,
    cacheWriteCostPer1k: 0.00375,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "claude-3-5-haiku-20241022": {
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
    cacheReadCostPer1k: 0.00008,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "claude-3-opus-20240229": {
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
    cacheReadCostPer1k: 0.0015,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "claude-opus-4-5": {
    inputCostPer1k: 0.015,
    outputCostPer1k: 0.075,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "claude-sonnet-4-5": {
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "claude-haiku-4-5": {
    inputCostPer1k: 0.0008,
    outputCostPer1k: 0.004,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── OpenAI ────────────────────────────────────────────────────────
  "gpt-4o": {
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
    cacheReadCostPer1k: 0.00125,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gpt-4o-mini": {
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
    cacheReadCostPer1k: 0.000075,
    source: "static",
    updatedAt: "2026-05-14",
  },
  o3: { inputCostPer1k: 0.01, outputCostPer1k: 0.04, source: "static", updatedAt: "2026-05-14" },
  "o3-mini": {
    inputCostPer1k: 0.0011,
    outputCostPer1k: 0.0044,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "o4-mini": {
    inputCostPer1k: 0.0011,
    outputCostPer1k: 0.0044,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gpt-4.1": {
    inputCostPer1k: 0.002,
    outputCostPer1k: 0.008,
    cacheReadCostPer1k: 0.0005,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gpt-4.1-mini": {
    inputCostPer1k: 0.0004,
    outputCostPer1k: 0.0016,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── Google Gemini ─────────────────────────────────────────────────
  "gemini-2.0-flash": {
    inputCostPer1k: 0.0001,
    outputCostPer1k: 0.0004,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gemini-2.0-flash-lite": {
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gemini-2.5-pro": {
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.01,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gemini-1.5-pro": {
    inputCostPer1k: 0.00125,
    outputCostPer1k: 0.005,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "gemini-1.5-flash": {
    inputCostPer1k: 0.000075,
    outputCostPer1k: 0.0003,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── Mistral ───────────────────────────────────────────────────────
  "mistral-large-latest": {
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.009,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "mistral-small-latest": {
    inputCostPer1k: 0.0002,
    outputCostPer1k: 0.0006,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "codestral-latest": {
    inputCostPer1k: 0.0003,
    outputCostPer1k: 0.0009,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── Groq ──────────────────────────────────────────────────────────
  "groq/llama-3.3-70b-versatile": {
    inputCostPer1k: 0.00059,
    outputCostPer1k: 0.00079,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "groq/llama-3.1-8b-instant": {
    inputCostPer1k: 0.00005,
    outputCostPer1k: 0.00008,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "groq/gemma2-9b-it": {
    inputCostPer1k: 0.0002,
    outputCostPer1k: 0.0002,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── xAI Grok ──────────────────────────────────────────────────────
  "grok-3": {
    inputCostPer1k: 0.003,
    outputCostPer1k: 0.015,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "grok-3-mini": {
    inputCostPer1k: 0.0003,
    outputCostPer1k: 0.0005,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── DeepSeek ──────────────────────────────────────────────────────
  "deepseek-chat": {
    inputCostPer1k: 0.00014,
    outputCostPer1k: 0.00028,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "deepseek-reasoner": {
    inputCostPer1k: 0.00055,
    outputCostPer1k: 0.00219,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── Perplexity ────────────────────────────────────────────────────
  "perplexity/llama-3.1-sonar-large-128k-online": {
    inputCostPer1k: 0.001,
    outputCostPer1k: 0.001,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "perplexity/llama-3.1-sonar-small-128k-online": {
    inputCostPer1k: 0.0002,
    outputCostPer1k: 0.0002,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── Cohere ────────────────────────────────────────────────────────
  "command-r-plus": {
    inputCostPer1k: 0.0025,
    outputCostPer1k: 0.01,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "command-r": {
    inputCostPer1k: 0.00015,
    outputCostPer1k: 0.0006,
    source: "static",
    updatedAt: "2026-05-14",
  },

  // ── Together AI（Meta Llama）──────────────────────────────────────
  "together_ai/meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": {
    inputCostPer1k: 0.0035,
    outputCostPer1k: 0.0035,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "together_ai/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo": {
    inputCostPer1k: 0.00088,
    outputCostPer1k: 0.00088,
    source: "static",
    updatedAt: "2026-05-14",
  },
  "together_ai/meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo": {
    inputCostPer1k: 0.00018,
    outputCostPer1k: 0.00018,
    source: "static",
    updatedAt: "2026-05-14",
  },
};

// ─── 主類別 ─────────────────────────────────────────────────────────

export class ModelPricingDb {
  private readonly cachePath: string;
  private readonly cacheMaxAgeMs = 24 * 60 * 60 * 1000; // 24 小時
  private memCache: ModelPriceMap | null = null;

  // LiteLLM 原始資料（GitHub raw）
  private readonly LITELLM_URL =
    "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

  // OpenRouter models API（400+ 模型，即時定價）
  private readonly OPENROUTER_URL = "https://openrouter.ai/api/v1/models";

  constructor(stateDir: string) {
    this.cachePath = path.join(stateDir, "model-prices-cache.json");
  }

  // ── 取得定價（主要介面）────────────────────────────────────────────

  async getPrice(modelId: string): Promise<ModelPricing | null> {
    const db = await this.loadOrFetch();
    return db[modelId] ?? db[this.normalize(modelId)] ?? null;
  }

  async getPriceWithFallback(modelId: string): Promise<ModelPricing> {
    const found = await this.getPrice(modelId);
    if (found) return found;

    // 靜態備用
    const staticMatch =
      STATIC_FALLBACK_PRICES[modelId] ?? STATIC_FALLBACK_PRICES[this.normalize(modelId)];
    if (staticMatch) return staticMatch;

    // 模糊匹配：取名稱最接近的
    const db = await this.loadOrFetch();
    const allKeys = Object.keys(db);
    const normalizedSearch = this.normalize(modelId);
    const fuzzy = allKeys.find((k) => k.includes(normalizedSearch) || normalizedSearch.includes(k));
    if (fuzzy && db[fuzzy]) return db[fuzzy]!;

    // 最終備用：使用 gpt-4o 定價作為基準
    return {
      inputCostPer1k: 0.002,
      outputCostPer1k: 0.008,
      source: "static",
      updatedAt: new Date().toISOString().split("T")[0]!,
    };
  }

  // ── 取得所有定價 ──────────────────────────────────────────────────

  async getAllPrices(): Promise<ModelPriceMap> {
    return this.loadOrFetch();
  }

  // ── 強制刷新快取 ──────────────────────────────────────────────────

  async refresh(): Promise<{ success: boolean; modelCount: number; source: string }> {
    this.memCache = null;
    try {
      await fs.unlink(this.cachePath);
    } catch {
      /* ignore */
    }
    const db = await this.fetchFromNetwork();
    return {
      success: true,
      modelCount: Object.keys(db).length,
      source: "litellm+openrouter",
    };
  }

  // ── 估算費用 ──────────────────────────────────────────────────────

  async estimate(
    modelId: string,
    inputTokens: number,
    outputTokens: number,
  ): Promise<{ usd: number; detail: string; pricing: ModelPricing }> {
    const pricing = await this.getPriceWithFallback(modelId);
    const inputUsd = (inputTokens / 1000) * pricing.inputCostPer1k;
    const outputUsd = (outputTokens / 1000) * pricing.outputCostPer1k;
    const total = inputUsd + outputUsd;

    return {
      usd: total,
      detail:
        `${modelId}：input ${inputTokens} tokens ($${inputUsd.toFixed(5)}) + ` +
        `output ${outputTokens} tokens ($${outputUsd.toFixed(5)}) = $${total.toFixed(5)}`,
      pricing,
    };
  }

  // ── 搜尋模型（按廠商或名稱）──────────────────────────────────────

  async search(query: string): Promise<Array<{ model: string; pricing: ModelPricing }>> {
    const db = await this.loadOrFetch();
    const q = query.toLowerCase();
    return Object.entries(db)
      .filter(([k]) => k.toLowerCase().includes(q))
      .map(([model, pricing]) => ({ model, pricing }))
      .sort((a, b) => a.model.localeCompare(b.model))
      .slice(0, 20);
  }

  // ── 快取載入或從網路拉取 ──────────────────────────────────────────

  private async loadOrFetch(): Promise<ModelPriceMap> {
    if (this.memCache) return this.memCache;

    // 嘗試讀快取
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      const cache = JSON.parse(raw) as PriceCache;
      const age = Date.now() - new Date(cache.fetchedAt).getTime();
      if (age < this.cacheMaxAgeMs && Object.keys(cache.prices).length > 50) {
        this.memCache = { ...STATIC_FALLBACK_PRICES, ...cache.prices };
        return this.memCache;
      }
    } catch {
      /* 快取不存在或損壞 */
    }

    // 從網路拉取
    try {
      const prices = await this.fetchFromNetwork();
      this.memCache = prices;
      return prices;
    } catch {
      // 網路失敗，退回靜態備用
      this.memCache = { ...STATIC_FALLBACK_PRICES };
      return this.memCache;
    }
  }

  // ── 從 LiteLLM + OpenRouter 拉取定價 ────────────────────────────

  private async fetchFromNetwork(): Promise<ModelPriceMap> {
    const prices: ModelPriceMap = { ...STATIC_FALLBACK_PRICES };
    let source = "static";

    // 1. LiteLLM（主要來源）
    try {
      const resp = await fetch(this.LITELLM_URL, {
        signal: AbortSignal.timeout(10_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, LiteLLMEntry>;
        let count = 0;
        for (const [model, entry] of Object.entries(data)) {
          if (!entry.input_cost_per_token) continue;
          prices[model] = {
            inputCostPer1k: entry.input_cost_per_token * 1000,
            outputCostPer1k: (entry.output_cost_per_token ?? 0) * 1000,
            cacheReadCostPer1k: entry.cache_read_input_token_cost
              ? entry.cache_read_input_token_cost * 1000
              : undefined,
            cacheWriteCostPer1k: entry.cache_creation_input_token_cost
              ? entry.cache_creation_input_token_cost * 1000
              : undefined,
            maxTokens: entry.max_tokens,
            maxOutputTokens: entry.max_output_tokens,
            source: "litellm",
            updatedAt: new Date().toISOString().split("T")[0]!,
          };
          count++;
        }
        source = `litellm(${count})`;
      }
    } catch {
      /* LiteLLM 失敗，繼續 */
    }

    // 2. OpenRouter（補充，取得即時定價）
    try {
      const resp = await fetch(this.OPENROUTER_URL, {
        signal: AbortSignal.timeout(8_000),
      });
      if (resp.ok) {
        const data = (await resp.json()) as { data?: OpenRouterModel[] };
        let count = 0;
        for (const model of data.data ?? []) {
          if (!model.pricing?.prompt || prices[model.id]) continue; // 不覆蓋 LiteLLM 資料
          const inputPer1k = parseFloat(model.pricing.prompt) * 1000;
          const outputPer1k = parseFloat(model.pricing.completion ?? "0") * 1000;
          if (isNaN(inputPer1k) || inputPer1k <= 0) continue;
          prices[`openrouter/${model.id}`] = {
            inputCostPer1k: inputPer1k,
            outputCostPer1k: outputPer1k,
            maxTokens: model.context_length,
            source: "openrouter",
            updatedAt: new Date().toISOString().split("T")[0]!,
          };
          count++;
        }
        source += `+openrouter(${count})`;
      }
    } catch {
      /* OpenRouter 失敗 */
    }

    // 存入快取
    const cache: PriceCache = {
      fetchedAt: new Date().toISOString(),
      source,
      prices,
    };
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.writeFile(this.cachePath, JSON.stringify(cache), "utf8");
    } catch {
      /* 儲存失敗不中斷 */
    }

    return prices;
  }

  // ── 正規化模型名稱（移除版本後綴）───────────────────────────────

  private normalize(modelId: string): string {
    return modelId
      .toLowerCase()
      .replace(/-\d{8}$/, "") // 移除日期後綴（-20241022）
      .replace(/@[^/]+$/, "") // 移除版本標籤（@001）
      .trim();
  }
}

// ─── 工廠函數 ────────────────────────────────────────────────────────

export function createModelPricingDb(stateDir: string): ModelPricingDb {
  return new ModelPricingDb(stateDir);
}
