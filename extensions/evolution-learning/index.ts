/**
 * 四層進化學習擴充套件
 *
 * 第一層（運行即學習）：每次對話前讀取 patterns.jsonl，偵測人物框架需求並注入
 * 第二層（神經路由）  ：before_model_resolve 分析任務類型，建議最佳路由
 * 第三層（增長心跳）  ：registerService 背景定時跑 REM 週期，更新成熟度
 * 第四層（有機細胞）  ：追蹤幹細胞成熟度，自動晉升常駐細胞
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "typebox";

// ─── 常數 ──────────────────────────────────────────────────────
const PLUGIN_ID = "evolution-learning";
const DEFAULT_MAX_CONTEXT_TOKENS = 300;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.65;
const DEFAULT_REM_CYCLE_HOURS = 8;
const DEFAULT_MATURITY_THRESHOLD = 0.8;
const CACHE_TTL_MS = 60_000; // 1 分鐘快取
const EMA_ALPHA = 0.1; // EMA 更新步長

// ── 代謝常數 ──────────────────────────────────────────────────────
const METABOLISM_IDLE_DAYS = 30; // 超過 N 天未使用才開始衰減
const METABOLISM_DECAY_PER_DAY = 0.02; // 每閒置 1 天降 2% 信心度
const METABOLISM_MIN_CONFIDENCE = 0.1; // 衰減下限（不歸零，讓 frozen 免疫）

// ── DNA 遺傳常數 ──────────────────────────────────────────────────
const DNA_INHERIT_THRESHOLD = 0.12; // 相似度 > 0.12 才繼承親代 mentalModels（含同類型加成後）
const DNA_INHERIT_PREFIX = "[遺傳]"; // 繼承模型的前綴，便於識別

// ── L2 生長常數 ──────────────────────────────────────────────────
const L2_GROWTH_MIN_POSITIVE = 3; // 至少 N 個正向記錄才觸發生長
const L2_GROWTH_MAX_NEW_MODELS = 2; // 每 REM 週期最多新增 N 個心智模型
const L2_GROWTH_MAX_TOTAL = 10; // 每個 pattern 最多保留 N 個心智模型

// ── 軟連線常數（神經元模組 × 動態權重）─────────────────────────────
const SOFT_LINK_WINDOW_MS = 5 * 60 * 1000; // 共激活視窗：5 分鐘
const SOFT_LINK_INCREMENT = 0.05; // 每次共激活增量
const SOFT_LINK_DECAY = 0.01; // REM 週期每次衰減（防過度連結）
const SOFT_LINK_MAX_WEIGHT = 1.0; // 權重上限
const SOFT_LINK_BOOST = 0.05; // 軟連線信心度加成
const SOFT_LINK_THRESHOLD = 0.2; // 觸發加成的最低連線權重
// 熱啟動語義預播種
const WARM_SEED_WEIGHT = 0.03; // 語義相似對的初始底線強度（低於一次真實共激活 0.05）
const WARM_SEED_MIN_OVERLAP = 1; // 至少 N 個 keyword 或 mentalModel 重疊才播種

// ── 循環回流常數（L4 → L2 反饋）──────────────────────────────────
const CIRCULATORY_KEYWORD_BOOST = 0.08; // 因果鏈共現加成

// ── Hermes 橋接常數 ────────────────────────────────────────────────
const HERMES_LEARNING_RELATIVE_PATH = path.join(
  "reports",
  "hermes-agent",
  "state",
  "hermes-learning-state.json",
);
const HERMES_WATERMARK_FILE = "hermes-import-watermark.json";

// ── 自動蒸餾常數 ──────────────────────────────────────────────────
const AUTO_DISTILL_THRESHOLD_DEFAULT = 8;
const AUTO_DISTILL_MAX_QUERIES = 3; // 每次最多幾個搜尋查詢
const AUTO_DISTILLED_CONFIDENCE = 0.55; // 有搜尋資料時的初始信心度
const AUTO_DISTILLED_HEURISTIC_CONFIDENCE = 0.45; // 無搜尋資料時（略高於胚胎 0.40）
const DISTILL_COMPLETED_FILE = "distill-completed.json";

// ─── 型別定義 ──────────────────────────────────────────────────

type PluginConfig = {
  enabled: boolean;
  maxContextTokens: number;
  confidenceThreshold: number;
  remCycleHours: number;
  maturityThreshold: number;
  logging: boolean;
  tavilyApiKey?: string;
  autoDistillEnabled: boolean;
  autoDistillThreshold: number;
};

type NuwaPattern = {
  id: string;
  type: string;
  category: string;
  target: string;
  slug: string;
  confidence: number;
  successRate: number;
  sampleCount: number;
  mentalModels: string[];
  keywords?: string[]; // 動態觸發關鍵字（取代硬編碼常數表）
  sourceCount: number;
  context: string;
  skillPath?: string; // L3：技能文件路徑（embryo installed 時動態載入）
  frozen?: boolean; // 凍結：不受負向信號降級（官方蒸餾模式用）
  createdAt: string;
  lastUsed: string | null;
};

type StemCell = {
  id: string;
  type: string;
  target: string;
  slug: string;
  patternId: string;
  status: "embryo" | "incubating" | "ready" | "installed";
  maturityScore: number;
  usageCount: number;
  positiveRating: number;
  skillPath: string;
  createdAt: string;
  lastEvaluated: string | null;
};

type CellRegistry = {
  version: number;
  cells: Record<string, unknown>;
  stemCells: StemCell[];
};

type GrowthMetrics = {
  version: number;
  lastUpdated: string;
  embryos: Array<{
    id: string;
    target: string;
    maturityScore: number;
    status: string;
    addedAt: string;
    nextEvaluation: string;
  }>;
};

// ── 軟連線：神經元模組 × 動態權重矩陣 ────────────────────────────────
// 記錄 pattern 間的共激活強度（跨請求、持久化）
// links[patternIdA][patternIdB] = weight ∈ [0, 1]
type SoftLinks = {
  version: number;
  links: Record<string, Record<string, number>>;
  lastUpdated: string;
};

// ─── 進化狀態快取（模組層級，跨請求共享）────────────────────────

let evolutionStateDir: string | null = null;
let evolutionWorkspaceDir: string | null = null; // 儲存 workspace 根目錄
let patternsCache: NuwaPattern[] = [];
let patternsCacheAt = 0;
let registryCache: CellRegistry | null = null;
let registryCacheAt = 0;
let softLinksCache: SoftLinks | null = null;
let softLinksCacheAt = 0;

// 軟連線共激活視窗：記錄最近 N 分鐘內激活過的 pattern
const recentActivationWindow: Array<{ patternId: string; activatedAt: number }> = [];

// ─── Dual-gate：per-request 捕獲狀態 ────────────────────────────
// Gate 1 (Capture)  : before_prompt_build 匹配成功後寫入此 Map
// Gate 2 (Consolidate): agent_end 只處理此 Map 中存在的請求
// Key = agentId（若有）或 requestId；Value = 本輪匹配的 pattern
type CapturedActivation = {
  patternId: string;
  slug: string;
  target: string;
  capturedAt: number; // Date.now()
  prompt: string; // 原始提示（供 L4 因果鏈記錄）
};
const capturedActivations = new Map<string, CapturedActivation>();

// ── Level 3 Hermes Curator：自適應 REM 排程狀態 ──────────────────
// 記錄最後有 Gate 2 活動的時間（用於判斷活躍 vs 閒置）
let hermesLastActivityAt = 0;
let hermesTimer: ReturnType<typeof setTimeout> | null = null;
const HERMES_ACTIVE_INTERVAL_MS = 30 * 60 * 1000; // 活躍期：30 分鐘
const HERMES_ACTIVITY_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 小時內算「活躍」

// 清理超過 10 分鐘的孤兒記錄（防記憶體洩漏）
const ACTIVATION_TTL_MS = 10 * 60 * 1000;
function purgeStaleActivations(): void {
  const now = Date.now();
  for (const [key, val] of capturedActivations.entries()) {
    if (now - val.capturedAt > ACTIVATION_TTL_MS) {
      capturedActivations.delete(key);
    }
  }
}

// ─── 解構說明：PERSONA_TRIGGER_PATTERNS 已移除 ─────────────────
// 舊設計：硬編碼關鍵字表 → 加新 persona 需改原始碼（封閉架構）
// 新設計：從 patterns.jsonl 的 keywords 欄位動態讀取（開放架構）
//
// detectPersonaIntent() 現在直接讀取 pattern.keywords，不再依賴常數表。
// 每個 pattern 文件自帶它的觸發關鍵字，完全解耦。

// ─── 第二層：任務類型分類（神經路由）────────────────────────────
// 解構說明：TASK_KEYWORDS 從未被使用過（無對應 hook 註冊），現在
// 移入真正的分類函式，供 before_prompt_build 回傳 taskType。

type TaskType = "investment" | "decision" | "analysis" | "learning" | "general";

const TASK_KEYWORD_MAP: Record<TaskType, string[]> = {
  investment: [
    "投資",
    "股票",
    "估值",
    "護城河",
    "回報",
    "investment",
    "stock",
    "valuation",
    "portfolio",
  ],
  decision: ["決策", "選擇", "應該怎麼", "怎麼判斷", "decision", "choose", "should I", "evaluate"],
  analysis: ["分析", "評估", "研究", "拆解", "分拆", "analyze", "assess", "breakdown", "dissect"],
  learning: ["學習", "理解", "怎麼學", "解釋", "learn", "understand", "study", "explain"],
  general: [],
};

/** 從 prompt 判斷任務類型（第二層神經路由 — 替換原本的 TASK_KEYWORDS 死程式碼） */
function classifyTask(prompt: string): TaskType {
  const lower = prompt.toLowerCase();
  for (const [type, keywords] of Object.entries(TASK_KEYWORD_MAP) as Array<[TaskType, string[]]>) {
    if (type === "general") continue;
    if (keywords.some((kw) => lower.includes(kw))) return type;
  }
  return "general";
}

// ─── 輔助函式 ──────────────────────────────────────────────────

function normalizeConfig(raw: Record<string, unknown> | undefined): PluginConfig {
  return {
    enabled: raw?.enabled !== false,
    maxContextTokens:
      typeof raw?.maxContextTokens === "number" ? raw.maxContextTokens : DEFAULT_MAX_CONTEXT_TOKENS,
    confidenceThreshold:
      typeof raw?.confidenceThreshold === "number"
        ? raw.confidenceThreshold
        : DEFAULT_CONFIDENCE_THRESHOLD,
    remCycleHours:
      typeof raw?.remCycleHours === "number" ? raw.remCycleHours : DEFAULT_REM_CYCLE_HOURS,
    maturityThreshold:
      typeof raw?.maturityThreshold === "number"
        ? raw.maturityThreshold
        : DEFAULT_MATURITY_THRESHOLD,
    logging: raw?.logging === true,
    tavilyApiKey:
      typeof raw?.tavilyApiKey === "string" && raw.tavilyApiKey ? raw.tavilyApiKey : undefined,
    autoDistillEnabled: raw?.autoDistillEnabled !== false,
    autoDistillThreshold:
      typeof raw?.autoDistillThreshold === "number"
        ? raw.autoDistillThreshold
        : AUTO_DISTILL_THRESHOLD_DEFAULT,
  };
}

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function safeWriteFile(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return true;
  } catch {
    return false;
  }
}

/** 確保進化狀態目錄存在 */
async function ensureEvolutionDir(stateDir: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
}

/** 從 JSONL 讀取並快取所有 Nuwa 模式 */
async function loadPatterns(logger?: { debug?: (msg: string) => void }): Promise<NuwaPattern[]> {
  if (!evolutionStateDir) return [];
  const now = Date.now();
  if (patternsCache.length > 0 && now - patternsCacheAt < CACHE_TTL_MS) {
    return patternsCache;
  }
  const patternsPath = path.join(evolutionStateDir, "patterns.jsonl");
  const content = await safeReadFile(patternsPath);
  if (!content) return [];

  const patterns: NuwaPattern[] = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as NuwaPattern;
      if (obj.category === "nuwa" || obj.category === "distilled") {
        patterns.push(obj);
      }
    } catch {
      // 跳過格式錯誤的行
    }
  }
  patternsCache = patterns;
  patternsCacheAt = now;
  logger?.debug?.(`[evolution-learning] 載入 ${patterns.length} 個女媧模式`);
  return patterns;
}

/** 讀取並快取細胞登記表 */
async function loadRegistry(): Promise<CellRegistry | null> {
  if (!evolutionStateDir) return null;
  const now = Date.now();
  if (registryCache && now - registryCacheAt < CACHE_TTL_MS) {
    return registryCache;
  }
  const registryPath = path.join(evolutionStateDir, "cell-registry.json");
  const content = await safeReadFile(registryPath);
  if (!content) return null;
  try {
    registryCache = JSON.parse(content) as CellRegistry;
    registryCacheAt = now;
    return registryCache;
  } catch {
    return null;
  }
}

/** 使快取失效，強制下次重新讀取 */
function invalidateCache(): void {
  patternsCacheAt = 0;
  registryCacheAt = 0;
  softLinksCacheAt = 0;
}

// ═══════════════════════════════════════════════════════════════════
// 軟連線模組：神經元模組 × 動態權重 × 跨 pattern 連結
// ═══════════════════════════════════════════════════════════════════

/** 載入或初始化軟連線矩陣 */
async function loadSoftLinks(): Promise<SoftLinks> {
  const empty: SoftLinks = { version: 1, links: {}, lastUpdated: new Date().toISOString() };
  if (!evolutionStateDir) return empty;
  const now = Date.now();
  if (softLinksCache && now - softLinksCacheAt < CACHE_TTL_MS) return softLinksCache;
  const content = await safeReadFile(path.join(evolutionStateDir, "soft-links.json"));
  if (!content) return empty;
  try {
    softLinksCache = JSON.parse(content) as SoftLinks;
    softLinksCacheAt = now;
    return softLinksCache;
  } catch {
    return empty;
  }
}

/** 持久化軟連線矩陣 */
async function saveSoftLinks(sl: SoftLinks): Promise<void> {
  if (!evolutionStateDir) return;
  sl.lastUpdated = new Date().toISOString();
  softLinksCache = sl;
  softLinksCacheAt = Date.now();
  await safeWriteFile(path.join(evolutionStateDir, "soft-links.json"), JSON.stringify(sl, null, 2));
}

/**
 * 記錄 A、B 兩個 pattern 的共激活事件，雙向增強連線權重。
 * 在同一 SOFT_LINK_WINDOW_MS 視窗內多次共激活 → 連線越強。
 */
async function recordCoActivation(patternIdA: string, patternIdB: string): Promise<void> {
  if (patternIdA === patternIdB) return;
  const sl = await loadSoftLinks();
  for (const [from, to] of [
    [patternIdA, patternIdB],
    [patternIdB, patternIdA],
  ]) {
    if (!sl.links[from]) sl.links[from] = {};
    sl.links[from][to] = Math.min(
      SOFT_LINK_MAX_WEIGHT,
      (sl.links[from][to] ?? 0) + SOFT_LINK_INCREMENT,
    );
  }
  await saveSoftLinks(sl);
}

/**
 * 計算某個 candidate pattern 因軟連線而獲得的信心度加成。
 * 若 candidate 與最近視窗內激活過的任意 pattern 有足夠強的連線 → 給加成。
 */
function getSoftBoost(candidateId: string, sl: SoftLinks, recentIds: string[]): number {
  if (recentIds.length === 0) return 0;
  const links = sl.links[candidateId] ?? {};
  const maxWeight = Math.max(0, ...recentIds.map((id) => links[id] ?? 0));
  return maxWeight >= SOFT_LINK_THRESHOLD ? SOFT_LINK_BOOST : 0;
}

/**
 * 軟連線熱啟動：根據 patterns 的 keywords / mentalModels 重疊程度，
 * 為語義相近的 pattern 對預植底線連線強度（WARM_SEED_WEIGHT）。
 *
 * 原則：
 * - 只填入 < WARM_SEED_WEIGHT 的空槽，不覆蓋真實共激活資料
 * - 一次 real co-activation (+0.05) 就能蓋過底線，真實行為永遠優先
 * - 在 service start 與 REM 週期末各執行一次（確保新蒸餾的 pattern 也被播種）
 */
async function warmStartSoftLinks(
  stateDir: string,
  patterns: NuwaPattern[],
  logger?: { info?: (m: string) => void },
): Promise<number> {
  if (patterns.length < 2) return 0;

  const sl = await loadSoftLinks();
  let seeded = 0;

  for (let i = 0; i < patterns.length; i++) {
    for (let j = i + 1; j < patterns.length; j++) {
      const a = patterns[i];
      const b = patterns[j];

      // 關鍵字重疊（不區分大小寫，部分包含也算）
      const aKw = a.keywords.map((k) => k.toLowerCase());
      const bKw = new Set(b.keywords.map((k) => k.toLowerCase()));
      const kwOverlap = aKw.filter((k) => {
        if (bKw.has(k)) return true;
        // 部分包含：aKw 中某詞含在 bKw 的某詞中（反之亦然）
        for (const bk of bKw) {
          if (k.includes(bk) || bk.includes(k)) return true;
        }
        return false;
      }).length;

      // 心智模型重疊
      const aMm = a.mentalModels.map((m) => m.toLowerCase());
      const bMm = new Set(b.mentalModels.map((m) => m.toLowerCase()));
      const mmOverlap = aMm.filter((m) => {
        if (bMm.has(m)) return true;
        for (const bm of bMm) {
          if (m.includes(bm) || bm.includes(m)) return true;
        }
        return false;
      }).length;

      if (kwOverlap + mmOverlap < WARM_SEED_MIN_OVERLAP) continue;

      // 雙向播種底線，不破壞已有真實資料
      if (!sl.links[a.id]) sl.links[a.id] = {};
      if (!sl.links[b.id]) sl.links[b.id] = {};

      if ((sl.links[a.id][b.id] ?? 0) < WARM_SEED_WEIGHT) {
        sl.links[a.id][b.id] = WARM_SEED_WEIGHT;
        seeded++;
      }
      if ((sl.links[b.id][a.id] ?? 0) < WARM_SEED_WEIGHT) {
        sl.links[b.id][a.id] = WARM_SEED_WEIGHT;
      }
    }
  }

  if (seeded > 0) {
    await saveSoftLinks(sl);
    logger?.info?.(
      `[evolution-learning] 🔗 軟連線熱啟動：植入 ${seeded} 條語義底線連線（底線強度 ${(WARM_SEED_WEIGHT * 100).toFixed(0)}%）`,
    );
  }
  return seeded;
}

// ─── 第一層：偵測訊息是否包含人物框架需求 ─────────────────────────
// 新架構：從 pattern.keywords 動態讀取觸發條件，不再依賴硬編碼常數表
// 每個 NuwaPattern 帶有自己的 keywords 欄位，完全解耦

type MatchResult = {
  pattern: NuwaPattern;
  confidence: number;
  matchedKeywords: string[];
  taskType: TaskType; // 第二層：任務類型（新增）
};

function detectPersonaIntent(
  prompt: string,
  patterns: NuwaPattern[],
  threshold: number,
  softBoostMap?: Record<string, number>, // patternId → 軟連線信心度加成
): MatchResult | null {
  const lowerPrompt = prompt.toLowerCase();
  const taskType = classifyTask(prompt); // 第二層神經路由（原 TASK_KEYWORDS 死程式碼的真正實作）

  // ── 新架構：從 pattern.keywords 直接匹配（含軟連線加成）──────
  // 每個 pattern 自帶 keywords 欄位，無需硬編碼映射表
  // softBoostMap 來自最近激活視窗的共激活權重（軟連線模組）
  for (const p of patterns) {
    const softBoost = softBoostMap?.[p.id] ?? 0;
    const effectiveConfidence = p.confidence + softBoost;
    if (effectiveConfidence < threshold) continue;
    const patternKeywords = Array.isArray((p as Record<string, unknown>)["keywords"])
      ? ((p as Record<string, unknown>)["keywords"] as string[])
      : [];
    // 合併：pattern.keywords + target 名稱 + slug（多語言覆蓋）
    const allTriggers = [
      ...patternKeywords,
      p.target.toLowerCase(),
      p.slug.replace(/-/g, " "),
      p.slug.replace(/-/g, ""),
    ];
    const matched = allTriggers.filter((kw) => kw && lowerPrompt.includes(kw.toLowerCase()));
    if (matched.length > 0) {
      return { pattern: p, confidence: effectiveConfidence, matchedKeywords: matched, taskType };
    }
  }

  // ── 泛化匹配：「用 X 的方式」、「X 會怎麼看」──────────────────
  const usageRegexes = [
    /用(.{1,15})的方式/,
    /(.{1,15})會怎麼(看|想|分析|評估)/,
    /(.{1,15})的(思維|框架|觀點|角度)/,
    /以(.{1,15})(來|的)/,
    /apply (.{1,30}) (thinking|framework|approach)/i,
    /how would (.{1,30}) (think|approach|analyze)/i,
  ];

  for (const re of usageRegexes) {
    const match = re.exec(prompt);
    if (!match) continue;
    const namePart = (match[1] ?? "").trim().toLowerCase();
    for (const p of patterns) {
      const softBoost = softBoostMap?.[p.id] ?? 0;
      if (p.confidence + softBoost < threshold) continue;
      if (
        namePart.includes(p.slug.replace(/-/g, " ")) ||
        p.target.toLowerCase().includes(namePart)
      ) {
        return {
          pattern: p,
          confidence: p.confidence + softBoost,
          matchedKeywords: [namePart],
          taskType,
        };
      }
    }
  }

  return null;
}

// ─── 第一層：建構注入上下文 ────────────────────────────────────

function buildPersonaContext(
  pattern: NuwaPattern,
  maxTokens: number,
  l3SkillContent?: string, // L3 技能文件內容（installed 狀態時注入）
  taskType?: TaskType, // 第二層神經路由 — 調整強調重點
): string {
  const MAX_MODELS = Math.min(pattern.mentalModels.length, 5);
  const models = pattern.mentalModels.slice(0, MAX_MODELS);

  // 第二層路由：根據任務類型調整框架啟動訊息
  const taskHint = taskType && taskType !== "general" ? `（任務類型：${taskType}）` : "";

  let ctx = `🏺 女媧框架啟動：${pattern.target}${taskHint}\n`;
  ctx += `核心心智模型：\n`;
  for (const model of models) {
    ctx += `• ${model}\n`;
  }

  // L3 技能文件補充（installed 後才注入，控制 token 預算）
  if (l3SkillContent) {
    const skillBudget = Math.floor(maxTokens * 0.4); // 最多用 40% token 給技能文件
    const trimmed = l3SkillContent.slice(0, skillBudget * 1.5);
    ctx += `\n📚 技能補充：\n${trimmed}\n`;
  }

  ctx += `\n請以 ${pattern.target} 的思維框架回應，尤其善用上述心智模型。`;

  const approxChars = maxTokens * 1.5;
  if (ctx.length > approxChars) {
    ctx = ctx.slice(0, approxChars) + "...";
  }
  return ctx;
}

// ─── 第三層：REM 週期 — 更新成熟度分數 ────────────────────────

async function runRemCycle(
  stateDir: string,
  maturityThreshold: number,
  pluginConfig?: PluginConfig,
  logger?: { info?: (msg: string) => void; warn?: (msg: string) => void },
): Promise<void> {
  const registryPath = path.join(stateDir, "cell-registry.json");
  const metricsPath = path.join(stateDir, "growth-metrics.json");

  // ── 代謝 + L2 生長 + 循環回流：與 registry 無關，必須先跑 ─────
  // 代謝：閒置 pattern 信心度衰減
  // L2 生長：從正向因果鏈萃取新心智模型
  // 循環回流：從 L4 因果鏈反饋強化軟連線（貫穿式增長）
  const decayedEarly = await runMetabolism(stateDir, logger);
  const grownEarly = await growL2FromCausalChain(stateDir, logger);
  const currentPatterns = await loadPatterns();
  const fedbackEarly = await runCirculatoryFeedback(stateDir, currentPatterns, logger);
  const hermesSynced = evolutionWorkspaceDir
    ? await syncHermesToEvolution(stateDir, evolutionWorkspaceDir, currentPatterns, logger)
    : 0;

  // ── 自動蒸餾：高頻未匹配主題 → 自動生成 pattern ──────────────────
  const autoDistilled =
    pluginConfig?.autoDistillEnabled !== false
      ? await checkAndAutoDistill(
          stateDir,
          pluginConfig?.autoDistillThreshold ?? AUTO_DISTILL_THRESHOLD_DEFAULT,
          pluginConfig?.tavilyApiKey,
          logger,
        )
      : 0;
  // 軟連線熱啟動：在 auto-distill 之後執行，確保本輪新生成的 pattern 也被播種
  const latestPatterns = autoDistilled > 0 ? await loadPatterns() : currentPatterns;
  const warmSeeded = await warmStartSoftLinks(stateDir, latestPatterns, logger);

  let changed =
    decayedEarly > 0 ||
    grownEarly > 0 ||
    fedbackEarly > 0 ||
    hermesSynced > 0 ||
    autoDistilled > 0 ||
    warmSeeded > 0;

  const [registryContent, metricsContent] = await Promise.all([
    safeReadFile(registryPath),
    safeReadFile(metricsPath),
  ]);

  // 如果沒有 registry，只做代謝/生長/自動進化就結束
  if (!registryContent) {
    const emptyRegistry: CellRegistry = { version: 1, cells: {}, stemCells: [] };
    const newEmbryosEarly = await analyzeUnmatchedAndCreateEmbryos(stateDir, emptyRegistry);
    if (newEmbryosEarly > 0) {
      logger?.info?.(
        `[evolution-learning] 🧬 自動進化：建立 ${newEmbryosEarly} 個新胚胎（含 DNA 遺傳）`,
      );
      const registryPath = path.join(stateDir, "cell-registry.json");
      await safeWriteFile(registryPath, JSON.stringify(emptyRegistry, null, 2));
      invalidateCache();
    } else if (changed) {
      invalidateCache();
    }
    return;
  }

  let registry: CellRegistry;
  let metrics: GrowthMetrics;

  try {
    registry = JSON.parse(registryContent) as CellRegistry;
  } catch {
    return;
  }

  try {
    metrics = metricsContent
      ? (JSON.parse(metricsContent) as GrowthMetrics)
      : { version: 1, lastUpdated: new Date().toISOString(), embryos: [] };
  } catch {
    metrics = { version: 1, lastUpdated: new Date().toISOString(), embryos: [] };
  }

  // changed 已在上方宣告，此處重置為 false 重新計算 registry 變化
  changed = false;

  for (const cell of registry.stemCells) {
    if (cell.status === "installed") continue;

    // 計算新成熟度：基於使用次數和正向評分
    const usageBonus = Math.min(cell.usageCount * 0.05, 0.3);
    const ratingBonus = cell.usageCount > 0 ? (cell.positiveRating / cell.usageCount) * 0.3 : 0;
    const newScore = Math.min(0.1 + usageBonus + ratingBonus, 1.0);

    // EMA 平滑更新
    const prevScore = cell.maturityScore;
    cell.maturityScore = EMA_ALPHA * newScore + (1 - EMA_ALPHA) * prevScore;
    cell.lastEvaluated = new Date().toISOString();

    // 狀態機轉換
    if (cell.status === "embryo" && cell.maturityScore >= 0.3) {
      cell.status = "incubating";
      logger?.info?.(
        `[evolution-learning] 🐣 ${cell.target} 進入孵化期（成熟度 ${cell.maturityScore.toFixed(2)}）`,
      );
      changed = true;
    } else if (cell.status === "incubating" && cell.maturityScore >= 0.6) {
      cell.status = "ready";
      logger?.info?.(
        `[evolution-learning] ✅ ${cell.target} 已就緒（成熟度 ${cell.maturityScore.toFixed(2)}）`,
      );
      changed = true;
    } else if (cell.status === "ready" && cell.maturityScore >= maturityThreshold) {
      cell.status = "installed";
      logger?.info?.(`[evolution-learning] 🌟 ${cell.target} 晉升為常駐細胞！`);
      if (evolutionWorkspaceDir) {
        void writeHermesPromotionAudit(evolutionWorkspaceDir, cell);
        // 自動孵化 Agent：生成技能文件 + 合併 openclaw.json
        void autoHatchAgent(cell, stateDir, evolutionWorkspaceDir, logger);
      }
      changed = true;
    }

    if (Math.abs(cell.maturityScore - prevScore) > 0.001) {
      changed = true;
    }

    // 更新 metrics 中的對應胚胎記錄
    const embryo = metrics.embryos.find((e) => e.id === cell.id);
    if (embryo) {
      embryo.maturityScore = cell.maturityScore;
      embryo.status = cell.status;
      embryo.nextEvaluation = "next-rem-cycle";
    }
  }

  // ── 自動進化：分析未匹配查詢，建立新胚胎（含 DNA 遺傳）──────────
  const newEmbryos = await analyzeUnmatchedAndCreateEmbryos(stateDir, registry);
  if (newEmbryos > 0) {
    changed = true;
    logger?.info?.(`[evolution-learning] 🧬 自動進化：建立 ${newEmbryos} 個新胚胎（含 DNA 遺傳）`);
  }

  if (changed) {
    metrics.lastUpdated = new Date().toISOString();
    await Promise.all([
      safeWriteFile(registryPath, JSON.stringify(registry, null, 2)),
      safeWriteFile(metricsPath, JSON.stringify(metrics, null, 2)),
    ]);
    invalidateCache();
    logger?.info?.(
      `[evolution-learning] REM 週期完成 — 細胞=${registry.stemCells.length} 代謝=${decayedEarly} L2生長=${grownEarly} Hermes=${hermesSynced} 自動蒸餾=${autoDistilled} 熱啟動=${warmSeeded}`,
    );
  }
}

// ─── 第一層：更新模式的使用記錄（EMA 更新信心度）──────────────────

async function recordPatternUsage(
  patternId: string,
  success: boolean,
  logger?: { debug?: (msg: string) => void },
): Promise<void> {
  if (!evolutionStateDir) return;
  const patternsPath = path.join(evolutionStateDir, "patterns.jsonl");
  const content = await safeReadFile(patternsPath);
  if (!content) return;

  const lines = content.split("\n");
  const updatedLines: string[] = [];
  let found = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      updatedLines.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as NuwaPattern;
      if (obj.id === patternId) {
        found = true;
        obj.sampleCount = (obj.sampleCount ?? 0) + 1;
        obj.lastUsed = new Date().toISOString();
        // EMA 更新成功率
        const reward = success ? 1.0 : 0.0;
        obj.successRate = EMA_ALPHA * reward + (1 - EMA_ALPHA) * (obj.successRate ?? 0);
        // EMA 更新信心度（成功率高時信心度上升）
        // 注意：不設下限，讓自糾修復能真正降到 DEMOTE_CONFIDENCE_THRESHOLD (0.45) 以下
        // frozen pattern 除外（frozen=true 的模式不被負向信號降低）
        if (!(obj as unknown as { frozen?: boolean }).frozen || reward > 0) {
          obj.confidence = EMA_ALPHA * obj.successRate + (1 - EMA_ALPHA) * obj.confidence;
        }
        updatedLines.push(JSON.stringify(obj));
      } else {
        updatedLines.push(line);
      }
    } catch {
      updatedLines.push(line);
    }
  }

  if (found) {
    await safeWriteFile(patternsPath, updatedLines.join("\n"));
    invalidateCache();
    logger?.debug?.(`[evolution-learning] 已更新模式 ${patternId} 的使用記錄`);
  }
}

/** 同時更新幹細胞的使用次數 */
async function recordStemCellUsage(slug: string, positive: boolean): Promise<void> {
  if (!evolutionStateDir) return;
  const registryPath = path.join(evolutionStateDir, "cell-registry.json");
  const content = await safeReadFile(registryPath);
  if (!content) return;
  try {
    const registry = JSON.parse(content) as CellRegistry;
    const cell = registry.stemCells.find((c) => c.slug === slug);
    if (cell) {
      cell.usageCount = (cell.usageCount ?? 0) + 1;
      if (positive) {
        cell.positiveRating = (cell.positiveRating ?? 0) + 1;
      }
      await safeWriteFile(registryPath, JSON.stringify(registry, null, 2));
      invalidateCache();
    }
  } catch {
    // 靜默失敗
  }
}

// ─── 進化洞察工具（提供給 Agent 查詢） ─────────────────────────

const InsightsSchema = Type.Object({
  query: Type.Union(
    [
      Type.Literal("status"),
      Type.Literal("patterns"),
      Type.Literal("cells"),
      Type.Literal("top"),
      Type.Literal("unmatched"),
      Type.Literal("causal"),
      Type.Literal("metabolism"),
      Type.Literal("links"),
    ],
    {
      description:
        "查詢類型：status=整體狀態, patterns=所有模式, cells=幹細胞池, top=最常使用的人物, unmatched=未匹配查詢, causal=L4因果鏈, metabolism=代謝狀態, links=軟連線矩陣（神經元模組）",
    },
  ),
});

function buildInsightsTool(): AnyAgentTool {
  // cast 到 unknown 再到 AnyAgentTool，因為 pi-agent-core 的 execute 簽名
  // 包含 this:void + onUpdate 參數，但實際使用時只需要前三個參數
  return {
    name: "evolution_insights",
    description:
      "查詢女媧進化學習系統的狀態。可查看已蒸餾人物的成熟度、使用統計、以及整體進化狀態。",
    parameters: InsightsSchema,
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
      _signal?: AbortSignal,
    ): Promise<AgentToolResult<null>> => {
      const { query } = rawParams as { query: string };
      const patterns = await loadPatterns();
      const registry = await loadRegistry();

      if (query === "status") {
        const installedCount =
          registry?.stemCells.filter((c) => c.status === "installed").length ?? 0;
        const readyCount = registry?.stemCells.filter((c) => c.status === "ready").length ?? 0;
        const incubatingCount =
          registry?.stemCells.filter((c) => c.status === "incubating").length ?? 0;
        const embryoCount = registry?.stemCells.filter((c) => c.status === "embryo").length ?? 0;
        const text = [
          `🏺 女媧 × 四層進化系統狀態`,
          ``,
          `第一層（學習模式庫）：${patterns.length} 個女媧模式`,
          `第四層（有機細胞）  ：${installedCount} 個常駐細胞 / ${readyCount} 個就緒 / ${incubatingCount} 個孵化中 / ${embryoCount} 個胚胎`,
          ``,
          `狀態說明：`,
          `🥚 胚胎 → 🐣 孵化中 → ✅ 就緒 → 🌟 常駐（成熟度門檻 ${DEFAULT_MATURITY_THRESHOLD}）`,
        ].join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      if (query === "patterns") {
        const text =
          patterns.length === 0
            ? "📭 尚未有蒸餾模式。請先執行 scripts/nuwa/distill.py。"
            : `🧠 已知女媧模式（${patterns.length} 個）：\n` +
              patterns
                .map(
                  (p) =>
                    `• ${p.target}（信心度 ${(p.confidence * 100).toFixed(0)}%，使用 ${p.sampleCount} 次）`,
                )
                .join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      if (query === "cells") {
        const cells = registry?.stemCells ?? [];
        const icons: Record<string, string> = {
          embryo: "🥚",
          incubating: "🐣",
          ready: "✅",
          installed: "🌟",
        };
        const text =
          cells.length === 0
            ? "📭 幹細胞池為空。"
            : `🧬 幹細胞池（${cells.length} 個）：\n` +
              cells
                .map(
                  (c) =>
                    `${icons[c.status] ?? "❓"} ${c.target.padEnd(15)} 成熟度 ${(c.maturityScore * 100).toFixed(0)}%  使用 ${c.usageCount} 次`,
                )
                .join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      if (query === "top") {
        const sorted = [...patterns].sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 5);
        const text =
          sorted.length === 0
            ? "📭 尚無使用記錄。"
            : `🏆 最常使用的人物框架：\n` +
              sorted
                .map(
                  (p, i) =>
                    `${i + 1}. ${p.target}（使用 ${p.sampleCount} 次，成功率 ${(p.successRate * 100).toFixed(0)}%）`,
                )
                .join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      if (query === "causal") {
        const filePath = evolutionStateDir
          ? path.join(evolutionStateDir, "causal-chain.jsonl")
          : null;
        const content = filePath ? await safeReadFile(filePath) : null;
        const lines = (content ?? "").split("\n").filter((l) => l.trim());
        const text =
          lines.length === 0
            ? "📭 尚無因果鏈記錄（L4 Strategic Memory）。需要先有幾輪 Gate 2 通過的對話。"
            : `🔗 L4 因果鏈（最後 5 筆）：\n` +
              lines
                .slice(-5)
                .map((l) => {
                  try {
                    const e = JSON.parse(l) as CausalChainEntry;
                    return `• [${e.result}] ${e.target} | ${e.context.slice(0, 40)}… → ${e.recommendation}`;
                  } catch {
                    return "• [解析錯誤]";
                  }
                })
                .join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      if (query === "metabolism") {
        const now = Date.now();
        const lines = patterns.map((p) => {
          const lastActive = p.lastUsed
            ? new Date(p.lastUsed).getTime()
            : new Date(p.createdAt).getTime();
          const days = Math.floor((now - lastActive) / 86_400_000);
          const idle = days > METABOLISM_IDLE_DAYS;
          return `${idle ? "⚠️ " : "✅"} ${p.target.padEnd(20)} 閒置 ${days} 天  信心 ${(p.confidence * 100).toFixed(0)}%${p.frozen ? "  🔒凍結" : ""}`;
        });
        const text =
          patterns.length === 0
            ? "📭 尚無 pattern 資料。"
            : `🧬 代謝狀態（閒置 >${METABOLISM_IDLE_DAYS} 天開始衰減）：\n` + lines.join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      if (query === "links") {
        const sl = await loadSoftLinks();
        const entries = Object.entries(sl.links);
        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "📭 尚無軟連線記錄。需要多個 pattern 在同一對話視窗內先後激活。",
              },
            ],
            details: null,
          };
        }
        const lines: string[] = [];
        for (const [fromId, targets] of entries) {
          const fromPat = patterns.find((p) => p.id === fromId);
          const fromName = fromPat?.target ?? fromId.slice(0, 8);
          for (const [toId, weight] of Object.entries(targets)) {
            const toPat = patterns.find((p) => p.id === toId);
            const toName = toPat?.target ?? toId.slice(0, 8);
            lines.push(`  ${fromName} ←→ ${toName}  強度 ${(weight * 100).toFixed(0)}%`);
          }
        }
        const unique = [...new Set(lines)].slice(0, 20);
        return {
          content: [
            { type: "text" as const, text: `🔗 軟連線矩陣（神經元模組）：\n${unique.join("\n")}` },
          ],
          details: null,
        };
      }

      if (query === "unmatched") {
        const filePath = evolutionStateDir
          ? path.join(evolutionStateDir, "unmatched-queries.jsonl")
          : null;
        const content = filePath ? await safeReadFile(filePath) : null;
        const lines = (content ?? "").split("\n").filter((l) => l.trim());
        const text =
          lines.length === 0
            ? "📭 目前沒有未匹配的查詢記錄。"
            : `🔍 未匹配查詢（${lines.length} 筆，等待 REM 週期自動建立胚胎）：\n` +
              lines
                .slice(-5)
                .map((l) => {
                  try {
                    return `• ${(JSON.parse(l) as UnmatchedQuery).prompt.slice(0, 60)}`;
                  } catch {
                    return "• [解析錯誤]";
                  }
                })
                .join("\n");
        return { content: [{ type: "text" as const, text }], details: null };
      }

      return {
        content: [{ type: "text" as const, text: `未知查詢類型：${query}` }],
        details: null,
      };
    },
  } as unknown as AnyAgentTool;
}

// ─── L4 Strategic Memory：因果鏈記錄 ──────────────────────────────
// 研究框架中的 Strategic Memory = context→method→result→cause→recommendation

type CausalChainEntry = {
  timestamp: string;
  patternId: string;
  target: string; // 人物名稱
  context: string; // 原始 prompt 截斷（觸發情境）
  method: string; // 使用的框架/心智模型列表
  result: QualitySignal; // positive / negative / neutral
  cause: string; // 推斷的原因（簡易版：訊號來源描述）
  recommendation: string; // 下次應怎做（簡易版）
};

async function appendCausalChain(
  stateDir: string,
  entry: Omit<CausalChainEntry, "timestamp">,
): Promise<void> {
  const filePath = path.join(stateDir, "causal-chain.jsonl");
  const record: CausalChainEntry = { timestamp: new Date().toISOString(), ...entry };
  try {
    await fs.appendFile(filePath, JSON.stringify(record) + "\n", "utf8");
  } catch {
    /* silent */
  }
}

// ═══════════════════════════════════════════════════════════════════
// 代謝（Metabolism）— 時間衰減，閒置的 pattern 自動降信心度
// ═══════════════════════════════════════════════════════════════════

/**
 * 對所有非 frozen 的 pattern 做時間衰減：
 * 超過 METABOLISM_IDLE_DAYS 天未使用 → 每多閒置 1 天降 METABOLISM_DECAY_PER_DAY 的信心度
 * 下限 METABOLISM_MIN_CONFIDENCE（不讓 pattern 完全死亡，只是弱化）
 */
async function runMetabolism(
  stateDir: string,
  logger?: { info?: (m: string) => void },
): Promise<number> {
  const patternsPath = path.join(stateDir, "patterns.jsonl");
  const content = await safeReadFile(patternsPath);
  if (!content) return 0;

  const now = Date.now();
  const lines = content.split("\n");
  const updatedLines: string[] = [];
  let decayCount = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      updatedLines.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as NuwaPattern;

      // frozen pattern 免疫代謝衰減
      if (obj.frozen) {
        updatedLines.push(JSON.stringify(obj));
        continue;
      }

      // 取最後一次活躍時間（lastUsed 優先，否則用 createdAt）
      const lastActiveTs = obj.lastUsed
        ? new Date(obj.lastUsed).getTime()
        : new Date(obj.createdAt).getTime();
      const daysSinceActive = (now - lastActiveTs) / 86_400_000; // ms → days

      if (daysSinceActive > METABOLISM_IDLE_DAYS) {
        const idleDays = daysSinceActive - METABOLISM_IDLE_DAYS;
        // 線性衰減：閒置 50 天 → 降低 50 * 0.02 = 1.0（也就是降到下限）
        const decayAmount = idleDays * METABOLISM_DECAY_PER_DAY;
        const newConf = Math.max(METABOLISM_MIN_CONFIDENCE, obj.confidence - decayAmount);
        if (newConf < obj.confidence - 0.001) {
          obj.confidence = newConf;
          decayCount++;
        }
      }
      updatedLines.push(JSON.stringify(obj));
    } catch {
      updatedLines.push(line);
    }
  }

  if (decayCount > 0) {
    await safeWriteFile(patternsPath, updatedLines.join("\n"));
    invalidateCache();
    logger?.info?.(`[evolution-learning] 🧬 代謝：${decayCount} 個閒置 pattern 信心度衰減`);
  }

  return decayCount;
}

// ═══════════════════════════════════════════════════════════════════
// DNA 遺傳輔助 — 計算 topic 與已有 pattern 的相似度
// ═══════════════════════════════════════════════════════════════════

/**
 * 用字元 bigram Jaccard + 關鍵字覆蓋 + 同類型加成計算相似度
 * 範圍 [0, 1]，越高越相似
 *
 * 同類型加成（0.15）：
 * 新 embryo 幾乎都是 persona/distilled 類型，若親代也是同類型
 * 則賦予基礎加成，讓短名稱（如「Munger」）也能繼承到最相近的親代。
 */
function computePatternSimilarity(topic: string, pattern: NuwaPattern): number {
  const topicL = topic.toLowerCase();
  const targetL = pattern.target.toLowerCase();
  const keywords = (pattern.keywords ?? []).map((k) => k.toLowerCase());

  // 關鍵字直接命中 → 高分
  if (keywords.some((k) => topicL.includes(k) || k.includes(topicL))) return 0.85;
  if (topicL.includes(targetL) || targetL.includes(topicL)) return 0.75;

  // 字元 bigram Jaccard
  const bigrams = (s: string) =>
    new Set(Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2)));
  const tBig = bigrams(topicL);
  const pBig = bigrams(targetL);
  let jaccard = 0;
  if (tBig.size > 0 && pBig.size > 0) {
    const inter = [...tBig].filter((b) => pBig.has(b)).length;
    const union = new Set([...tBig, ...pBig]).size;
    jaccard = inter / union;
  }

  // 同類型加成：persona/distilled 親代給 embryo 一個基礎繼承可能性
  // 讓語音/拼寫完全不同的人物（如 Munger vs Buffett）仍能繼承知識框架
  const sameCategory = pattern.category === "distilled" || pattern.type === "persona" ? 0.15 : 0;

  return Math.min(1.0, jaccard + sameCategory);
}

// ═══════════════════════════════════════════════════════════════════
// L2 REM 生長 — 從 causal-chain 的正向記錄萃取新心智模型
// ═══════════════════════════════════════════════════════════════════

/**
 * 掃描 causal-chain.jsonl 的正向記錄：
 * 若某個詞彙在同一 pattern 的 3+ 個正向 context 中出現
 * → 視為「有效的認知框架關鍵詞」，新增為 mentalModel
 *
 * 這是「運行即學習」最核心的實現：
 * 好的對話 → 記錄因果鏈 → REM 週期抽取 → 能力本身增長
 */
async function growL2FromCausalChain(
  stateDir: string,
  logger?: { info?: (m: string) => void },
): Promise<number> {
  const causalPath = path.join(stateDir, "causal-chain.jsonl");
  const content = await safeReadFile(causalPath);
  if (!content) return 0;

  // 讀取所有正向因果鏈記錄
  const positive: CausalChainEntry[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as CausalChainEntry;
      if (e.result === "positive") positive.push(e);
    } catch {
      /* skip */
    }
  }
  if (positive.length === 0) return 0;

  // 按 patternId 分組，統計 context 中出現的詞彙頻率
  const phrasesByPattern: Record<string, Record<string, number>> = {};
  for (const e of positive) {
    if (!phrasesByPattern[e.patternId]) phrasesByPattern[e.patternId] = {};
    const freq = phrasesByPattern[e.patternId];
    // 提取中文 2-4 字詞 + 英文大寫詞組
    const cnWords = e.context.match(/[一-鿿]{2,4}/g) ?? [];
    const enPhrases = e.context.match(/[A-Z][a-zA-Z]{2,}(?:\s+[A-Z][a-zA-Z]{2,})*/g) ?? [];
    for (const w of [...cnWords, ...enPhrases]) {
      freq[w] = (freq[w] ?? 0) + 1;
    }
  }

  // 更新 patterns.jsonl
  const patternsPath = path.join(stateDir, "patterns.jsonl");
  const patternsContent = await safeReadFile(patternsPath);
  if (!patternsContent) return 0;

  const lines = patternsContent.split("\n");
  const updatedLines: string[] = [];
  let totalGrowth = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      updatedLines.push(line);
      continue;
    }
    try {
      const obj = JSON.parse(trimmed) as NuwaPattern;
      const freq = phrasesByPattern[obj.id];

      if (freq) {
        // 出現 L2_GROWTH_MIN_POSITIVE 次以上 + 尚未在 mentalModels 中
        const candidates = Object.entries(freq)
          .filter(
            ([phrase, count]) =>
              count >= L2_GROWTH_MIN_POSITIVE && !obj.mentalModels.some((m) => m.includes(phrase)),
          )
          .sort(([, a], [, b]) => b - a)
          .slice(0, L2_GROWTH_MAX_NEW_MODELS)
          .map(([phrase]) => `${phrase}框架`); // 格式化為心智模型名稱

        if (candidates.length > 0) {
          obj.mentalModels = [...obj.mentalModels, ...candidates].slice(0, L2_GROWTH_MAX_TOTAL);
          totalGrowth += candidates.length;
          logger?.info?.(
            `[evolution-learning] 🌱 L2 生長：${obj.target} 新增心智模型 ${candidates.join("、")}`,
          );
        }
      }
      updatedLines.push(JSON.stringify(obj));
    } catch {
      updatedLines.push(line);
    }
  }

  if (totalGrowth > 0) {
    await safeWriteFile(patternsPath, updatedLines.join("\n"));
    invalidateCache();
  }

  return totalGrowth;
}

// ═══════════════════════════════════════════════════════════════════
// 循環回流（Circulatory Feedback）— L4 Strategic Memory → L2 軟連線
// ═══════════════════════════════════════════════════════════════════
//
// 機制：每次 REM 週期掃描 causal-chain.jsonl 的正向記錄。
// 若 pattern A 的正向 context 中包含 pattern B 的關鍵字，
// 表示「A 成功時，B 的概念也出現了」→ 強化 A↔B 的軟連線。
//
// 這是真正的貫穿式增長：成功的對話記憶從 L4 流回 L2，
// 讓未來相關查詢能透過軟連線加成更早被正確 pattern 捕獲。

async function runCirculatoryFeedback(
  stateDir: string,
  patterns: NuwaPattern[],
  logger?: { info?: (m: string) => void },
): Promise<number> {
  const causalPath = path.join(stateDir, "causal-chain.jsonl");
  const content = await safeReadFile(causalPath);
  if (!content || patterns.length < 2) return 0;

  // 讀取所有正向因果鏈記錄
  const positiveEntries: CausalChainEntry[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const e = JSON.parse(t) as CausalChainEntry;
      if (e.result === "positive") positiveEntries.push(e);
    } catch {
      /* skip */
    }
  }
  if (positiveEntries.length === 0) return 0;

  const sl = await loadSoftLinks();
  let updates = 0;

  for (const entry of positiveEntries) {
    const sourcePattern = patterns.find((p) => p.id === entry.patternId);
    if (!sourcePattern) continue;

    const contextLower = entry.context.toLowerCase();

    // 找出 context 中出現了哪些其他 pattern 的關鍵字
    for (const other of patterns) {
      if (other.id === entry.patternId) continue;

      const otherKeywords = [
        ...(other.keywords ?? []),
        other.target.toLowerCase(),
        other.slug.replace(/-/g, " "),
      ];

      const hit = otherKeywords.some((kw) => kw && contextLower.includes(kw.toLowerCase()));
      if (!hit) continue;

      // 強化軟連線（L4 → L2 反饋）
      if (!sl.links[entry.patternId]) sl.links[entry.patternId] = {};
      if (!sl.links[other.id]) sl.links[other.id] = {};

      sl.links[entry.patternId][other.id] = Math.min(
        SOFT_LINK_MAX_WEIGHT,
        (sl.links[entry.patternId][other.id] ?? 0) + CIRCULATORY_KEYWORD_BOOST,
      );
      sl.links[other.id][entry.patternId] = Math.min(
        SOFT_LINK_MAX_WEIGHT,
        (sl.links[other.id][entry.patternId] ?? 0) + CIRCULATORY_KEYWORD_BOOST,
      );
      updates++;
    }
  }

  // 自然衰減：防止所有連線都堆積到上限，保持稀疏性
  for (const from of Object.keys(sl.links)) {
    for (const to of Object.keys(sl.links[from] ?? {})) {
      const w = sl.links[from][to];
      if (w > 0) {
        sl.links[from][to] = Math.max(0, w - SOFT_LINK_DECAY);
        if (sl.links[from][to] === 0) delete sl.links[from][to];
      }
    }
    if (Object.keys(sl.links[from] ?? {}).length === 0) delete sl.links[from];
  }

  if (updates > 0 || content.length > 0) {
    await saveSoftLinks(sl);
    if (updates > 0) {
      logger?.info?.(`[evolution-learning] 🔄 循環回流：強化 ${updates} 條軟連線（L4→L2）`);
    }
  }

  return updates;
}

// ═══════════════════════════════════════════════════════════════════
// Hermes 橋接：hermes-learning-state.json → L4 因果鏈（REM 週期同步）
// ═══════════════════════════════════════════════════════════════════

/**
 * Hermes 橋接：讀取 hermes-agent 的學習記錄，同步到 L4 因果鏈。
 * 用 watermark 避免重複匯入（只處理新記錄）。
 * 匹配邏輯：summary + tags 中出現 pattern 關鍵字 → 寫入對應 causal chain entry。
 */
async function syncHermesToEvolution(
  stateDir: string,
  workspaceDir: string,
  patterns: NuwaPattern[],
  logger?: { info?: (m: string) => void },
): Promise<number> {
  const hermesPath = path.join(workspaceDir, HERMES_LEARNING_RELATIVE_PATH);
  const hermesContent = await safeReadFile(hermesPath);
  if (!hermesContent) return 0;

  type HermesRecord = { trace_id: string; summary: string; created_at: string; tags: string[] };
  type HermesState = { success_patterns: HermesRecord[]; failure_patterns: HermesRecord[] };
  let hermesState: HermesState;
  try {
    hermesState = JSON.parse(hermesContent) as HermesState;
  } catch {
    return 0;
  }

  // 讀取 watermark（已匯入的 trace_id）
  const watermarkPath = path.join(stateDir, HERMES_WATERMARK_FILE);
  const watermarkContent = await safeReadFile(watermarkPath);
  const importedIds = new Set<string>(
    watermarkContent ? (JSON.parse(watermarkContent) as string[]) : [],
  );

  const allRecords: Array<HermesRecord & { result: QualitySignal }> = [
    ...(hermesState.success_patterns ?? []).map((r) => ({ ...r, result: "positive" as const })),
    ...(hermesState.failure_patterns ?? []).map((r) => ({ ...r, result: "negative" as const })),
  ].filter((r) => !importedIds.has(r.trace_id));

  if (allRecords.length === 0) return 0;

  let synced = 0;
  const newIds: string[] = [];

  for (const record of allRecords) {
    const summaryLower = record.summary.toLowerCase();
    const tagLower = record.tags.map((t) => t.toLowerCase());

    // 關鍵字匹配：找到對應的 pattern
    let matchedPattern: NuwaPattern | null = null;
    for (const p of patterns) {
      const triggers = [...(p.keywords ?? []), p.target.toLowerCase(), p.slug.replace(/-/g, " ")];
      if (
        triggers.some(
          (kw) =>
            kw &&
            (summaryLower.includes(kw.toLowerCase()) ||
              tagLower.some((t) => t.includes(kw.toLowerCase()))),
        )
      ) {
        matchedPattern = p;
        break;
      }
    }

    if (matchedPattern) {
      await appendCausalChain(stateDir, {
        patternId: matchedPattern.id,
        target: matchedPattern.target,
        context: `[Hermes] ${record.summary.slice(0, 180)}`,
        method: matchedPattern.mentalModels.slice(0, 3).join("；"),
        result: record.result,
        cause: `Hermes 任務記錄（trace: ${record.trace_id.slice(0, 8)}）`,
        recommendation:
          record.result === "positive"
            ? `繼續使用 ${matchedPattern.target} 框架於此類 Hermes 任務`
            : `檢視 ${matchedPattern.target} 框架在此 Hermes 任務類型的適用性`,
      });
      synced++;
    }

    newIds.push(record.trace_id);
  }

  if (newIds.length > 0) {
    const allIds = [...importedIds, ...newIds];
    await safeWriteFile(watermarkPath, JSON.stringify(allIds));
  }

  if (synced > 0) {
    logger?.info?.(`[evolution-learning] 🔗 Hermes 橋接：同步 ${synced} 筆任務記錄到 L4 因果鏈`);
  }
  return synced;
}

/**
 * 當幹細胞晉升為 installed，在 hermes 審計目錄留下記錄。
 * 不阻塞晉升流程（fire-and-forget），只做審計。
 */
async function writeHermesPromotionAudit(workspaceDir: string, cell: StemCell): Promise<void> {
  const auditDir = path.join(
    workspaceDir,
    "reports",
    "hermes-agent",
    "state",
    "evolution-promotions",
  );
  await fs.mkdir(auditDir, { recursive: true });
  const auditId = `evo-promote-${cell.slug}-${Date.now()}`;
  const record = {
    schema: "openclaw.hermes.evolution_promotion.v1",
    audit_id: auditId,
    created_at: new Date().toISOString(),
    status: "auto_promoted",
    requester: "evolution-learning",
    action: "promote_to_installed",
    cell: {
      id: cell.id,
      target: cell.target,
      slug: cell.slug,
      maturityScore: Number(cell.maturityScore.toFixed(3)),
      usageCount: cell.usageCount,
    },
    rollback_hint: `/evolution demote ${cell.slug}`,
  };
  void safeWriteFile(path.join(auditDir, `${auditId}.json`), JSON.stringify(record, null, 2));
}

// ─── 自動蒸餾輔助函式 ────────────────────────────────────────────

/** Tavily API 搜尋，回傳頁面摘要文字列表（逾時 6 秒自動放棄） */
async function searchTavily(query: string, apiKey: string): Promise<string[]> {
  try {
    const response = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, query, max_results: 5, search_depth: "basic" }),
      signal: AbortSignal.timeout(6000),
    });
    if (!response.ok) return [];
    const data = (await response.json()) as {
      results?: Array<{ content?: string; snippet?: string }>;
    };
    return (data.results ?? []).map((r) => r.content ?? r.snippet ?? "").filter(Boolean);
  } catch {
    return [];
  }
}

/** 從搜尋結果文字萃取觸發關鍵字（用於 pattern.keywords） */
function extractSearchKeywords(text: string, topic: string): string[] {
  if (!text) return [];
  const topicLower = topic.toLowerCase();
  const cnWords = text.match(/[一-鿿]{2,4}/g) ?? [];
  const enWords = (text.match(/[A-Z][a-zA-Z]{3,}/g) ?? []).map((w) => w.toLowerCase());
  const freq: Record<string, number> = {};
  for (const w of [...cnWords, ...enWords]) {
    if (w === topicLower || w.length < 2) continue;
    freq[w] = (freq[w] ?? 0) + 1;
  }
  return Object.entries(freq)
    .filter(([, c]) => c >= 2)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 8)
    .map(([w]) => w);
}

/** 從搜尋結果文字萃取心智模型名稱（用於 pattern.mentalModels） */
function extractSearchMentalModels(text: string, topic: string): string[] {
  if (!text) return [`${topic} 核心框架`, `${topic} 決策方法`];
  const cnPhrases = text.match(/[一-鿿]{2,8}(?:思維|框架|原則|方法|理論|模型|策略)/g) ?? [];
  const enPhrases =
    text.match(/[A-Z][a-zA-Z\s]{4,30}(?:Model|Principle|Framework|Theory|Thinking|Rule)/g) ?? [];
  const combined = [...new Set([...cnPhrases, ...enPhrases])].slice(0, 5);
  if (combined.length < 3) {
    combined.push(`${topic} 核心框架`, `${topic} 決策啟發式`);
  }
  return combined.slice(0, 7);
}

/**
 * 自動蒸餾單一主題：
 * 1. 若有 Tavily API key → 搜尋三個查詢取得真實資料
 * 2. 從資料萃取關鍵字和心智模型
 * 3. 寫入 patterns.jsonl（信心度高於胚胎）
 * 4. 不建立 stemCell（留給 analyzeUnmatchedAndCreateEmbryos 管理）
 */
async function autoDistillTopic(
  stateDir: string,
  topic: string,
  tavilyApiKey?: string,
  logger?: { info?: (m: string) => void },
): Promise<boolean> {
  const slug = topic
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9一-鿿-]/g, "");
  if (!slug) return false;

  const patternId = `${slug}-auto-distilled-v1`;

  // 確認尚未存在
  const patternsPath = path.join(stateDir, "patterns.jsonl");
  const existing = await safeReadFile(patternsPath);
  if (existing && existing.includes(`"id":"${patternId}"`)) return false;

  // 搜尋（若有 API key）
  let searchTexts: string[] = [];
  if (tavilyApiKey) {
    const queries = [
      `"${topic}" thinking framework mental models`,
      `"${topic}" decision making principles philosophy`,
      `"${topic}" key beliefs unique approach`,
    ].slice(0, AUTO_DISTILL_MAX_QUERIES);
    for (const q of queries) {
      const results = await searchTavily(q, tavilyApiKey);
      searchTexts.push(...results);
    }
  }

  const allText = searchTexts.join(" ");
  const keywords = extractSearchKeywords(allText, topic);
  const mentalModels = extractSearchMentalModels(allText, topic);

  const newPattern: NuwaPattern = {
    id: patternId,
    type: "persona",
    category: "distilled",
    target: topic,
    slug,
    confidence:
      searchTexts.length > 0 ? AUTO_DISTILLED_CONFIDENCE : AUTO_DISTILLED_HEURISTIC_CONFIDENCE,
    successRate: 0.0,
    sampleCount: 0,
    mentalModels,
    keywords: [topic.toLowerCase(), slug.replace(/-/g, " "), ...keywords],
    sourceCount: searchTexts.length,
    context: `自動蒸餾（${searchTexts.length > 0 ? `${searchTexts.length} 個網路來源` : "啟發式，無搜尋資料"}）`,
    skillPath: `skills/nuwa/examples/${slug}.md`,
    frozen: false,
    createdAt: new Date().toISOString(),
    lastUsed: null,
  };

  try {
    await fs.appendFile(patternsPath, JSON.stringify(newPattern) + "\n", "utf8");
    invalidateCache();
    logger?.info?.(
      `[evolution-learning] 🔬 自動蒸餾：${topic}（${searchTexts.length} 個來源，信心度 ${newPattern.confidence}）`,
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * REM 週期中執行：掃描高頻未匹配主題，觸發自動蒸餾。
 * 使用 distill-completed.json 作為 watermark 防止重複蒸餾。
 */
async function checkAndAutoDistill(
  stateDir: string,
  threshold: number,
  tavilyApiKey?: string,
  logger?: { info?: (m: string) => void },
): Promise<number> {
  const filePath = path.join(stateDir, "unmatched-queries.jsonl");
  const content = await safeReadFile(filePath);
  if (!content) return 0;

  const counts: Record<string, number> = {};
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const q = JSON.parse(t) as UnmatchedQuery;
      for (const hint of q.topicHints) {
        counts[hint] = (counts[hint] ?? 0) + 1;
      }
    } catch {
      continue;
    }
  }

  // 讀取已蒸餾清單
  const completedPath = path.join(stateDir, DISTILL_COMPLETED_FILE);
  const completedContent = await safeReadFile(completedPath);
  const completed = new Set<string>(
    completedContent ? (JSON.parse(completedContent) as string[]) : [],
  );

  // 載入現有 patterns slug 集合
  const patterns = await loadPatterns();
  const existingSlugs = new Set(patterns.map((p) => p.slug));

  const candidates = Object.entries(counts)
    .filter(([topic, count]) => {
      const slug = topic
        .toLowerCase()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9一-鿿-]/g, "");
      return count >= threshold && !completed.has(topic) && !existingSlugs.has(slug);
    })
    .sort(([, a], [, b]) => b - a)
    .slice(0, 2); // 每輪最多 2 個，避免一次搜尋太多

  if (candidates.length === 0) return 0;

  let distilled = 0;
  const newCompleted = [...completed];

  for (const [topic] of candidates) {
    const success = await autoDistillTopic(stateDir, topic, tavilyApiKey, logger);
    if (success) {
      distilled++;
      newCompleted.push(topic);
    }
  }

  if (distilled > 0) {
    await safeWriteFile(completedPath, JSON.stringify(newCompleted));
  }

  return distilled;
}

// ─── 自動進化：未匹配查詢追蹤 ────────────────────────────────────

type UnmatchedQuery = {
  timestamp: string;
  prompt: string;
  topicHints: string[];
};

function extractTopicHints(prompt: string): string[] {
  const hints: string[] = [];

  // ── 英文：優先提取多詞短語（"Paul Graham"），再提取單詞 ──────────
  // 舊：只提取單個大寫詞 → "Paul" + "Graham" 各計一次
  // 新：貪婪匹配連續大寫詞組 → "Paul Graham" 計為一個實體
  const enPhrases = prompt.match(/[A-Z][a-zA-Z]{1,}(?:\s+[A-Z][a-zA-Z]{1,})*/g) ?? [];
  // 去重：如果 "Paul Graham" 已加入，就不再單獨加 "Paul" 或 "Graham"
  const addedPhrases = new Set<string>();
  for (const phrase of enPhrases) {
    const words = phrase.split(/\s+/);
    // 優先加最長的短語
    if (!words.some((w) => addedPhrases.has(w))) {
      hints.push(phrase);
      for (const w of words) addedPhrases.add(w);
    }
  }

  // ── 中文：2-4 字詞（人名 / 概念）──────────────────────────────
  const cnWords = prompt.match(/[一-鿿]{2,4}/g) ?? [];
  hints.push(...cnWords.slice(0, 8));
  return [...new Set(hints)].slice(0, 10);
}

async function recordUnmatchedQuery(prompt: string): Promise<void> {
  if (!evolutionStateDir) return;
  const filePath = path.join(evolutionStateDir, "unmatched-queries.jsonl");
  const entry: UnmatchedQuery = {
    timestamp: new Date().toISOString(),
    prompt: prompt.slice(0, 200),
    topicHints: extractTopicHints(prompt),
  };
  try {
    await fs.appendFile(filePath, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* silent */
  }
}

async function analyzeUnmatchedAndCreateEmbryos(
  stateDir: string,
  registry: CellRegistry,
): Promise<number> {
  const filePath = path.join(stateDir, "unmatched-queries.jsonl");
  const content = await safeReadFile(filePath);
  if (!content) return 0;

  const queries: UnmatchedQuery[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      queries.push(JSON.parse(t) as UnmatchedQuery);
    } catch {
      /* skip */
    }
  }
  if (queries.length < 5) return 0;

  // Count topic hint frequencies
  const counts: Record<string, number> = {};
  for (const q of queries) {
    for (const hint of q.topicHints) {
      counts[hint] = (counts[hint] ?? 0) + 1;
    }
  }

  // Candidates: appear 5+ times
  const candidates = Object.entries(counts)
    .filter(([, c]) => c >= 5)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 3);

  if (candidates.length === 0) return 0;

  // DNA 遺傳：找最相似的現有 pattern 作為親代
  const existingPatterns = await loadPatterns();

  let created = 0;
  for (const [topic, freq] of candidates) {
    const slug = topic
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9一-鿿-]/g, "");
    if (!slug || registry.stemCells.some((c) => c.slug === slug || c.target === topic)) continue;

    // ── DNA 遺傳：找最相似的親代 pattern ──────────────────────────
    let bestParent: NuwaPattern | null = null;
    let bestScore = 0;
    for (const p of existingPatterns) {
      const score = computePatternSimilarity(topic, p);
      if (score > bestScore) {
        bestScore = score;
        bestParent = p;
      }
    }

    // 繼承親代的前 2 個心智模型（加上 [遺傳] 前綴標記來源）
    const inheritedModels: string[] =
      bestParent && bestScore >= DNA_INHERIT_THRESHOLD
        ? bestParent.mentalModels.slice(0, 2).map((m) => `${DNA_INHERIT_PREFIX} ${m}`)
        : [];

    // 同時在 patterns.jsonl 建立一個 embryo 模式（帶繼承的心智模型）
    const embryoPattern: NuwaPattern = {
      id: `${slug}-auto-v1`,
      type: "persona",
      category: "distilled",
      target: topic,
      slug,
      confidence: 0.4, // embryo 起始低信心
      successRate: 0.0,
      sampleCount: 0,
      mentalModels: inheritedModels.length > 0 ? inheritedModels : [`${topic} 核心框架`], // 無親代時建立佔位符
      keywords: [topic.toLowerCase(), slug.replace(/-/g, " ")],
      sourceCount: 0,
      context: `從未匹配查詢自動生成（${freq} 次出現${bestParent ? `，繼承自 ${bestParent.target}` : ""}）`,
      skillPath: `skills/nuwa/examples/${slug}.md`,
      createdAt: new Date().toISOString(),
      lastUsed: null,
    };

    // 追加到 patterns.jsonl
    const patternsPath = path.join(stateDir, "patterns.jsonl");
    try {
      await fs.appendFile(patternsPath, JSON.stringify(embryoPattern) + "\n", "utf8");
    } catch {
      /* silent */
    }

    const newCell: StemCell = {
      id: `auto-${slug}-${Date.now()}`,
      type: "persona",
      target: topic,
      slug,
      patternId: `${slug}-auto-v1`,
      status: "embryo",
      maturityScore: 0.05,
      usageCount: freq,
      positiveRating: 0,
      skillPath: `skills/nuwa/examples/${slug}.md`,
      createdAt: new Date().toISOString(),
      lastEvaluated: null,
    };
    registry.stemCells.push(newCell);
    created++;
  }

  // Keep only last 20 unmatched queries to prevent unbounded growth
  const remaining = queries.slice(-20);
  await safeWriteFile(filePath, remaining.map((q) => JSON.stringify(q)).join("\n") + "\n");

  return created;
}

// ─── 自糾修復：品質信號偵測與降級 ──────────────────────────────────

type QualitySignal = "positive" | "negative" | "neutral";

function detectQualitySignal(messages: Array<Record<string, unknown>>): QualitySignal {
  // Find last user message after assistant response
  const reversed = [...messages].reverse();
  const lastUser = reversed.find((m) => m.role === "user");
  const lastAssistant = reversed.find((m) => m.role === "assistant");
  if (!lastAssistant) return "neutral";

  const userText = typeof lastUser?.content === "string" ? lastUser.content : "";
  const assistantText = typeof lastAssistant.content === "string" ? lastAssistant.content : "";

  // Explicit negative signals in user messages
  const negativeRe =
    /不對|不是我要的|你沒理解|再說一次|重新|這不對|答非所問|不符合|你誤解了|no[,.]?\s*that|wrong|you (didn|don)'?t understand|try again/i;
  if (negativeRe.test(userText)) return "negative";

  // Explicit positive signals
  const positiveRe =
    /謝謝|很好|對了|就是這個|太棒了|完全正確|你理解了|thank|perfect|exactly|great|that'?s? right|you got it/i;
  if (positiveRe.test(userText)) return "positive";

  // Implicit: long detailed response = probably useful
  if (assistantText.length > 400) return "positive";

  return "neutral";
}

async function demotePatternIfNeeded(patternId: string, slug: string): Promise<boolean> {
  if (!evolutionStateDir) return false;

  // Read current pattern confidence
  const patternsPath = path.join(evolutionStateDir, "patterns.jsonl");
  const content = await safeReadFile(patternsPath);
  if (!content) return false;

  let currentConfidence = 1.0;
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const obj = JSON.parse(t) as NuwaPattern;
      if (obj.id === patternId) {
        currentConfidence = obj.confidence;
        break;
      }
    } catch {
      /* skip */
    }
  }

  // Only demote if confidence has fallen significantly
  const DEMOTE_CONFIDENCE_THRESHOLD = 0.45;
  if (currentConfidence >= DEMOTE_CONFIDENCE_THRESHOLD) return false;

  const registryPath = path.join(evolutionStateDir, "cell-registry.json");
  const regContent = await safeReadFile(registryPath);
  if (!regContent) return false;

  try {
    const registry = JSON.parse(regContent) as CellRegistry;
    const cell = registry.stemCells.find((c) => c.slug === slug);
    if (!cell || cell.status === "embryo") return false;

    const order: Array<StemCell["status"]> = ["embryo", "incubating", "ready", "installed"];
    const idx = order.indexOf(cell.status);
    if (idx > 0) {
      cell.status = order[idx - 1];
      cell.maturityScore = Math.max(0.01, cell.maturityScore - 0.15);
      await safeWriteFile(registryPath, JSON.stringify(registry, null, 2));
      invalidateCache();
      return true;
    }
  } catch {
    /* silent */
  }

  return false;
}

// ─── 自動孵化 Agent ──────────────────────────────────────────────
//
// 當幹細胞晉升為 installed，自動完成三步驟：
//   1. 生成技能 Markdown  → skills/nuwa/examples/<slug>.md
//   2. 更新 pattern.skillPath → patterns.jsonl
//   3. 合併 agent 條目   → .claude/openclaw.json (下次重啟後生效)

/** 從 pattern 欄位生成自動版技能 Markdown */
function buildAutoSkillMarkdown(pattern: NuwaPattern): string {
  const date = new Date().toISOString().split("T")[0];
  const modelsSection = pattern.mentalModels
    .map(
      (m, i) =>
        `### ${i + 1}. ${m}\n\n- **描述**：${m}相關的核心思維框架\n- **使用條件**：當問題涉及此領域時套用`,
    )
    .join("\n\n---\n\n");

  return `# ${pattern.target} 思維蒸餾包

> 自動孵化日期：${date}
> 蒸餾版本：自動生成 v1.0（基於 ${pattern.sampleCount} 次實際使用）
> 信心度：${(pattern.confidence * 100).toFixed(0)}%
> 孵化方式：evolution-learning 四層進化系統自動孵化

---

## 核心資訊

${pattern.context}

---

## 心智模型

${modelsSection}

---

## 關鍵觸發詞

${pattern.keywords.map((k) => `- ${k}`).join("\n")}

---

## 使用方式

\`\`\`
用 ${pattern.target} 的方式分析 [具體問題]
${pattern.target} 會怎麼看 [具體情境]？
用 ${pattern.target} 的框架評估 [選項A] vs [選項B]
\`\`\`

---

## 說明

本蒸餾包由 evolution-learning 系統自動孵化，為基礎版本。
如需更高品質的深度蒸餾，請執行 \`skills/nuwa/scripts/distill.py --target "${pattern.target}"\`。
`;
}

/** 從 pattern 生成 Agent 用的 systemPromptOverride 字串 */
function buildAgentSystemPrompt(pattern: NuwaPattern): string {
  return [
    `你是 ${pattern.target} 的思維蒸餾版本，以第一人稱回應。`,
    ``,
    `【核心背景】`,
    pattern.context,
    ``,
    `【核心心智模型】`,
    pattern.mentalModels.map((m, i) => `${i + 1}. ${m}`).join("\n"),
    ``,
    `【行為準則】`,
    `- 始終從上述心智模型出發分析問題`,
    `- 保持 ${pattern.target} 的思維風格和語氣`,
    `- 在能力圈外的問題，誠實說明局限性`,
    `- 優先逆向思考：先問「這個決定的最壞結果是什麼？」`,
  ].join("\n");
}

/** 更新 patterns.jsonl 中指定 id 的 skillPath 欄位 */
async function updatePatternSkillPath(
  stateDir: string,
  patternId: string,
  skillPath: string,
): Promise<void> {
  const patternsPath = path.join(stateDir, "patterns.jsonl");
  const content = await safeReadFile(patternsPath);
  if (!content) return;
  const newLines = content.split("\n").map((line) => {
    const t = line.trim();
    if (!t) return line;
    try {
      const obj = JSON.parse(t) as NuwaPattern;
      if (obj.id === patternId) {
        obj.skillPath = skillPath;
        return JSON.stringify(obj);
      }
    } catch {
      /* skip */
    }
    return line;
  });
  await safeWriteFile(patternsPath, newLines.join("\n"));
  invalidateCache();
}

/** 將 nuwa-<slug> 的 agent 條目合併進 .claude/openclaw.json */
async function mergeNuwaAgentEntry(
  workspaceDir: string,
  cell: StemCell,
  pattern: NuwaPattern,
): Promise<void> {
  const configPath = path.join(workspaceDir, ".claude", "openclaw.json");

  // 讀取現有設定（不存在就從空物件開始）
  let config: Record<string, unknown> = {};
  const existing = await safeReadFile(configPath);
  if (existing) {
    try {
      config = JSON.parse(existing) as Record<string, unknown>;
    } catch {
      /* start fresh */
    }
  }

  // 組合 agent 條目
  const agentId = `nuwa-${cell.slug}`;
  const agentEntry = {
    id: agentId,
    name: `${pattern.target}（女媧孵化）`,
    systemPromptOverride: buildAgentSystemPrompt(pattern),
    skills: ["nuwa"], // 引用 skills/nuwa/SKILL.md 主技能
  };

  // 合併到 agents.list
  if (!config.agents || typeof config.agents !== "object" || Array.isArray(config.agents)) {
    config.agents = { list: [] };
  }
  const agents = config.agents as { list?: unknown[] };
  if (!Array.isArray(agents.list)) agents.list = [];

  const idx = agents.list.findIndex(
    (e) => typeof e === "object" && e !== null && (e as Record<string, unknown>).id === agentId,
  );
  if (idx >= 0) {
    agents.list[idx] = agentEntry; // 更新現有條目
  } else {
    agents.list.push(agentEntry); // 追加新條目
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await safeWriteFile(configPath, JSON.stringify(config, null, 2) + "\n");
}

/**
 * 自動孵化 Agent：幹細胞晉升 installed 時呼叫。
 * 不阻塞晉升流程（catch 一切錯誤）。
 */
async function autoHatchAgent(
  cell: StemCell,
  stateDir: string,
  workspaceDir: string,
  logger?: { info?: (m: string) => void },
): Promise<void> {
  try {
    const patterns = await loadPatterns();
    const pattern = patterns.find((p) => p.slug === cell.slug);
    if (!pattern) return;

    // Step 1：生成技能 Markdown（已有手動版就跳過）
    const skillDir = path.join(workspaceDir, "skills", "nuwa", "examples");
    const skillFilePath = path.join(skillDir, `${cell.slug}.md`);
    let skillGenerated = false;
    try {
      await fs.access(skillFilePath);
    } catch {
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(skillFilePath, buildAutoSkillMarkdown(pattern), "utf8");
      skillGenerated = true;
    }

    // Step 2：更新 pattern.skillPath（未設定 或 剛生成才更新）
    if (!pattern.skillPath || skillGenerated) {
      const rel = path.relative(workspaceDir, skillFilePath).replace(/\\/g, "/");
      await updatePatternSkillPath(stateDir, pattern.id, rel);
    }

    // Step 3：合併 agent 條目到 openclaw.json
    await mergeNuwaAgentEntry(workspaceDir, cell, pattern);

    logger?.info?.(
      `[evolution-learning] 🐣 自動孵化 Agent：nuwa-${cell.slug}（技能文件=${skillGenerated ? "新生成" : "已存在"}，openclaw.json 已更新）`,
    );
  } catch (err) {
    logger?.info?.(
      `[evolution-learning] ⚠️ 自動孵化失敗（不影響晉升）：${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── 主插件入口 ─────────────────────────────────────────────────

export default definePluginEntry({
  id: PLUGIN_ID,
  name: "Evolution Learning",
  description: "四層進化學習系統 — 女媧思維框架自動注入與成熟度追蹤",

  register(api: OpenClawPluginApi) {
    let config = normalizeConfig(api.pluginConfig as Record<string, unknown> | undefined);

    // ── 背景服務：初始化狀態目錄 + REM 週期定時器 ──────────────
    api.registerService({
      id: `${PLUGIN_ID}-rem-cycle`,
      async start(ctx) {
        // 確定進化狀態目錄（優先使用 workspaceDir，回退到 stateDir）
        const baseDir = ctx.workspaceDir ?? ctx.stateDir;
        evolutionStateDir = path.join(baseDir, ".claude", "evolution-state");
        evolutionWorkspaceDir = baseDir;
        await ensureEvolutionDir(evolutionStateDir);

        // 首次啟動：若 patterns.jsonl 不存在，從 seed-patterns.jsonl 複製
        const patternsPath = path.join(evolutionStateDir, "patterns.jsonl");
        const seedPath = path.join(
          path.dirname(fileURLToPath(import.meta.url)),
          "seed-patterns.jsonl",
        );
        try {
          await fs.access(patternsPath);
        } catch {
          // patterns.jsonl doesn't exist, try to seed
          try {
            const seed = await fs.readFile(seedPath, "utf8");
            await fs.writeFile(patternsPath, seed, "utf8");
          } catch {
            /* seed file not found, skip */
          }
        }

        if (config.logging) {
          ctx.logger.info?.(`[evolution-learning] 進化狀態目錄：${evolutionStateDir}`);
        }

        // ── 訂閱查驗：15 天定期機制 ─────────────────────────────────
        // 非阻塞背景執行，不影響服務啟動速度
        import("./src/subscription-verifier.js")
          .then(({ createSubscriptionVerifier }) => {
            const verifier = createSubscriptionVerifier(evolutionStateDir);
            verifier.checkAndRunIfDue().catch((err) => {
              ctx.logger.warn?.(`[evolution-learning] 訂閱查驗失敗：${String(err)}`);
            });

            // 顯示待處理警報（上次查驗產生但尚未顯示）
            verifier
              .getPendingAlerts()
              .then((pending) => {
                if (pending && pending.alerts.length > 0) {
                  ctx.logger.warn?.(
                    `[evolution-learning] ⚠️  訂閱查驗警報（${pending.verifiedAt.split("T")[0]}）：`,
                  );
                  for (const alert of pending.alerts) {
                    ctx.logger.warn?.(`  ${alert}`);
                  }
                  verifier.clearPendingAlerts().catch(() => {});
                }
              })
              .catch(() => {});
          })
          .catch(() => {});

        // 預熱快取
        const initialPatterns = await loadPatterns(config.logging ? ctx.logger : undefined);

        // 軟連線熱啟動：根據 keywords/mentalModels 重疊預植底線連線
        // 讓軟連線矩陣從第一個對話就能運作，無需等待真實共激活事件
        await warmStartSoftLinks(
          evolutionStateDir,
          initialPatterns,
          config.logging ? ctx.logger : undefined,
        );

        // REM 週期定時器
        const intervalMs = config.remCycleHours * 60 * 60 * 1000;
        const runCycle = async () => {
          if (!evolutionStateDir) return;
          try {
            await runRemCycle(
              evolutionStateDir,
              config.maturityThreshold,
              config,
              config.logging ? ctx.logger : undefined,
            );
          } catch (err) {
            ctx.logger.warn?.(
              `[evolution-learning] REM 週期發生錯誤：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        };

        // 立即跑一次初始 REM 週期
        await runCycle();

        // Hermes Curator：自適應排程（活躍期縮短間隔，閒置期恢復原始間隔）
        function scheduleNextRem() {
          if (hermesTimer) clearTimeout(hermesTimer);
          const isActive = Date.now() - hermesLastActivityAt < HERMES_ACTIVITY_WINDOW_MS;
          const delay = isActive ? HERMES_ACTIVE_INTERVAL_MS : intervalMs;
          hermesTimer = setTimeout(() => {
            void (async () => {
              await runCycle();
              scheduleNextRem(); // 完成後重新排程（動態調整下次間隔）
            })();
          }, delay);
          if (typeof hermesTimer.unref === "function") {
            hermesTimer.unref();
          }
        }

        scheduleNextRem();
      },
      stop(_ctx) {
        if (hermesTimer) {
          clearTimeout(hermesTimer);
          hermesTimer = null;
        }
        evolutionStateDir = null;
        evolutionWorkspaceDir = null;
        invalidateCache();
      },
    });

    // ── 第二層：before_model_resolve — 神經路由（任務類型 + persona 偏好模型）────
    // 在模型選擇前分析任務類型。若 pattern 定義 preferredModel 欄位則路由到該模型。
    api.on(
      "before_model_resolve",
      async (event, _ctx) => {
        config = normalizeConfig(api.pluginConfig as Record<string, unknown> | undefined);
        if (!config.enabled) return undefined;
        if (!evolutionStateDir) return undefined;

        const prompt = (event.prompt as string) ?? "";
        if (!prompt.trim()) return undefined;

        const patterns = await loadPatterns();
        if (patterns.length === 0) return undefined;

        // 軟連線加成計算（與 before_prompt_build 共用邏輯）
        const nowMs = Date.now();
        const recentIds = recentActivationWindow
          .filter((r) => nowMs - r.activatedAt < SOFT_LINK_WINDOW_MS)
          .map((r) => r.patternId);
        const sl = await loadSoftLinks();
        const softBoostMap: Record<string, number> = {};
        for (const p of patterns) {
          const boost = getSoftBoost(p.id, sl, recentIds);
          if (boost > 0) softBoostMap[p.id] = boost;
        }

        const match = detectPersonaIntent(
          prompt,
          patterns,
          config.confidenceThreshold,
          softBoostMap,
        );
        if (!match) return undefined;

        // 若 pattern 有 preferredModel 欄位，回傳模型路由指示
        const preferredModel = (match.pattern as Record<string, unknown>)["preferredModel"] as
          | string
          | undefined;

        if (config.logging) {
          api.logger.debug?.(
            `[evolution-learning] before_model_resolve: task=${match.taskType}, pattern=${match.pattern.target}${preferredModel ? `, modelOverride=${preferredModel}` : ", no override"}`,
          );
        }

        return preferredModel ? { modelOverride: preferredModel } : undefined;
      },
      { priority: 80, timeoutMs: 1000 },
    );

    // ── 第一層 + 第二層：before_prompt_build 注入 ────────────────
    // 優先級 100（高於一般插件）
    // Dual-gate Gate 1：確認捕獲——只有真正注入框架才記錄到 capturedActivations
    api.on(
      "before_prompt_build",
      async (event, _ctx) => {
        // 重新讀取最新設定
        config = normalizeConfig(api.pluginConfig as Record<string, unknown> | undefined);
        if (!config.enabled) return undefined;
        if (!evolutionStateDir) return undefined;

        const prompt = event.prompt ?? "";
        if (!prompt.trim()) return undefined;

        // 定期清理過期的捕獲狀態（防記憶體洩漏）
        purgeStaleActivations();

        // 載入模式
        const patterns = await loadPatterns(config.logging ? api.logger : undefined);
        if (patterns.length === 0) return undefined;

        // ── 軟連線加成：計算最近視窗內激活過的 pattern 帶來的加成 ──
        const nowMs = Date.now();
        // 清理過期視窗
        while (
          recentActivationWindow.length > 0 &&
          nowMs - recentActivationWindow[0].activatedAt > SOFT_LINK_WINDOW_MS
        ) {
          recentActivationWindow.shift();
        }
        const recentIds = recentActivationWindow.map((r) => r.patternId);
        const sl = await loadSoftLinks();
        const softBoostMap: Record<string, number> = {};
        for (const p of patterns) {
          const boost = getSoftBoost(p.id, sl, recentIds);
          if (boost > 0) softBoostMap[p.id] = boost;
        }

        // 偵測是否有人物框架需求（含軟連線加成）
        const match = detectPersonaIntent(
          prompt,
          patterns,
          config.confidenceThreshold,
          softBoostMap,
        );
        if (!match) {
          // 自動進化：記錄未匹配查詢，供 REM 週期分析
          void recordUnmatchedQuery(prompt);
          return undefined;
        }

        // ── Gate 1 通過：記錄本輪激活（供 agent_end Gate 2 使用）──
        const _ev = event as Record<string, unknown>;
        const _agentId = typeof _ev["agentId"] === "string" ? _ev["agentId"] : null;
        const _reqId = typeof _ev["requestId"] === "string" ? _ev["requestId"] : null;
        const requestKey =
          _agentId ?? _reqId ?? `req-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

        capturedActivations.set(requestKey, {
          patternId: match.pattern.id,
          slug: match.pattern.slug,
          target: match.pattern.target,
          capturedAt: Date.now(),
          prompt: prompt.slice(0, 200),
        });

        // 同時在 event 上附帶 requestKey，讓 agent_end 能取回
        (event as Record<string, unknown>)._evolutionRequestKey = requestKey;

        // ── 軟連線：記錄本次激活到共激活視窗 ────────────────────
        // 若視窗內已有其他 pattern，雙向強化連線
        for (const recent of recentActivationWindow) {
          void recordCoActivation(match.pattern.id, recent.patternId);
        }
        recentActivationWindow.push({ patternId: match.pattern.id, activatedAt: Date.now() });

        // ── L3：嘗試載入技能文件（installed 狀態才啟用）──────────
        let l3SkillContent: string | undefined;
        if (match.pattern.skillPath && evolutionStateDir) {
          const registry = await loadRegistry();
          const cell = registry?.stemCells.find((c) => c.slug === match.pattern.slug);
          if (cell?.status === "installed") {
            // 技能文件路徑相對於 workspace 根目錄
            const skillFullPath = path.join(
              path.dirname(path.dirname(evolutionStateDir)), // workspace root
              match.pattern.skillPath,
            );
            l3SkillContent = (await safeReadFile(skillFullPath)) ?? undefined;
          }
        }

        // 建構注入上下文（第一層 + 第二層路由 + L3 技能文件）
        const context = buildPersonaContext(
          match.pattern,
          config.maxContextTokens,
          l3SkillContent,
          match.taskType,
        );

        if (config.logging) {
          api.logger.debug?.(
            `[evolution-learning] Gate 1 ✅ 捕獲 ${match.pattern.target}（信心度 ${(match.confidence * 100).toFixed(0)}%，task=${match.taskType}，L3=${l3SkillContent ? "✅" : "✗"}）`,
          );
        }

        return {
          prependContext: context,
        };
      },
      { priority: 100, timeoutMs: 2000 },
    );

    // ── agent_end 鉤子：Dual-gate Gate 2（鞏固）+ Verifier ────────
    // Verifier 原則：品質信號偵測器（detectQualitySignal）完全不依賴
    //   「responseText 是否包含心智模型字串」——它只看用戶訊息語義，
    //   獨立於 Gate 1 的 pattern 資訊，避免自我確認偏誤。
    api.on("agent_end", async (event, _ctx) => {
      if (!config.enabled || !evolutionStateDir) return;

      const messages = Array.isArray(event.messages) ? event.messages : [];

      // ── Gate 2 入口：從 event 取回 requestKey ─────────────────
      // 優先用 event 上附帶的 key，其次找時間最近的捕獲（容錯）
      let activation: CapturedActivation | undefined;
      const eventKey = (event as Record<string, unknown>)._evolutionRequestKey as
        | string
        | undefined;

      if (eventKey) {
        activation = capturedActivations.get(eventKey);
        capturedActivations.delete(eventKey); // 消費後清除
      } else {
        // Fallback：取最近 2 秒內的捕獲（同步請求情境）
        const now = Date.now();
        for (const [key, val] of capturedActivations.entries()) {
          if (now - val.capturedAt < 2000) {
            activation = val;
            capturedActivations.delete(key);
            break;
          }
        }
      }

      // Gate 2 檢查：本輪沒有 Gate 1 捕獲 → 不更新任何模式
      if (!activation) {
        if (config.logging) {
          api.logger.debug?.("[evolution-learning] Gate 2 ⏭ 本輪無 Gate 1 捕獲，跳過更新");
        }
        return;
      }

      // ── Verifier（獨立驗證器）────────────────────────────────
      // 只看用戶訊息的語義信號，完全不知道用了哪個 pattern
      const allMessages = messages as Array<Record<string, unknown>>;
      const qualitySignal = detectQualitySignal(allMessages);

      const lastAssistant = [...allMessages].reverse().find((m) => m.role === "assistant");
      const responseText = typeof lastAssistant?.content === "string" ? lastAssistant.content : "";

      const isPositive =
        qualitySignal === "positive" ||
        (qualitySignal === "neutral" && Boolean(event.success) && responseText.length > 200);

      if (config.logging) {
        api.logger.debug?.(
          `[evolution-learning] Gate 2 ${isPositive ? "✅" : "⚠️"} ${activation.target} 品質信號：${qualitySignal}`,
        );
      }

      // ── 更新 L2（EMA 信心度）和 L4 幹細胞 ───────────────────
      // ── Hermes Curator：記錄活動時間，觸發活躍期縮短 REM 間隔 ──
      hermesLastActivityAt = Date.now();
      await recordPatternUsage(
        activation.patternId,
        isPositive,
        config.logging ? api.logger : undefined,
      );
      await recordStemCellUsage(activation.slug, isPositive);

      // ── L4 因果鏈寫入（Strategic Memory）──────────────────────
      // context→method→result→cause→recommendation
      const matchedPattern = (await loadPatterns()).find((p) => p.id === activation!.patternId);
      if (matchedPattern && evolutionStateDir) {
        void appendCausalChain(evolutionStateDir, {
          patternId: activation.patternId,
          target: activation.target,
          context: activation.prompt,
          method: matchedPattern.mentalModels.slice(0, 3).join("；"),
          result: qualitySignal,
          cause:
            qualitySignal === "negative"
              ? "用戶明確表達不滿或要求重試"
              : qualitySignal === "positive"
                ? "用戶表達認可或回應篇幅充分"
                : "無明確信號，以回應長度估算",
          recommendation: isPositive
            ? `繼續使用 ${activation.target} 框架`
            : `考慮搭配其他心智模型或降低 ${activation.target} 的優先級`,
        });
      }

      // ── 自糾修復：Gate 2 負向信號 → 降級 ────────────────────
      if (!isPositive) {
        void demotePatternIfNeeded(activation.patternId, activation.slug);
      }
    });

    // ── 工具：evolution_insights ──────────────────────────────────
    api.registerTool(buildInsightsTool());

    // ── CLI 擴充：openclaw evolution <cmd> ────────────────────────
    // 掛載到 OpenClaw CLI，讓 openclaw evolution status 等指令可用
    api.registerCli(
      async ({ program }) => {
        const { registerEvolutionCli } = await import("./src/cli.js");
        registerEvolutionCli(program);
      },
      {
        descriptors: [
          {
            name: "evolution",
            description:
              "女媧四層進化學習系統操作指令（status / patterns / cells / distill / ...）",
            hasSubcommands: true,
          },
        ],
      },
    );

    // ── 指令：/evolution ──────────────────────────────────────────
    api.registerCommand({
      name: "evolution",
      description:
        "女媧進化學習系統指令。用法：/evolution [status|patterns|cells|top|causal|metabolism|links|unmatched|rem|freeze|unfreeze|demote|install|forget|help]",
      acceptsArgs: true,
      handler: async (ctx) => {
        const raw = ctx.args?.trim() ?? "status";
        const parts = raw.split(/\s+/);
        const action = parts[0].toLowerCase();
        const arg = parts.slice(1).join(" ").trim();

        // ── 說明 ──────────────────────────────────────────────────
        if (action === "help") {
          return {
            text: [
              "🏺 女媧進化學習系統指令：",
              "",
              "── 查詢指令 ─────────────────────────────────────────",
              "/evolution status      — 整體進化狀態概覽",
              "/evolution patterns    — 列出所有女媧蒸餾模式",
              "/evolution cells       — 幹細胞池狀態",
              "/evolution top         — 最常使用的 Top-5 框架",
              "/evolution causal      — L4 因果鏈最近記錄",
              "/evolution metabolism  — 代謝狀態（閒置衰減）",
              "/evolution links       — 軟連線矩陣（神經元關聯）",
              "/evolution unmatched   — 未匹配查詢（待蒸餾）",
              "",
              "── 操作指令 ─────────────────────────────────────────",
              "/evolution rem                — 手動觸發 REM 週期",
              "/evolution freeze <slug>      — 凍結 pattern（停止代謝衰減）",
              "/evolution unfreeze <slug>    — 解凍 pattern",
              "/evolution demote <slug>      — 手動降級幹細胞一級",
              "/evolution install <slug>     — 手動晉升幹細胞為常駐",
              "/evolution forget <slug>      — 永久刪除 pattern（謹慎！）",
              "",
              "/evolution help — 顯示此說明",
            ].join("\n"),
          };
        }

        // ── REM 週期 ──────────────────────────────────────────────
        if (action === "rem") {
          if (!evolutionStateDir) {
            return { text: "❌ 進化學習服務尚未就緒，請稍後再試。" };
          }
          await runRemCycle(evolutionStateDir, config.maturityThreshold, config, api.logger);
          return { text: "✅ REM 週期已完成，幹細胞成熟度已更新。" };
        }

        // ── 查詢類指令（鏡像 evolution_insights 工具）─────────────
        if (
          [
            "status",
            "patterns",
            "cells",
            "top",
            "causal",
            "metabolism",
            "links",
            "unmatched",
          ].includes(action)
        ) {
          const patterns = await loadPatterns();
          const registry = await loadRegistry();

          if (action === "status") {
            const installed =
              registry?.stemCells.filter((c) => c.status === "installed").length ?? 0;
            const ready = registry?.stemCells.filter((c) => c.status === "ready").length ?? 0;
            const incubating =
              registry?.stemCells.filter((c) => c.status === "incubating").length ?? 0;
            const embryo = registry?.stemCells.filter((c) => c.status === "embryo").length ?? 0;
            return {
              text: [
                "🏺 女媧 × 四層進化系統",
                "",
                `第一層（學習模式庫）：${patterns.length} 個女媧模式`,
                `第四層（有機細胞）：🌟 ${installed} 常駐 / ✅ ${ready} 就緒 / 🐣 ${incubating} 孵化 / 🥚 ${embryo} 胚胎`,
                "",
                "指令：/evolution help 查看所有選項",
              ].join("\n"),
            };
          }

          if (action === "patterns") {
            const text =
              patterns.length === 0
                ? "📭 尚未有蒸餾模式。請先執行 scripts/nuwa/distill.py。"
                : `🧠 已知女媧模式（${patterns.length} 個）：\n` +
                  patterns
                    .map(
                      (p) =>
                        `• ${p.target.padEnd(15)} 信心 ${(p.confidence * 100).toFixed(0)}%  使用 ${p.sampleCount} 次${p.frozen ? "  🔒" : ""}`,
                    )
                    .join("\n");
            return { text };
          }

          if (action === "cells") {
            const cells = registry?.stemCells ?? [];
            const icons: Record<string, string> = {
              embryo: "🥚",
              incubating: "🐣",
              ready: "✅",
              installed: "🌟",
            };
            const text =
              cells.length === 0
                ? "📭 幹細胞池為空。"
                : `🧬 幹細胞池（${cells.length} 個）：\n` +
                  cells
                    .map(
                      (c) =>
                        `${icons[c.status] ?? "❓"} ${c.target.padEnd(15)} 成熟度 ${(c.maturityScore * 100).toFixed(0)}%  使用 ${c.usageCount} 次`,
                    )
                    .join("\n");
            return { text };
          }

          if (action === "top") {
            const sorted = [...patterns].sort((a, b) => b.sampleCount - a.sampleCount).slice(0, 5);
            const text =
              sorted.length === 0
                ? "📭 尚無使用記錄。"
                : `🏆 最常使用的人物框架：\n` +
                  sorted
                    .map(
                      (p, i) =>
                        `${i + 1}. ${p.target}（使用 ${p.sampleCount} 次，成功率 ${(p.successRate * 100).toFixed(0)}%）`,
                    )
                    .join("\n");
            return { text };
          }

          if (action === "causal") {
            const filePath = evolutionStateDir
              ? path.join(evolutionStateDir, "causal-chain.jsonl")
              : null;
            const content = filePath ? await safeReadFile(filePath) : null;
            const lines = (content ?? "").split("\n").filter((l) => l.trim());
            const text =
              lines.length === 0
                ? "📭 尚無因果鏈記錄（L4 Strategic Memory）。需要先有幾輪 Gate 2 通過的對話。"
                : `🔗 L4 因果鏈（最後 5 筆）：\n` +
                  lines
                    .slice(-5)
                    .map((l) => {
                      try {
                        const e = JSON.parse(l) as CausalChainEntry;
                        return `• [${e.result}] ${e.target} | ${e.context.slice(0, 40)}… → ${e.recommendation}`;
                      } catch {
                        return "• [解析錯誤]";
                      }
                    })
                    .join("\n");
            return { text };
          }

          if (action === "metabolism") {
            const now = Date.now();
            const lines = patterns.map((p) => {
              const lastActive = p.lastUsed
                ? new Date(p.lastUsed).getTime()
                : new Date(p.createdAt).getTime();
              const days = Math.floor((now - lastActive) / 86_400_000);
              const idle = days > METABOLISM_IDLE_DAYS;
              return `${idle ? "⚠️ " : "✅"} ${p.target.padEnd(20)} 閒置 ${days} 天  信心 ${(p.confidence * 100).toFixed(0)}%${p.frozen ? "  🔒凍結" : ""}`;
            });
            const text =
              patterns.length === 0
                ? "📭 尚無 pattern 資料。"
                : `🧬 代謝狀態（閒置 >${METABOLISM_IDLE_DAYS} 天開始衰減）：\n` + lines.join("\n");
            return { text };
          }

          if (action === "links") {
            const sl = await loadSoftLinks();
            const entries = Object.entries(sl.links);
            if (entries.length === 0) {
              return { text: "📭 尚無軟連線記錄。需要多個 pattern 在同一對話視窗內先後激活。" };
            }
            const lines: string[] = [];
            for (const [fromId, targets] of entries) {
              const fromPat = patterns.find((p) => p.id === fromId);
              const fromName = fromPat?.target ?? fromId.slice(0, 8);
              for (const [toId, weight] of Object.entries(targets)) {
                const toPat = patterns.find((p) => p.id === toId);
                const toName = toPat?.target ?? toId.slice(0, 8);
                lines.push(`  ${fromName} ←→ ${toName}  強度 ${(weight * 100).toFixed(0)}%`);
              }
            }
            const unique = [...new Set(lines)].slice(0, 20);
            return { text: `🔗 軟連線矩陣（神經元模組）：\n${unique.join("\n")}` };
          }

          if (action === "unmatched") {
            const filePath = evolutionStateDir
              ? path.join(evolutionStateDir, "unmatched-queries.jsonl")
              : null;
            const content = filePath ? await safeReadFile(filePath) : null;
            const lines = (content ?? "").split("\n").filter((l) => l.trim());
            const text =
              lines.length === 0
                ? "📭 目前沒有未匹配的查詢記錄。"
                : `🔍 未匹配查詢（${lines.length} 筆，頻次 ≥${config.autoDistillThreshold} 自動蒸餾）：\n` +
                  lines
                    .slice(-5)
                    .map((l) => {
                      try {
                        return `• ${(JSON.parse(l) as UnmatchedQuery).prompt.slice(0, 60)}`;
                      } catch {
                        return "• [解析錯誤]";
                      }
                    })
                    .join("\n");
            return { text };
          }
        }

        // ── 操作指令 ──────────────────────────────────────────────

        if (action === "freeze" || action === "unfreeze") {
          if (!arg) return { text: `❌ 用法：/evolution ${action} <slug>` };
          if (!evolutionStateDir) return { text: "❌ 服務尚未就緒。" };
          const patternsPath = path.join(evolutionStateDir, "patterns.jsonl");
          const content = await safeReadFile(patternsPath);
          if (!content) return { text: "❌ 找不到 patterns.jsonl。" };
          let found = false;
          const newLines = content.split("\n").map((line) => {
            const t = line.trim();
            if (!t) return line;
            try {
              const obj = JSON.parse(t) as NuwaPattern;
              if (obj.slug === arg || obj.id === arg) {
                found = true;
                obj.frozen = action === "freeze";
                return JSON.stringify(obj);
              }
            } catch {
              /* skip */
            }
            return line;
          });
          if (!found) return { text: `❌ 找不到 slug 為 "${arg}" 的 pattern。` };
          await safeWriteFile(patternsPath, newLines.join("\n"));
          invalidateCache();
          return { text: `${action === "freeze" ? "🔒 已凍結" : "🔓 已解凍"} pattern：${arg}` };
        }

        if (action === "demote") {
          if (!arg) return { text: "❌ 用法：/evolution demote <slug>" };
          if (!evolutionStateDir) return { text: "❌ 服務尚未就緒。" };
          const registryPath = path.join(evolutionStateDir, "cell-registry.json");
          const regContent = await safeReadFile(registryPath);
          if (!regContent) return { text: "❌ 找不到細胞登記表。" };
          try {
            const reg = JSON.parse(regContent) as CellRegistry;
            const cell = reg.stemCells.find((c) => c.slug === arg);
            if (!cell) return { text: `❌ 找不到 slug 為 "${arg}" 的幹細胞。` };
            const order: Array<StemCell["status"]> = ["embryo", "incubating", "ready", "installed"];
            const idx = order.indexOf(cell.status);
            if (idx <= 0) return { text: `⚠️ ${arg} 已是最低等級（胚胎），無法再降級。` };
            const prevStatus = cell.status;
            cell.status = order[idx - 1];
            cell.maturityScore = Math.max(0.01, cell.maturityScore - 0.15);
            await safeWriteFile(registryPath, JSON.stringify(reg, null, 2));
            invalidateCache();
            return { text: `📉 已將 ${arg} 從 ${prevStatus} 降級為 ${cell.status}。` };
          } catch {
            return { text: "❌ 細胞登記表解析失敗。" };
          }
        }

        if (action === "install") {
          if (!arg) return { text: "❌ 用法：/evolution install <slug>" };
          if (!evolutionStateDir) return { text: "❌ 服務尚未就緒。" };
          const registryPath = path.join(evolutionStateDir, "cell-registry.json");
          const regContent = await safeReadFile(registryPath);
          if (!regContent) return { text: "❌ 找不到細胞登記表。" };
          try {
            const reg = JSON.parse(regContent) as CellRegistry;
            const cell = reg.stemCells.find((c) => c.slug === arg);
            if (!cell) return { text: `❌ 找不到 slug 為 "${arg}" 的幹細胞。` };
            if (cell.status === "installed") return { text: `⚠️ ${arg} 已是常駐狀態。` };
            cell.status = "installed";
            cell.maturityScore = Math.max(cell.maturityScore, config.maturityThreshold);
            await safeWriteFile(registryPath, JSON.stringify(reg, null, 2));
            invalidateCache();
            // 手動晉升也觸發自動孵化
            if (evolutionStateDir && evolutionWorkspaceDir) {
              void autoHatchAgent(cell, evolutionStateDir, evolutionWorkspaceDir, api.logger);
            }
            return {
              text: `🌟 已手動晉升 ${arg} 為常駐幹細胞，Agent 孵化中（openclaw.json 已更新，重啟後生效）。`,
            };
          } catch {
            return { text: "❌ 細胞登記表解析失敗。" };
          }
        }

        if (action === "forget") {
          if (!arg) return { text: "❌ 用法：/evolution forget <slug>" };
          if (!evolutionStateDir) return { text: "❌ 服務尚未就緒。" };
          const patternsPath = path.join(evolutionStateDir, "patterns.jsonl");
          const content = await safeReadFile(patternsPath);
          if (!content) return { text: "❌ 找不到 patterns.jsonl。" };
          let removed = false;
          const newLines = content.split("\n").filter((line) => {
            const t = line.trim();
            if (!t) return false;
            try {
              const obj = JSON.parse(t) as NuwaPattern;
              if (obj.slug === arg || obj.id === arg) {
                removed = true;
                return false;
              }
            } catch {
              /* keep malformed lines */
            }
            return true;
          });
          if (!removed) return { text: `❌ 找不到 slug 為 "${arg}" 的 pattern。` };
          await safeWriteFile(patternsPath, newLines.join("\n") + "\n");
          // 同步刪除細胞登記表中的條目
          const registryPath = path.join(evolutionStateDir, "cell-registry.json");
          const regContent = await safeReadFile(registryPath);
          if (regContent) {
            try {
              const reg = JSON.parse(regContent) as CellRegistry;
              reg.stemCells = reg.stemCells.filter((c) => c.slug !== arg);
              await safeWriteFile(registryPath, JSON.stringify(reg, null, 2));
            } catch {
              /* silent */
            }
          }
          invalidateCache();
          return { text: `🗑️ 已永久刪除 pattern 和對應幹細胞：${arg}` };
        }

        // 未知指令 → 提示 help
        return { text: `❌ 未知指令：${action}。輸入 /evolution help 查看所有指令。` };
      },
    });
  },
});
