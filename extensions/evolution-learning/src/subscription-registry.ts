/**
 * subscription-registry.ts — 全 AI 廠商訂閱感知系統
 *
 * 覆蓋所有主要 AI 訂閱方案，定價動態從開源資料庫拉取：
 *   - LiteLLM model_prices_and_context_window.json（100+ 模型）
 *   - OpenRouter API（400+ 模型即時定價）
 *   - 靜態備用（離線可用）
 *
 * 訂閱覆蓋的廠商：
 *   Anthropic  → claude-pro, claude-max-5, claude-max-20, claude-api-key
 *   OpenAI     → openai-plus, openai-pro, openai-api-key
 *   Codex CLI  → codex-cli-key（o3-mini / gpt-4o-mini per-token）
 *   Google     → google-one-ai-premium（含 Gemini Advanced）, gemini-api-key
 *   Mistral    → mistral-api-key
 *   Groq       → groq-api-key（免費層 + per-token）
 *   xAI        → xai-api-key（Grok）
 *   DeepSeek   → deepseek-api-key
 *   Perplexity → perplexity-api-key
 *   Together   → together-api-key（Meta Llama 等）
 *   Cohere     → cohere-api-key
 *   Tavily     → tavily-free, tavily-starter, tavily-pro, tavily-api-key
 *
 * 儲存位置（優先順序）：
 *   1. ~/.nuwa/subscriptions.json  （全域，所有工作區共用）
 *   2. <stateDir>/subscriptions.json（工作區專屬）
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createAutoDetector } from "./auto-detect.js";
import { createModelPricingDb, type ModelPricingDb } from "./model-pricing.js";

// ─── 型別 ────────────────────────────────────────────────────────────

/** nuwa 內部操作類型 */
export type NuwaOperation =
  | "internal_compute" // nuwa 自身計算（永遠免費）
  | "nuwa_mcp" // MCP Server（永遠免費）
  | "tavily_search" // Tavily 搜尋
  | "claude_code_cli" // Claude Code CLI（openclaw / nuwa MCP）
  | "claude_api" // Anthropic API
  | "codex_cli" // OpenAI Codex CLI
  | "openai_api" // OpenAI API（GPT-4o 等）
  | "gemini_api" // Google Gemini API
  | "mistral_api" // Mistral API
  | "groq_api" // Groq API
  | "xai_api" // xAI Grok API
  | "deepseek_api" // DeepSeek API
  | "perplexity_api" // Perplexity API
  | "together_api" // Together AI API（Meta Llama 等）
  | "cohere_api" // Cohere API
  | "moa_claude" // MoA — Claude 節點
  | "moa_openai" // MoA — OpenAI 節點
  | "moa_gemini" // MoA — Gemini 節點
  | "moa_any"; // MoA — 任意節點（取最便宜的可用廠商）

/** 訂閱方案 ID */
export type SubscriptionId =
  // Anthropic
  | "claude-free"
  | "claude-pro"
  | "claude-max-5"
  | "claude-max-20"
  | "claude-api-key"
  // OpenAI
  | "openai-free"
  | "openai-plus"
  | "openai-pro"
  | "openai-api-key"
  | "codex-cli-key"
  // Google
  | "google-one-ai-premium"
  | "google-workspace-ai"
  | "gemini-api-key"
  | "vertex-ai-key"
  // Mistral
  | "mistral-la-plateforme-free"
  | "mistral-api-key"
  // Groq
  | "groq-free"
  | "groq-api-key"
  // xAI
  | "xai-api-key"
  // DeepSeek
  | "deepseek-api-key"
  // Perplexity
  | "perplexity-pro"
  | "perplexity-api-key"
  // Together AI
  | "together-api-key"
  // Cohere
  | "cohere-trial"
  | "cohere-api-key"
  // Tavily
  | "tavily-free"
  | "tavily-starter"
  | "tavily-pro"
  | "tavily-api-key";

/** 訂閱方案定義 */
export type SubscriptionPlan = {
  id: SubscriptionId;
  provider: string;
  displayName: string;
  monthlyUsd: number;
  description: string;
  /** 此方案覆蓋的 nuwa 操作（不額外計費）*/
  covers: NuwaOperation[];
  /** 月流量限制（-1 = 無限，0 = 不覆蓋）*/
  limits: Partial<Record<NuwaOperation, number>>;
  /** 是否為 per-token API 模式 */
  isApiKeyMode: boolean;
  /** 預設模型（用於費用估算）*/
  defaultModel?: string;
  /** Tavily 每月搜尋次數上限 */
  tavilyMonthlyLimit?: number;
};

/** 已登記的訂閱 */
export type ActiveSubscription = {
  id: SubscriptionId;
  /** 首次偵測/登記時間 → 作為計費週期基準日 */
  addedAt: string;
  note?: string;
  apiKey?: string;
  customModel?: string;
  monthlyBudgetUsd?: number;
};

/** 計費週期資訊（從 addedAt 自動計算）*/
export type BillingCycle = {
  /** 計費週期基準日（每月幾號重置，從 addedAt 取得）*/
  cycleDay: number;
  /** 當期開始時間 */
  periodStart: Date;
  /** 當期結束時間（下次重置）*/
  periodEnd: Date;
  /** 距離重置剩餘天數 */
  daysRemaining: number;
  /** 距離重置剩餘小時 */
  hoursRemaining: number;
  /** 當期已過百分比 */
  percentElapsed: number;
};

/** 訂閱登記表（存入 JSON）*/
export type SubscriptionFile = {
  version: 2;
  updatedAt: string;
  subscriptions: ActiveSubscription[];
  globalMonthlyBudgetUsd?: number;
  overBudgetBehavior?: "block" | "warn";
};

// ─── 永遠免費的操作 ──────────────────────────────────────────────────

export const ALWAYS_FREE: NuwaOperation[] = ["internal_compute", "nuwa_mcp"];

// ─── 完整訂閱方案定義 ────────────────────────────────────────────────

export const SUBSCRIPTION_PLANS: Record<SubscriptionId, SubscriptionPlan> = {
  // ════════════════════════════════════════════════════════════════
  // ANTHROPIC / CLAUDE
  // ════════════════════════════════════════════════════════════════

  "claude-free": {
    id: "claude-free",
    provider: "anthropic",
    displayName: "Claude 免費層",
    monthlyUsd: 0,
    description: "Claude.ai 免費層：有限 Web 對話，不含 Claude Code CLI 或 API",
    covers: [],
    limits: {},
    isApiKeyMode: false,
  },

  "claude-pro": {
    id: "claude-pro",
    provider: "anthropic",
    displayName: "Claude Pro",
    monthlyUsd: 20,
    description: "Claude Pro $20/月：Web 對話（比免費層多 5 倍使用量）。不含 Claude Code CLI。",
    covers: [],
    limits: {},
    isApiKeyMode: false,
    // ⚠️ Claude Pro 不含 Claude Code CLI，需升級至 Max
  },

  "claude-max-5": {
    id: "claude-max-5",
    provider: "anthropic",
    displayName: "Claude Max（5×）",
    monthlyUsd: 100,
    description: "Claude Max $100/月：含 Claude Code CLI，使用量是 Pro 的 5 倍",
    covers: ["claude_code_cli", "moa_claude"],
    limits: { claude_code_cli: -1, moa_claude: -1 },
    isApiKeyMode: false,
  },

  "claude-max-20": {
    id: "claude-max-20",
    provider: "anthropic",
    displayName: "Claude Max（20×）",
    monthlyUsd: 200,
    description: "Claude Max $200/月：含 Claude Code CLI，使用量是 Pro 的 20 倍",
    covers: ["claude_code_cli", "moa_claude"],
    limits: { claude_code_cli: -1, moa_claude: -1 },
    isApiKeyMode: false,
  },

  "claude-api-key": {
    id: "claude-api-key",
    provider: "anthropic",
    displayName: "Anthropic API Key",
    monthlyUsd: 0,
    description: "Anthropic API Key：per-token 計費（claude-3-5-sonnet 等）",
    covers: ["claude_api", "moa_claude"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "claude-3-5-sonnet-20241022",
  },

  // ════════════════════════════════════════════════════════════════
  // OPENAI / CODEX
  // ════════════════════════════════════════════════════════════════

  "openai-free": {
    id: "openai-free",
    provider: "openai",
    displayName: "ChatGPT 免費層",
    monthlyUsd: 0,
    description: "ChatGPT 免費層：有限 Web 對話，不含 API 或 Codex CLI",
    covers: [],
    limits: {},
    isApiKeyMode: false,
  },

  "openai-plus": {
    id: "openai-plus",
    provider: "openai",
    displayName: "ChatGPT Plus",
    monthlyUsd: 20,
    description: "ChatGPT Plus $20/月：Web 對話（GPT-4o 存取）。不含 API 或 Codex CLI。",
    covers: [],
    limits: {},
    isApiKeyMode: false,
    // ⚠️ Plus 不含 API 或 Codex CLI
  },

  "openai-pro": {
    id: "openai-pro",
    provider: "openai",
    displayName: "ChatGPT Pro",
    monthlyUsd: 200,
    description: "ChatGPT Pro $200/月：無限 Web + API 配額 + Codex CLI（o3、o3-mini、gpt-4o）",
    covers: ["codex_cli", "openai_api", "moa_openai"],
    limits: { codex_cli: -1, openai_api: -1, moa_openai: -1 },
    isApiKeyMode: false,
  },

  "openai-api-key": {
    id: "openai-api-key",
    provider: "openai",
    displayName: "OpenAI API Key",
    monthlyUsd: 0,
    description: "OpenAI API Key：per-token 計費（gpt-4o、gpt-4o-mini、o3-mini 等）",
    covers: ["openai_api", "moa_openai"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "gpt-4o",
  },

  "codex-cli-key": {
    id: "codex-cli-key",
    provider: "openai",
    displayName: "Codex CLI（API Key）",
    monthlyUsd: 0,
    description: "Codex CLI + OpenAI API Key：per-token 計費（預設 o3-mini）",
    covers: ["codex_cli", "openai_api", "moa_openai"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "o3-mini",
  },

  // ════════════════════════════════════════════════════════════════
  // GOOGLE / GEMINI
  // ════════════════════════════════════════════════════════════════

  "google-one-ai-premium": {
    id: "google-one-ai-premium",
    provider: "google",
    displayName: "Google One AI Premium",
    monthlyUsd: 20,
    description:
      "Google One AI Premium $20/月：Gemini Advanced（1.5 Pro/2.0 Pro）Web 存取，不含 API",
    covers: [],
    limits: {},
    isApiKeyMode: false,
    // ⚠️ Web 對話不含 Gemini API 呼叫
  },

  "google-workspace-ai": {
    id: "google-workspace-ai",
    provider: "google",
    displayName: "Google Workspace + Gemini",
    monthlyUsd: 30,
    description: "Google Workspace Business + Gemini $30/月：企業版 Gemini 存取，不含 API",
    covers: [],
    limits: {},
    isApiKeyMode: false,
  },

  "gemini-api-key": {
    id: "gemini-api-key",
    provider: "google",
    displayName: "Gemini API Key（Google AI Studio）",
    monthlyUsd: 0,
    description: "Google AI Studio API Key：per-token（Gemini 1.5 Flash 有免費額度）",
    covers: ["gemini_api", "moa_gemini"],
    limits: {
      gemini_api: 1500, // Gemini 1.5 Flash 免費層：1500 requests/day
      moa_gemini: 1500,
    },
    isApiKeyMode: true,
    defaultModel: "gemini-2.0-flash",
  },

  "vertex-ai-key": {
    id: "vertex-ai-key",
    provider: "google",
    displayName: "Google Vertex AI",
    monthlyUsd: 0,
    description: "Google Cloud Vertex AI：per-token 計費，含企業 SLA",
    covers: ["gemini_api", "moa_gemini"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "vertex_ai/gemini-2.0-flash",
  },

  // ════════════════════════════════════════════════════════════════
  // MISTRAL
  // ════════════════════════════════════════════════════════════════

  "mistral-la-plateforme-free": {
    id: "mistral-la-plateforme-free",
    provider: "mistral",
    displayName: "Mistral La Plateforme 免費層",
    monthlyUsd: 0,
    description: "Mistral la Plateforme 免費層：有限 API 呼叫（每月有配額）",
    covers: ["mistral_api"],
    limits: { mistral_api: 10000 }, // 約 10K tokens/分鐘
    isApiKeyMode: true,
    defaultModel: "mistral-small-latest",
  },

  "mistral-api-key": {
    id: "mistral-api-key",
    provider: "mistral",
    displayName: "Mistral API Key",
    monthlyUsd: 0,
    description: "Mistral API Key：per-token 計費（mistral-large、codestral 等）",
    covers: ["mistral_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "mistral-large-latest",
  },

  // ════════════════════════════════════════════════════════════════
  // GROQ
  // ════════════════════════════════════════════════════════════════

  "groq-free": {
    id: "groq-free",
    provider: "groq",
    displayName: "Groq 免費層",
    monthlyUsd: 0,
    description: "Groq 免費層：有速率限制的免費 API（LLaMA 3、Mixtral 等），極速推理",
    covers: ["groq_api"],
    limits: { groq_api: 6000 }, // 免費層：約 6000 tokens/分鐘
    isApiKeyMode: true,
    defaultModel: "groq/llama-3.3-70b-versatile",
  },

  "groq-api-key": {
    id: "groq-api-key",
    provider: "groq",
    displayName: "Groq API Key（付費層）",
    monthlyUsd: 0,
    description: "Groq 付費 API Key：更高速率限制，per-token 計費，速度最快的推理服務之一",
    covers: ["groq_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "groq/llama-3.3-70b-versatile",
  },

  // ════════════════════════════════════════════════════════════════
  // xAI GROK
  // ════════════════════════════════════════════════════════════════

  "xai-api-key": {
    id: "xai-api-key",
    provider: "xai",
    displayName: "xAI Grok API Key",
    monthlyUsd: 0,
    description: "xAI Grok API Key：per-token 計費（grok-3、grok-3-mini）",
    covers: ["xai_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "grok-3-mini",
  },

  // ════════════════════════════════════════════════════════════════
  // DEEPSEEK
  // ════════════════════════════════════════════════════════════════

  "deepseek-api-key": {
    id: "deepseek-api-key",
    provider: "deepseek",
    displayName: "DeepSeek API Key",
    monthlyUsd: 0,
    description:
      "DeepSeek API Key：per-token 計費，最高性價比選項（deepseek-chat、deepseek-reasoner）",
    covers: ["deepseek_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "deepseek-chat",
  },

  // ════════════════════════════════════════════════════════════════
  // PERPLEXITY
  // ════════════════════════════════════════════════════════════════

  "perplexity-pro": {
    id: "perplexity-pro",
    provider: "perplexity",
    displayName: "Perplexity Pro",
    monthlyUsd: 20,
    description: "Perplexity Pro $20/月：無限 Web 搜尋，不含 API",
    covers: [],
    limits: {},
    isApiKeyMode: false,
  },

  "perplexity-api-key": {
    id: "perplexity-api-key",
    provider: "perplexity",
    displayName: "Perplexity API Key",
    monthlyUsd: 0,
    description: "Perplexity API Key：per-token + 搜尋費用（含即時網路搜尋能力）",
    covers: ["perplexity_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "perplexity/llama-3.1-sonar-large-128k-online",
  },

  // ════════════════════════════════════════════════════════════════
  // TOGETHER AI（Meta Llama 等開源模型）
  // ════════════════════════════════════════════════════════════════

  "together-api-key": {
    id: "together-api-key",
    provider: "together_ai",
    displayName: "Together AI API Key",
    monthlyUsd: 0,
    description: "Together AI API Key：per-token，提供 Meta Llama、Qwen、Mistral 等開源模型",
    covers: ["together_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "together_ai/meta-llama/Meta-Llama-3.1-70B-Instruct-Turbo",
  },

  // ════════════════════════════════════════════════════════════════
  // COHERE
  // ════════════════════════════════════════════════════════════════

  "cohere-trial": {
    id: "cohere-trial",
    provider: "cohere",
    displayName: "Cohere 試用層",
    monthlyUsd: 0,
    description: "Cohere 試用層：有限 API 呼叫，非商業用途",
    covers: ["cohere_api"],
    limits: { cohere_api: 1000 },
    isApiKeyMode: true,
    defaultModel: "command-r",
  },

  "cohere-api-key": {
    id: "cohere-api-key",
    provider: "cohere",
    displayName: "Cohere API Key",
    monthlyUsd: 0,
    description: "Cohere 付費 API Key：per-token（Command R+、Command R 等）",
    covers: ["cohere_api"],
    limits: {},
    isApiKeyMode: true,
    defaultModel: "command-r-plus",
  },

  // ════════════════════════════════════════════════════════════════
  // TAVILY（搜尋 API）
  // ════════════════════════════════════════════════════════════════

  "tavily-free": {
    id: "tavily-free",
    provider: "tavily",
    displayName: "Tavily 免費層",
    monthlyUsd: 0,
    description: "Tavily 免費層：1,000 次搜尋/月",
    covers: ["tavily_search"],
    limits: { tavily_search: 1000 },
    isApiKeyMode: false,
    tavilyMonthlyLimit: 1000,
  },

  "tavily-starter": {
    id: "tavily-starter",
    provider: "tavily",
    displayName: "Tavily Starter",
    monthlyUsd: 19,
    description: "Tavily Starter $19/月：1,000 次搜尋/月",
    covers: ["tavily_search"],
    limits: { tavily_search: 1000 },
    isApiKeyMode: false,
    tavilyMonthlyLimit: 1000,
  },

  "tavily-pro": {
    id: "tavily-pro",
    provider: "tavily",
    displayName: "Tavily Pro",
    monthlyUsd: 99,
    description: "Tavily Pro $99/月：5,000 次搜尋/月",
    covers: ["tavily_search"],
    limits: { tavily_search: 5000 },
    isApiKeyMode: false,
    tavilyMonthlyLimit: 5000,
  },

  "tavily-api-key": {
    id: "tavily-api-key",
    provider: "tavily",
    displayName: "Tavily API Key（自訂方案）",
    monthlyUsd: 0,
    description: "Tavily 自訂 API Key：按搜尋次數計費（約 $1/1000 次）",
    covers: ["tavily_search"],
    limits: {},
    isApiKeyMode: true,
    tavilyMonthlyLimit: -1,
  },
};

// ─── 從環境變數自動偵測 ──────────────────────────────────────────────

export function detectSubscriptionsFromEnv(): SubscriptionId[] {
  const detected: SubscriptionId[] = [];

  // Anthropic
  if (process.env.ANTHROPIC_API_KEY) detected.push("claude-api-key");
  if (process.env.NUWA_CLAUDE_TIER === "max-20") detected.push("claude-max-20");
  else if (process.env.NUWA_CLAUDE_TIER === "max-5") detected.push("claude-max-5");
  else if (process.env.NUWA_CLAUDE_TIER === "pro") detected.push("claude-pro");

  // OpenAI
  if (process.env.OPENAI_API_KEY) {
    detected.push("openai-api-key");
    detected.push("codex-cli-key"); // API key 同時支援 Codex CLI
  }
  if (process.env.NUWA_OPENAI_TIER === "pro") detected.push("openai-pro");
  else if (process.env.NUWA_OPENAI_TIER === "plus") detected.push("openai-plus");

  // Google
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) detected.push("gemini-api-key");
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) detected.push("vertex-ai-key");

  // Mistral
  if (process.env.MISTRAL_API_KEY) detected.push("mistral-api-key");

  // Groq
  if (process.env.GROQ_API_KEY) detected.push("groq-api-key");
  else detected.push("groq-free"); // Groq 有免費層，預設加入

  // xAI
  if (process.env.XAI_API_KEY) detected.push("xai-api-key");

  // DeepSeek
  if (process.env.DEEPSEEK_API_KEY) detected.push("deepseek-api-key");

  // Perplexity
  if (process.env.PERPLEXITY_API_KEY) detected.push("perplexity-api-key");

  // Together AI
  if (process.env.TOGETHER_API_KEY || process.env.TOGETHERAI_API_KEY)
    detected.push("together-api-key");

  // Cohere
  if (process.env.COHERE_API_KEY) detected.push("cohere-api-key");

  // Tavily
  if (process.env.TAVILY_API_KEY) detected.push("tavily-api-key");
  else detected.push("tavily-free"); // 沒有 key 預設免費層

  return [...new Set(detected)]; // 去重
}

// ─── SubscriptionRegistry 主類別 ────────────────────────────────────

export class SubscriptionRegistry {
  private readonly globalPath: string;
  private readonly localPath: string;
  private readonly pricingDb: ModelPricingDb;
  private cache: SubscriptionFile | null = null;

  constructor(stateDir: string) {
    this.globalPath = path.join(os.homedir(), ".nuwa", "subscriptions.json");
    this.localPath = path.join(stateDir, "subscriptions.json");
    this.pricingDb = createModelPricingDb(stateDir);
  }

  // ── 讀取訂閱表（自動偵測，零設定）──────────────────────────────

  async load(): Promise<SubscriptionFile> {
    if (this.cache) return this.cache;

    // 嘗試讀已存在的手動設定（如果用戶曾手動 add，優先用）
    for (const p of [this.globalPath, this.localPath]) {
      try {
        const raw = await fs.readFile(p, "utf8");
        const file = JSON.parse(raw) as SubscriptionFile;
        // 如果有手動設定，在背景補充自動偵測（非阻塞）
        this.mergeAutoDetectedAsync(file).catch(() => {});
        this.cache = file;
        return file;
      } catch {
        /* continue */
      }
    }

    // 完全從自動偵測建立（零設定路徑）
    const detector = createAutoDetector(path.dirname(this.localPath));
    const detected = await detector.getSubscriptionIds();

    this.cache = {
      version: 2,
      updatedAt: new Date().toISOString(),
      subscriptions: detected.map((id) => ({
        id,
        addedAt: new Date().toISOString(),
        note: "自動偵測",
      })),
      globalMonthlyBudgetUsd: 0,
      overBudgetBehavior: "block",
    };
    return this.cache;
  }

  /** 背景非阻塞：用自動偵測結果補充現有設定 */
  private async mergeAutoDetectedAsync(file: SubscriptionFile): Promise<void> {
    try {
      const stateDir = path.dirname(this.localPath);
      const detector = createAutoDetector(stateDir);
      const detected = await detector.getSubscriptionIds();
      let changed = false;
      for (const id of detected) {
        if (!file.subscriptions.find((s) => s.id === id)) {
          file.subscriptions.push({ id, addedAt: new Date().toISOString(), note: "自動偵測補充" });
          changed = true;
        }
      }
      if (changed) {
        file.updatedAt = new Date().toISOString();
        this.cache = file;
        await this.save();
      }
    } catch {
      /* 背景任務失敗不影響主流程 */
    }
  }

  async getActivePlans(): Promise<SubscriptionPlan[]> {
    const file = await this.load();
    return file.subscriptions
      .map((s) => SUBSCRIPTION_PLANS[s.id])
      .filter((p): p is SubscriptionPlan => p !== undefined);
  }

  // ── 計費週期計算（核心邏輯）────────────────────────────────────
  //
  // 原理：訂閱從 addedAt 那天開始，每個月同一天重置。
  //   例：2026-03-15 登記 → 每月 15 號重置
  //   現在是 2026-05-20 → 當期是 2026-05-15 ~ 2026-06-15
  //   剩餘 26 天
  //

  getBillingCycle(sub: ActiveSubscription): BillingCycle {
    const addedAt = new Date(sub.addedAt);
    const cycleDay = addedAt.getDate(); // 每月幾號（1-31）
    const now = new Date();

    // 算出「當期開始」：本月的 cycleDay，如果今天還沒到就退回上個月
    let periodStart = new Date(now.getFullYear(), now.getMonth(), cycleDay);
    if (periodStart > now) {
      // 今天還沒到這個月的計費日，退回上個月
      periodStart = new Date(now.getFullYear(), now.getMonth() - 1, cycleDay);
    }

    // 算出「當期結束」：periodStart + 1 個月
    const periodEnd = new Date(periodStart.getFullYear(), periodStart.getMonth() + 1, cycleDay);

    const msRemaining = periodEnd.getTime() - now.getTime();
    const msPeriod = periodEnd.getTime() - periodStart.getTime();

    return {
      cycleDay,
      periodStart,
      periodEnd,
      daysRemaining: Math.ceil(msRemaining / (1000 * 60 * 60 * 24)),
      hoursRemaining: Math.ceil(msRemaining / (1000 * 60 * 60)),
      percentElapsed: Math.min(
        100,
        Math.max(0, ((now.getTime() - periodStart.getTime()) / msPeriod) * 100),
      ),
    };
  }

  /** 取得所有訂閱的計費週期摘要 */
  async getBillingCycles(): Promise<
    Array<{
      sub: ActiveSubscription;
      plan: SubscriptionPlan;
      cycle: BillingCycle;
    }>
  > {
    const file = await this.load();
    return file.subscriptions
      .map((sub) => {
        const plan = SUBSCRIPTION_PLANS[sub.id];
        if (!plan || plan.monthlyUsd === 0) return null; // 只追蹤付費訂閱
        return { sub, plan, cycle: this.getBillingCycle(sub) };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);
  }

  /** 給定訂閱，取得「當期開始～結束」的 ISO 時間範圍 */
  getBillingPeriodRange(sub: ActiveSubscription): { start: string; end: string } {
    const cycle = this.getBillingCycle(sub);
    return {
      start: cycle.periodStart.toISOString(),
      end: cycle.periodEnd.toISOString(),
    };
  }

  // ── 查詢覆蓋狀態 ────────────────────────────────────────────────

  async isCovered(operation: NuwaOperation): Promise<{
    covered: boolean;
    coveringPlan?: SubscriptionPlan;
    reason: string;
  }> {
    if ((ALWAYS_FREE as NuwaOperation[]).includes(operation)) {
      return { covered: true, reason: "零成本操作（nuwa 內部）" };
    }
    const plans = await this.getActivePlans();
    const covering = plans.find((p) => p.covers.includes(operation));
    if (covering) {
      const limit = covering.limits[operation];
      const limitStr = limit === -1 ? "無限" : limit != null ? `${limit} 次/月` : "";
      return {
        covered: true,
        coveringPlan: covering,
        reason: `已由「${covering.displayName}」訂閱覆蓋${limitStr ? `（${limitStr}）` : ""}，月費 $${covering.monthlyUsd}，此操作不額外計費`,
      };
    }
    return { covered: false, reason: `未找到覆蓋「${operation}」的訂閱` };
  }

  // ── 估算操作費用（使用動態定價）────────────────────────────────

  async estimateCost(
    operation: NuwaOperation,
    params: { inputTokens?: number; outputTokens?: number; callCount?: number; model?: string },
  ): Promise<{ estimatedUsd: number; detail: string; usingPlan?: SubscriptionPlan }> {
    const coverage = await this.isCovered(operation);
    if (coverage.covered) {
      return { estimatedUsd: 0, detail: coverage.reason, usingPlan: coverage.coveringPlan };
    }

    // 找可用的 API key 方案
    const plans = await this.getActivePlans();
    const file = await this.load();
    const apiPlan = plans.find((p) => p.isApiKeyMode && p.covers.includes(operation));
    if (!apiPlan) {
      return {
        estimatedUsd: -1,
        detail:
          `沒有可執行「${operation}」的訂閱或 API Key。\n` +
          `   需要以下之一：${this.requiredFor(operation).join("、")}\n` +
          `   執行 nuwa sub plans 查看完整方案列表`,
      };
    }

    // 取得模型定價（動態從 LiteLLM/OpenRouter 拉取）
    const activeSub = file.subscriptions.find((s) => s.id === apiPlan.id);
    const modelId = params.model ?? activeSub?.customModel ?? apiPlan.defaultModel ?? "gpt-4o";

    if (operation === "tavily_search") {
      const perCall = 0.001; // Tavily ~$1/1000 次
      const usd = (params.callCount ?? 1) * perCall;
      return {
        estimatedUsd: usd,
        detail: `Tavily 搜尋 ${params.callCount ?? 1} 次 × $${perCall}/次 = $${usd.toFixed(4)}`,
        usingPlan: apiPlan,
      };
    }

    const inputTokens = params.inputTokens ?? 500;
    const outputTokens = params.outputTokens ?? 500;
    const estimate = await this.pricingDb.estimate(modelId, inputTokens, outputTokens);

    return {
      estimatedUsd: estimate.usd,
      detail: `[${apiPlan.displayName}] ${estimate.detail}（定價來源：${estimate.pricing.source}）`,
      usingPlan: apiPlan,
    };
  }

  // ── 訂閱管理 ────────────────────────────────────────────────────

  async add(
    id: SubscriptionId,
    opts: { note?: string; apiKey?: string; monthlyBudgetUsd?: number; customModel?: string } = {},
  ): Promise<void> {
    if (!SUBSCRIPTION_PLANS[id]) throw new Error(`未知的訂閱方案：${id}`);
    const file = await this.load();
    const idx = file.subscriptions.findIndex((s) => s.id === id);
    const entry: ActiveSubscription = {
      id,
      addedAt: new Date().toISOString(),
      note: opts.note,
      apiKey: opts.apiKey,
      monthlyBudgetUsd: opts.monthlyBudgetUsd,
      customModel: opts.customModel,
    };
    if (idx >= 0) {
      // 保留原有 addedAt（計費週期錨點），只更新其他欄位
      const existing = file.subscriptions[idx]!;
      file.subscriptions[idx] = { ...entry, addedAt: existing.addedAt };
    } else {
      file.subscriptions.push(entry);
    }
    file.updatedAt = new Date().toISOString();
    this.cache = file;
    await this.save();
  }

  async remove(id: SubscriptionId): Promise<boolean> {
    const file = await this.load();
    const before = file.subscriptions.length;
    file.subscriptions = file.subscriptions.filter((s) => s.id !== id);
    if (file.subscriptions.length === before) return false;
    file.updatedAt = new Date().toISOString();
    this.cache = file;
    await this.save();
    return true;
  }

  async setGlobalBudget(usd: number, behavior: "block" | "warn" = "block"): Promise<void> {
    const file = await this.load();
    file.globalMonthlyBudgetUsd = usd;
    file.overBudgetBehavior = behavior;
    file.updatedAt = new Date().toISOString();
    this.cache = file;
    await this.save();
  }

  async save(): Promise<void> {
    if (!this.cache) return;
    await fs.mkdir(path.dirname(this.globalPath), { recursive: true });
    await fs.writeFile(this.globalPath, JSON.stringify(this.cache, null, 2) + "\n", "utf8");
  }

  // ── 顯示摘要 ────────────────────────────────────────────────────

  async summary(): Promise<string> {
    const file = await this.load();
    const plans = await this.getActivePlans();

    const lines: string[] = ["📋 已登記的訂閱方案：", ""];

    if (plans.length === 0) {
      lines.push("  （尚未登記任何訂閱，僅執行零成本操作）");
    } else {
      // 按廠商分組
      const byProvider: Record<string, SubscriptionPlan[]> = {};
      for (const p of plans) {
        if (!byProvider[p.provider]) byProvider[p.provider] = [];
        byProvider[p.provider]!.push(p);
      }

      for (const [prov, provPlans] of Object.entries(byProvider)) {
        lines.push(`  ── ${prov} ──`);
        for (const plan of provPlans) {
          const entry = file.subscriptions.find((s) => s.id === plan.id)!;
          const priceStr =
            plan.monthlyUsd > 0
              ? `$${plan.monthlyUsd}/月`
              : plan.isApiKeyMode
                ? "per-token"
                : "免費層   ";

          lines.push(
            `  ✅ ${plan.displayName.padEnd(28)} ${priceStr}` +
              (entry.note ? `  （${entry.note}）` : ""),
          );

          // 計費週期（只有付費訂閱才顯示）
          if (plan.monthlyUsd > 0) {
            const cycle = this.getBillingCycle(entry);
            const bar = this.renderProgressBar(cycle.percentElapsed, 20);
            lines.push(
              `     📅 計費週期：每月 ${cycle.cycleDay} 日重置  ` +
                `${bar} ${cycle.percentElapsed.toFixed(0)}%  ` +
                `剩 ${cycle.daysRemaining} 天`,
            );
            lines.push(`     當期：${fmtDate(cycle.periodStart)} → ${fmtDate(cycle.periodEnd)}`);
          }

          if (plan.covers.length > 0) {
            lines.push(`     覆蓋：${plan.covers.join("、")}`);
          }
          lines.push("");
        }
      }
    }

    lines.push("📊 操作覆蓋矩陣：", "");
    const allOps: NuwaOperation[] = [
      "internal_compute",
      "nuwa_mcp",
      "tavily_search",
      "claude_code_cli",
      "claude_api",
      "codex_cli",
      "openai_api",
      "gemini_api",
      "mistral_api",
      "groq_api",
      "xai_api",
      "deepseek_api",
      "perplexity_api",
      "together_api",
      "cohere_api",
      "moa_claude",
      "moa_openai",
      "moa_gemini",
      "moa_any",
    ];

    for (const op of allOps) {
      const cov = await this.isCovered(op);
      lines.push(`  ${cov.covered ? "✅" : "🚫"} ${op.padEnd(22)} ${cov.reason}`);
    }

    lines.push("");
    if (file.globalMonthlyBudgetUsd && file.globalMonthlyBudgetUsd > 0) {
      lines.push(
        `💰 全域月預算：$${file.globalMonthlyBudgetUsd}（超過時${file.overBudgetBehavior === "block" ? "封鎖" : "警告"}）`,
      );
    } else {
      lines.push("💰 全域月預算：未設定");
    }
    return lines.join("\n");
  }

  private renderProgressBar(percent: number, width: number): string {
    const filled = Math.round((percent / 100) * width);
    return "[" + "█".repeat(filled) + "░".repeat(width - filled) + "]";
  }

  // ── 列出所有可用方案 ─────────────────────────────────────────────

  static listAllPlans(): string {
    const groups: Record<string, SubscriptionPlan[]> = {};
    for (const plan of Object.values(SUBSCRIPTION_PLANS)) {
      if (!groups[plan.provider]) groups[plan.provider] = [];
      groups[plan.provider]!.push(plan);
    }

    const lines = ["📦 所有可登記的訂閱方案：", "（格式：nuwa sub add <id>）", ""];
    for (const [prov, plans] of Object.entries(groups)) {
      lines.push(`── ${prov} ──`);
      for (const p of plans) {
        const price =
          p.monthlyUsd > 0 ? `$${p.monthlyUsd}/月` : p.isApiKeyMode ? "per-token" : "免費層  ";
        lines.push(`  ${p.id.padEnd(32)} ${price.padEnd(10)}  ${p.description}`);
      }
      lines.push("");
    }
    lines.push("快速偵測：");
    lines.push("  nuwa sub detect    從環境變數自動偵測所有已設定的訂閱");
    return lines.join("\n");
  }

  private requiredFor(op: NuwaOperation): string[] {
    return Object.values(SUBSCRIPTION_PLANS)
      .filter((p) => p.covers.includes(op))
      .map((p) => p.id);
  }
}

export function createSubscriptionRegistry(stateDir: string): SubscriptionRegistry {
  return new SubscriptionRegistry(stateDir);
}

// ─── 工具函數 ────────────────────────────────────────────────────────

export function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
