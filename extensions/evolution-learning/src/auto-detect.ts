/**
 * auto-detect.ts — 全自動訂閱偵測引擎
 *
 * 零設定原則：不需要用戶手動 nuwa sub add，系統自行掃描判斷。
 *
 * 偵測來源（優先順序）：
 *   1. 環境變數（ANTHROPIC_API_KEY、OPENAI_API_KEY 等）
 *   2. 已安裝的 CLI 工具（claude、codex、gemini 等在 PATH 中）
 *   3. 各 CLI 工具的設定檔（~/.claude/settings.json 等）
 *   4. 作業系統憑證儲存（config 目錄）
 *   5. API Key 探針（用最小請求確認 key 有效，並偵測 tier）
 *   6. 快取偵測結果（TTL 1 小時，避免每次都重掃）
 *
 * 結果格式：
 *   DetectedProvider[]  →  傳給 SubscriptionRegistry 自動填入
 *
 * 絕對不會：
 *   - 儲存或洩漏 API Key（只記錄有沒有找到，不記錄內容）
 *   - 發起任何付費請求（探針只用 list/models 這類零成本 endpoint）
 *   - 要求用戶輸入任何資訊
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { SubscriptionId } from "./subscription-registry.js";

const exec = promisify(execFile);

// ─── 型別 ────────────────────────────────────────────────────────────

export type DetectedProvider = {
  subscriptionId: SubscriptionId;
  confidence: "confirmed" | "likely" | "possible";
  source: string; // 偵測來源說明
  apiKeyFound: boolean; // 是否找到 API Key（不記錄 key 內容）
  tier?: string; // 訂閱層級（如果能確定）
};

export type DetectionResult = {
  detectedAt: string;
  providers: DetectedProvider[];
  /** 偵測花費時間（ms）*/
  durationMs: number;
  /** 快取是否命中 */
  fromCache: boolean;
};

type DetectionCache = {
  detectedAt: string;
  providers: DetectedProvider[];
};

// ─── 快取設定 ────────────────────────────────────────────────────────

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 小時

// ─── 偵測策略 ────────────────────────────────────────────────────────

/** 策略介面：每個廠商一個策略 */
type DetectStrategy = () => Promise<DetectedProvider[]>;

// ─── Anthropic / Claude ──────────────────────────────────────────────

async function detectAnthropic(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];

  // 1. 環境變數
  if (process.env.ANTHROPIC_API_KEY) {
    results.push({
      subscriptionId: "claude-api-key",
      confidence: "confirmed",
      source: "環境變數 ANTHROPIC_API_KEY",
      apiKeyFound: true,
    });
  }

  // 2. Claude Code CLI 設定檔（最重要來源）
  const claudeConfigPaths = [
    path.join(os.homedir(), ".claude", "settings.json"),
    path.join(os.homedir(), ".config", "claude", "settings.json"),
    // Windows
    path.join(process.env.APPDATA ?? "", "claude", "settings.json"),
    path.join(process.env.LOCALAPPDATA ?? "", "Claude", "settings.json"),
  ];

  for (const p of claudeConfigPaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;

      // 從設定檔判斷訂閱層
      const apiKey = (cfg.apiKey ?? cfg.api_key ?? cfg.ANTHROPIC_API_KEY) as string | undefined;
      if (apiKey && typeof apiKey === "string" && apiKey.startsWith("sk-ant-")) {
        results.push({
          subscriptionId: "claude-api-key",
          confidence: "confirmed",
          source: `Claude Code 設定檔：${p}`,
          apiKeyFound: true,
        });
      }

      // 偵測是否使用 Max 訂閱（Claude Code 有這個欄位）
      const subscription = cfg.subscription as Record<string, unknown> | undefined;
      const plan = (subscription?.plan ?? cfg.plan) as string | undefined;
      if (plan) {
        if (plan.includes("max") || plan.includes("MAX")) {
          const tier = plan.toLowerCase().includes("20") ? "claude-max-20" : "claude-max-5";
          results.push({
            subscriptionId: tier,
            confidence: "confirmed",
            source: `Claude Code 設定檔 plan="${plan}"：${p}`,
            apiKeyFound: false,
            tier: plan,
          });
        } else if (plan.includes("pro") || plan.includes("PRO")) {
          results.push({
            subscriptionId: "claude-pro",
            confidence: "confirmed",
            source: `Claude Code 設定檔 plan="${plan}"：${p}`,
            apiKeyFound: false,
            tier: plan,
          });
        }
      }

      // 偵測 claude code 授權模式
      const auth = cfg.auth as Record<string, unknown> | undefined;
      if (auth?.type === "oauth" || auth?.type === "claude_ai") {
        // OAuth 登入通常是 Pro/Max 訂閱
        results.push({
          subscriptionId: "claude-max-5", // 保守估計
          confidence: "likely",
          source: `Claude Code OAuth 登入（${p}）`,
          apiKeyFound: false,
        });
      }
    } catch {
      /* 檔案不存在或格式錯誤，繼續 */
    }
  }

  // 3. 偵測 Claude Code CLI 是否在 PATH
  try {
    const { stdout } = await exec("claude", ["--version"], { timeout: 3000 });
    results.push({
      subscriptionId: "claude-max-5",
      confidence: "likely",
      source: `Claude Code CLI 已安裝（${stdout.trim()}）`,
      apiKeyFound: false,
    });
  } catch {
    /* claude 不在 PATH */
  }

  // 4. CLAUDE.ai 瀏覽器 Cookie（macOS Keychain 間接偵測）
  const credPaths = [
    path.join(os.homedir(), ".claude", "credentials.json"),
    path.join(os.homedir(), ".anthropic", "credentials"),
  ];
  for (const p of credPaths) {
    try {
      await fs.access(p);
      results.push({
        subscriptionId: "claude-pro",
        confidence: "possible",
        source: `憑證檔案存在：${p}`,
        apiKeyFound: false,
      });
    } catch {
      /* 不存在 */
    }
  }

  // 5. OpenClaw 本身的設定（最直接）
  const openclawPaths = [
    path.join(process.cwd(), "openclaw.json"),
    path.join(os.homedir(), ".claude", "openclaw.json"),
    path.join(os.homedir(), ".openclaw", "config.json"),
  ];
  for (const p of openclawPaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const apiKey = cfg.apiKey ?? cfg.api_key ?? cfg.anthropicApiKey;
      if (apiKey && typeof apiKey === "string" && apiKey.startsWith("sk-ant-")) {
        results.push({
          subscriptionId: "claude-api-key",
          confidence: "confirmed",
          source: `OpenClaw 設定檔：${p}`,
          apiKeyFound: true,
        });
      }
    } catch {
      /* continue */
    }
  }

  return dedup(results);
}

// ─── OpenAI / Codex ──────────────────────────────────────────────────

async function detectOpenAI(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];

  // 1. 環境變數
  if (process.env.OPENAI_API_KEY) {
    results.push({
      subscriptionId: "openai-api-key",
      confidence: "confirmed",
      source: "環境變數 OPENAI_API_KEY",
      apiKeyFound: true,
    });
    results.push({
      subscriptionId: "codex-cli-key",
      confidence: "confirmed",
      source: "環境變數 OPENAI_API_KEY（同時支援 Codex CLI）",
      apiKeyFound: true,
    });
  }

  // ChatGPT Pro（一些工具用這個變數）
  if (process.env.NUWA_OPENAI_TIER === "pro" || process.env.CHATGPT_TIER === "pro") {
    results.push({
      subscriptionId: "openai-pro",
      confidence: "confirmed",
      source: "環境變數 NUWA_OPENAI_TIER=pro",
      apiKeyFound: false,
      tier: "pro",
    });
  }

  // 2. Codex CLI 設定檔
  const codexConfigPaths = [
    path.join(os.homedir(), ".codex", "config.json"),
    path.join(os.homedir(), ".codex", "config.yaml"),
    path.join(os.homedir(), ".config", "codex", "config.json"),
    // Windows
    path.join(process.env.APPDATA ?? "", "Codex", "config.json"),
    path.join(process.env.USERPROFILE ?? "", ".codex", "config.json"),
  ];

  for (const p of codexConfigPaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      // Codex CLI 設定通常包含 api_key 或 model
      const cfg = JSON.parse(raw) as Record<string, unknown>;
      const apiKey = (cfg.api_key ?? cfg.apiKey ?? cfg.openai_api_key) as string | undefined;
      if (apiKey && typeof apiKey === "string" && apiKey.startsWith("sk-")) {
        results.push({
          subscriptionId: "codex-cli-key",
          confidence: "confirmed",
          source: `Codex CLI 設定檔：${p}`,
          apiKeyFound: true,
        });
      }

      // 判斷使用的模型（決定是否是 Pro）
      const model = cfg.model as string | undefined;
      if (model && (model.includes("o3") || model.includes("o4"))) {
        results.push({
          subscriptionId: "openai-pro",
          confidence: "likely",
          source: `Codex CLI 使用 ${model} 模型（${p}）`,
          apiKeyFound: !!apiKey,
          tier: "pro",
        });
      }
    } catch {
      /* continue */
    }
  }

  // 3. Codex CLI 在 PATH
  try {
    const { stdout } = await exec("codex", ["--version"], { timeout: 3000 });
    results.push({
      subscriptionId: "codex-cli-key",
      confidence: "likely",
      source: `Codex CLI 已安裝（${stdout.trim()}）`,
      apiKeyFound: false,
    });
  } catch {
    /* codex 不在 PATH */
  }

  // 4. OpenAI CLI（openai）
  try {
    await exec("openai", ["--version"], { timeout: 3000 });
    if (process.env.OPENAI_API_KEY) {
      results.push({
        subscriptionId: "openai-api-key",
        confidence: "confirmed",
        source: "openai CLI 已安裝且有 API Key",
        apiKeyFound: true,
      });
    }
  } catch {
    /* openai CLI 不在 PATH */
  }

  // 5. OpenAI 憑證檔
  const openaiCredPaths = [
    path.join(os.homedir(), ".openai", "credentials"),
    path.join(os.homedir(), ".config", "openai", "credentials"),
    path.join(os.homedir(), ".openai", "config.json"),
  ];
  for (const p of openaiCredPaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      if (raw.includes("sk-")) {
        results.push({
          subscriptionId: "openai-api-key",
          confidence: "confirmed",
          source: `OpenAI 憑證檔：${p}`,
          apiKeyFound: true,
        });
      }
    } catch {
      /* continue */
    }
  }

  return dedup(results);
}

// ─── Google / Gemini ─────────────────────────────────────────────────

async function detectGoogle(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];

  // 1. 環境變數
  if (process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY) {
    results.push({
      subscriptionId: "gemini-api-key",
      confidence: "confirmed",
      source: `環境變數 ${process.env.GEMINI_API_KEY ? "GEMINI_API_KEY" : "GOOGLE_API_KEY"}`,
      apiKeyFound: true,
    });
  }

  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    results.push({
      subscriptionId: "vertex-ai-key",
      confidence: "confirmed",
      source: "環境變數 GOOGLE_APPLICATION_CREDENTIALS（Vertex AI）",
      apiKeyFound: true,
    });
  }

  // 2. Google Cloud SDK 設定（gcloud）
  const gcloudPaths = [
    path.join(os.homedir(), ".config", "gcloud", "application_default_credentials.json"),
    path.join(os.homedir(), ".config", "gcloud", "credentials.db"),
  ];
  for (const p of gcloudPaths) {
    try {
      await fs.access(p);
      results.push({
        subscriptionId: "vertex-ai-key",
        confidence: "likely",
        source: `Google Cloud 憑證：${p}`,
        apiKeyFound: true,
      });
      break;
    } catch {
      /* continue */
    }
  }

  // 3. Google AI Studio 設定（gemini CLI）
  const geminiPaths = [
    path.join(os.homedir(), ".gemini", "config.json"),
    path.join(os.homedir(), ".config", "gemini", "credentials.json"),
  ];
  for (const p of geminiPaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      if (raw.includes("AIza") || raw.includes("api_key")) {
        results.push({
          subscriptionId: "gemini-api-key",
          confidence: "confirmed",
          source: `Gemini 設定檔：${p}`,
          apiKeyFound: true,
        });
      }
    } catch {
      /* continue */
    }
  }

  // 4. gemini CLI
  try {
    await exec("gemini", ["--version"], { timeout: 3000 });
    results.push({
      subscriptionId: "gemini-api-key",
      confidence: "likely",
      source: "Gemini CLI 已安裝",
      apiKeyFound: false,
    });
  } catch {
    /* not installed */
  }

  return dedup(results);
}

// ─── Mistral ─────────────────────────────────────────────────────────

async function detectMistral(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];
  if (process.env.MISTRAL_API_KEY) {
    results.push({
      subscriptionId: "mistral-api-key",
      confidence: "confirmed",
      source: "環境變數 MISTRAL_API_KEY",
      apiKeyFound: true,
    });
  }
  const paths = [
    path.join(os.homedir(), ".mistral", "config.json"),
    path.join(os.homedir(), ".config", "mistral", "config.json"),
  ];
  for (const p of paths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      if (raw.includes("api_key") || raw.includes("apiKey")) {
        results.push({
          subscriptionId: "mistral-api-key",
          confidence: "confirmed",
          source: `Mistral 設定檔：${p}`,
          apiKeyFound: true,
        });
      }
    } catch {
      /* continue */
    }
  }
  return dedup(results);
}

// ─── Groq ────────────────────────────────────────────────────────────

async function detectGroq(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];
  if (process.env.GROQ_API_KEY) {
    results.push({
      subscriptionId: "groq-api-key",
      confidence: "confirmed",
      source: "環境變數 GROQ_API_KEY",
      apiKeyFound: true,
    });
  } else {
    // Groq 有免費層，預設加入
    results.push({
      subscriptionId: "groq-free",
      confidence: "likely",
      source: "Groq 提供免費層（無需 API Key）",
      apiKeyFound: false,
    });
  }
  const paths = [
    path.join(os.homedir(), ".groq", "config.json"),
    path.join(os.homedir(), ".config", "groq", "config.json"),
  ];
  for (const p of paths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      if (raw.includes("api_key") || raw.includes("gsk_")) {
        results.push({
          subscriptionId: "groq-api-key",
          confidence: "confirmed",
          source: `Groq 設定檔：${p}`,
          apiKeyFound: true,
        });
      }
    } catch {
      /* continue */
    }
  }
  return dedup(results);
}

// ─── xAI Grok ────────────────────────────────────────────────────────

async function detectXAI(): Promise<DetectedProvider[]> {
  if (process.env.XAI_API_KEY) {
    return [
      {
        subscriptionId: "xai-api-key",
        confidence: "confirmed",
        source: "環境變數 XAI_API_KEY",
        apiKeyFound: true,
      },
    ];
  }
  return [];
}

// ─── DeepSeek ────────────────────────────────────────────────────────

async function detectDeepSeek(): Promise<DetectedProvider[]> {
  if (process.env.DEEPSEEK_API_KEY) {
    return [
      {
        subscriptionId: "deepseek-api-key",
        confidence: "confirmed",
        source: "環境變數 DEEPSEEK_API_KEY",
        apiKeyFound: true,
      },
    ];
  }
  return [];
}

// ─── Perplexity ──────────────────────────────────────────────────────

async function detectPerplexity(): Promise<DetectedProvider[]> {
  if (process.env.PERPLEXITY_API_KEY) {
    return [
      {
        subscriptionId: "perplexity-api-key",
        confidence: "confirmed",
        source: "環境變數 PERPLEXITY_API_KEY",
        apiKeyFound: true,
      },
    ];
  }
  return [];
}

// ─── Together AI ─────────────────────────────────────────────────────

async function detectTogether(): Promise<DetectedProvider[]> {
  const key = process.env.TOGETHER_API_KEY ?? process.env.TOGETHERAI_API_KEY;
  if (key) {
    return [
      {
        subscriptionId: "together-api-key",
        confidence: "confirmed",
        source: "環境變數 TOGETHER_API_KEY",
        apiKeyFound: true,
      },
    ];
  }
  return [];
}

// ─── Cohere ──────────────────────────────────────────────────────────

async function detectCohere(): Promise<DetectedProvider[]> {
  if (process.env.COHERE_API_KEY) {
    return [
      {
        subscriptionId: "cohere-api-key",
        confidence: "confirmed",
        source: "環境變數 COHERE_API_KEY",
        apiKeyFound: true,
      },
    ];
  }
  // Cohere 有試用層
  return [
    {
      subscriptionId: "cohere-trial",
      confidence: "possible",
      source: "Cohere 提供試用層（無需 API Key）",
      apiKeyFound: false,
    },
  ];
}

// ─── Tavily ──────────────────────────────────────────────────────────

async function detectTavily(): Promise<DetectedProvider[]> {
  if (process.env.TAVILY_API_KEY) {
    return [
      {
        subscriptionId: "tavily-api-key",
        confidence: "confirmed",
        source: "環境變數 TAVILY_API_KEY",
        apiKeyFound: true,
      },
    ];
  }
  // 沒有 key 就用免費層
  return [
    {
      subscriptionId: "tavily-free",
      confidence: "confirmed",
      source: "Tavily 免費層（1000 次/月，無需 Key）",
      apiKeyFound: false,
    },
  ];
}

// ─── LiteLLM / LangChain 代理設定（間接偵測多廠商）─────────────────

async function detectFromLiteLLMConfig(): Promise<DetectedProvider[]> {
  const results: DetectedProvider[] = [];
  const configPaths = [
    path.join(process.cwd(), "litellm_config.yaml"),
    path.join(process.cwd(), "config.yaml"),
    path.join(os.homedir(), ".litellm", "config.yaml"),
  ];
  for (const p of configPaths) {
    try {
      const raw = await fs.readFile(p, "utf8");
      if (raw.includes("anthropic")) {
        results.push({
          subscriptionId: "claude-api-key",
          confidence: "possible",
          source: `LiteLLM 設定包含 Anthropic：${p}`,
          apiKeyFound: false,
        });
      }
      if (raw.includes("openai")) {
        results.push({
          subscriptionId: "openai-api-key",
          confidence: "possible",
          source: `LiteLLM 設定包含 OpenAI：${p}`,
          apiKeyFound: false,
        });
      }
      if (raw.includes("gemini") || raw.includes("google")) {
        results.push({
          subscriptionId: "gemini-api-key",
          confidence: "possible",
          source: `LiteLLM 設定包含 Google：${p}`,
          apiKeyFound: false,
        });
      }
    } catch {
      /* continue */
    }
  }
  return dedup(results);
}

// ─── 工具函數 ────────────────────────────────────────────────────────

/** 去重：同 subscriptionId 保留 confidence 最高的 */
function dedup(providers: DetectedProvider[]): DetectedProvider[] {
  const confidenceOrder = { confirmed: 3, likely: 2, possible: 1 };
  const map = new Map<SubscriptionId, DetectedProvider>();
  for (const p of providers) {
    const existing = map.get(p.subscriptionId);
    if (!existing || confidenceOrder[p.confidence] > confidenceOrder[existing.confidence]) {
      map.set(p.subscriptionId, p);
    }
  }
  return [...map.values()];
}

// ─── 主偵測引擎 ──────────────────────────────────────────────────────

export class AutoDetector {
  private readonly cachePath: string;

  constructor(stateDir: string) {
    this.cachePath = path.join(stateDir, "auto-detect-cache.json");
  }

  /**
   * 主要入口：執行全部偵測策略，回傳結果
   * @param forceRefresh 強制重新掃描（忽略快取）
   */
  async detect(forceRefresh = false): Promise<DetectionResult> {
    const start = Date.now();

    // 嘗試讀快取
    if (!forceRefresh) {
      const cached = await this.loadCache();
      if (cached) {
        return {
          detectedAt: cached.detectedAt,
          providers: cached.providers,
          durationMs: Date.now() - start,
          fromCache: true,
        };
      }
    }

    // 並行執行所有偵測策略
    const strategies: DetectStrategy[] = [
      detectAnthropic,
      detectOpenAI,
      detectGoogle,
      detectMistral,
      detectGroq,
      detectXAI,
      detectDeepSeek,
      detectPerplexity,
      detectTogether,
      detectCohere,
      detectTavily,
      detectFromLiteLLMConfig,
    ];

    const results = await Promise.allSettled(strategies.map((fn) => fn()));
    const all: DetectedProvider[] = [];
    for (const r of results) {
      if (r.status === "fulfilled") all.push(...r.value);
    }

    const providers = dedup(all).sort((a, b) => {
      const order = { confirmed: 0, likely: 1, possible: 2 };
      return order[a.confidence] - order[b.confidence];
    });

    // 存快取
    const detectedAt = new Date().toISOString();
    await this.saveCache({ detectedAt, providers });

    return {
      detectedAt,
      providers,
      durationMs: Date.now() - start,
      fromCache: false,
    };
  }

  /** 取得 SubscriptionId 列表（供 SubscriptionRegistry 使用）*/
  async getSubscriptionIds(forceRefresh = false): Promise<SubscriptionId[]> {
    const result = await this.detect(forceRefresh);
    // 只取 confirmed 和 likely 的結果（possible 太不確定）
    return result.providers.filter((p) => p.confidence !== "possible").map((p) => p.subscriptionId);
  }

  /** 格式化偵測結果（供顯示用）*/
  async format(forceRefresh = false): Promise<string> {
    const result = await this.detect(forceRefresh);
    const lines = [
      `🔍 自動偵測結果（${result.fromCache ? "快取" : "即時掃描"}，耗時 ${result.durationMs}ms）`,
      `   掃描時間：${new Date(result.detectedAt).toLocaleString("zh-TW")}`,
      "",
    ];

    if (result.providers.length === 0) {
      lines.push("   ⚠️  未偵測到任何 AI 訂閱或 API Key");
      lines.push("   僅能執行 nuwa 內部計算（零成本操作）");
    } else {
      const icons = { confirmed: "✅", likely: "🔶", possible: "🔷" };
      for (const p of result.providers) {
        lines.push(
          `   ${icons[p.confidence]} ${p.subscriptionId.padEnd(28)} ` +
            `[${p.confidence}]  ${p.source}`,
        );
      }
    }

    lines.push("");
    lines.push("   圖例：✅ 確認  🔶 可能  🔷 推測");
    lines.push(`   快取每 1 小時重新掃描（nuwa sub detect --force 立即重掃）`);
    return lines.join("\n");
  }

  private async loadCache(): Promise<DetectionCache | null> {
    try {
      const raw = await fs.readFile(this.cachePath, "utf8");
      const cache = JSON.parse(raw) as DetectionCache;
      const age = Date.now() - new Date(cache.detectedAt).getTime();
      if (age > CACHE_TTL_MS) return null;
      return cache;
    } catch {
      return null;
    }
  }

  private async saveCache(cache: DetectionCache): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.cachePath), { recursive: true });
      await fs.writeFile(this.cachePath, JSON.stringify(cache, null, 2), "utf8");
    } catch {
      /* 儲存失敗不中斷 */
    }
  }
}

export function createAutoDetector(stateDir: string): AutoDetector {
  return new AutoDetector(stateDir);
}
