/**
 * dmad-debate.ts — DMAD（Diversity-enhanced Multi-Agent Debate）實作
 *
 * 強制三代理採用不同角度辯論，比標準多輪辯論準確度更高、輪次更少。
 * 論文：DMAD (ICLR'25) + M-MAD (ACL'25)
 *
 * 代理角色：
 *   Claude   → 語言理解與推理（呼叫 `claude -p --output-format json`）
 *   Codex    → 技術可行性（呼叫 `codex exec --json`）
 *   OpenClaw → pattern 庫框架（本地 SQLite，零 API 費用）
 *
 * 停止條件（任一滿足即停）：
 *   ① cosine similarity > 0.93（語義已收斂）
 *   ② 所有代理立場變化 < 5%
 *   ③ 已達最大 3 輪
 *
 * 費用模型：
 *   - Round 1：Claude Haiku × 1 + Codex × 1（OpenClaw 零費用）
 *   - Round 2+：Claude Haiku × 1（讀取其他代理回應後補充）
 *   - MoA 聚合：Claude Sonnet × 1
 *   - 總計：~$0.003–$0.008 per debate
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import { cosineSimilarity } from "./embedding.js";

const execFileAsync = promisify(execFile);

// ── 公開型別 ──────────────────────────────────────────────────────────────────

export interface DebateRound {
  round: number;
  claudeResponse: string;
  codexResponse: string;
  openclawResponse: string;
  convergenceScore: number; // 三者平均 cosine 相似度
}

export interface DebateResult {
  id: string;
  task: string;
  rounds: DebateRound[];
  finalAnswer: string; // MoA 聚合結果（Sonnet）
  convergenceScore: number; // 最終收斂分
  totalRounds: number;
  stoppedBy: "convergence" | "variance" | "max_rounds";
  patternSlugsUsed: string[];
  estimatedCostUsd: number;
  startedAt: string;
  completedAt: string;
}

export interface DMADOptions {
  maxRounds?: number; // 預設 3
  convergenceThreshold?: number; // 預設 0.93
  varianceThreshold?: number; // 預設 0.05
  claudeModel?: string; // 預設 claude-haiku-4-5
  codexModel?: string; // 預設 gpt-4.5
  ollamaUrl?: string; // OpenClaw 本地模型
  timeoutMs?: number; // 每次 CLI 呼叫 timeout，預設 30000
}

// ── 角色提示模板 ──────────────────────────────────────────────────────────────

const CLAUDE_ROLE_R1 = (task: string) => `你是語言理解與推理代理（Claude）。
請從**語言邏輯、使用者意圖、抽象推理**的角度分析以下任務，提出你的初始方案。
不超過 200 字。

任務：${task}`;

const CLAUDE_ROLE_R2 = (
  task: string,
  codex: string,
  openclaw: string,
) => `你是語言理解與推理代理（Claude）。
以下是其他代理的第一輪觀點：

[Codex 技術觀點]：${codex.slice(0, 300)}
[OpenClaw Pattern 觀點]：${openclaw.slice(0, 300)}

任務：${task}

請**從不同角度補充或反駁**（不得重複已有論點），重點在語言推理和使用者意圖層面。不超過 150 字。`;

const CODEX_ROLE_R1 = (task: string) => `你是技術可行性代理（Codex）。
請從**程式碼實作、技術架構、效能**的角度審查以下任務，提出技術可行性評估。
不超過 200 字。

任務：${task}`;

const CODEX_ROLE_R2 = (
  task: string,
  claude: string,
  openclaw: string,
) => `你是技術可行性代理（Codex）。
以下是其他代理的第一輪觀點：

[Claude 推理觀點]：${claude.slice(0, 300)}
[OpenClaw Pattern 觀點]：${openclaw.slice(0, 300)}

任務：${task}

請**從技術層面補充或修正**，指出實作細節或技術風險。不超過 150 字。`;

const MOA_PROMPT = (
  task: string,
  rounds: DebateRound[],
  patterns: string[],
) => `你是 MoA（Mixture of Agents）聚合器。
任務是整合三個代理（Claude/Codex/OpenClaw）的多輪辯論，輸出最終高品質答案。

## 原始任務
${task}

## 辯論歷程（${rounds.length} 輪）
${rounds
  .map(
    (r, i) => `
### 第 ${i + 1} 輪（收斂分：${r.convergenceScore.toFixed(2)}）
[Claude] ${r.claudeResponse.slice(0, 200)}
[Codex] ${r.codexResponse.slice(0, 200)}
[OpenClaw] ${r.openclawResponse.slice(0, 200)}
`,
  )
  .join("\n")}

## 激活的 nuwa Pattern 框架
${patterns.length > 0 ? patterns.join("\n") : "（無激活 pattern）"}

## 你的任務
綜合以上所有觀點，輸出：
1. 最終建議方案（300 字以內）
2. 採納了哪些代理的哪些論點（列點）
3. 信心分（0-1）`;

// ── OpenClaw 代理（本地，零費用）────────────────────────────────────────────

async function openclawRespond(
  task: string,
  db: Database.Database,
  round: number,
  prevContext?: { claude: string; codex: string },
): Promise<{ response: string; patternSlugs: string[] }> {
  // 從 patterns 表找最相關的 top-3 patterns（FTS5 或 LIKE）
  type PatternRow = {
    slug: string;
    target: string;
    context: string | null;
    mental_models: string | null;
  };
  let patterns: PatternRow[] = [];

  try {
    const keywords = task
      .replace(/[^\w\s一-鿿]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 2)
      .slice(0, 5);

    if (keywords.length > 0) {
      const ftsQ = keywords.map((k) => `"${k}"`).join(" OR ");
      patterns = db
        .prepare(`
        SELECT p.slug, p.target, p.context, p.mental_models
        FROM patterns p
        JOIN patterns_fts f ON p.id = f.rowid
        WHERE patterns_fts MATCH ?
        ORDER BY rank
        LIMIT 3
      `)
        .all(ftsQ) as PatternRow[];
    }
  } catch {
    // FTS5 不可用，fallback LIKE
  }

  if (patterns.length === 0) {
    patterns = db
      .prepare(`
      SELECT slug, target, context, mental_models
      FROM patterns
      WHERE frozen = 0
      ORDER BY decay_score DESC
      LIMIT 3
    `)
      .all() as PatternRow[];
  }

  const patternSlugs = patterns.map((p) => p.slug);

  if (round === 1) {
    const patternSummary = patterns
      .map((p) => {
        let models: string[] = [];
        try {
          models = JSON.parse(p.mental_models ?? "[]");
        } catch {
          /* ignore */
        }
        return `[${p.slug}] ${p.target}：${models.slice(0, 2).join(" / ")}`;
      })
      .join("\n");

    return {
      response:
        patterns.length > 0
          ? `從歷史框架看：\n${patternSummary}\n\n建議優先套用「${patterns[0].slug}」框架處理任務：${task.slice(0, 100)}`
          : `目前無相關 pattern，建議先蒸餾此任務的框架再處理。任務：${task.slice(0, 100)}`,
      patternSlugs,
    };
  }

  // Round 2+：整合 Claude + Codex 觀點後補充 pattern 視角
  return {
    response:
      `Pattern 視角補充（基於 ${patternSlugs.join(", ") || "無匹配"}）：\n` +
      `Claude 說「${prevContext!.claude.slice(0, 80)}」，Codex 說「${prevContext!.codex.slice(0, 80)}」。\n` +
      `從歷史框架看，${patterns[0]?.target ?? "當前無框架"}最符合，建議採用其中的思維模型。`,
    patternSlugs,
  };
}

// ── Claude CLI 代理 ───────────────────────────────────────────────────────────

async function claudeRespond(prompt: string, model: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      "claude",
      ["-p", prompt, "--output-format", "json", "--model", model],
      { timeout: timeoutMs },
    );
    const json = JSON.parse(stdout) as { result?: string; content?: string };
    return json.result ?? json.content ?? stdout.slice(0, 500);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return `[Claude CLI 未安裝，請執行 npm install -g @anthropic-ai/claude-code]`;
    }
    return `[Claude 呼叫失敗：${String(err).slice(0, 100)}]`;
  }
}

// ── Codex CLI 代理 ────────────────────────────────────────────────────────────

async function codexRespond(prompt: string, model: string, timeoutMs: number): Promise<string> {
  try {
    const { stdout } = await execFileAsync("codex", ["exec", "--model", model, "--json", prompt], {
      timeout: timeoutMs,
    });
    // JSONL — 找最後一個 turn.completed
    const lines = stdout.split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]) as { type?: string; payload?: { content?: string } };
        if (ev.type === "turn.completed" && ev.payload?.content) {
          return ev.payload.content;
        }
      } catch {
        /* skip */
      }
    }
    return stdout.slice(0, 500);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return `[Codex CLI 未安裝，請執行 npm install -g @openai/codex]`;
    }
    return `[Codex 呼叫失敗：${String(err).slice(0, 100)}]`;
  }
}

// ── 收斂偵測 ──────────────────────────────────────────────────────────────────

/** 簡易 TF-IDF 向量（字元 n-gram 2-3，對中文友好）*/
function textToVec(text: string): Map<string, number> {
  const vec = new Map<string, number>();
  const chars = text.replace(/\s+/g, "").slice(0, 500);
  for (let i = 0; i < chars.length - 1; i++) {
    const bi = chars.slice(i, i + 2);
    vec.set(bi, (vec.get(bi) ?? 0) + 1);
    if (i < chars.length - 2) {
      const tri = chars.slice(i, i + 3);
      vec.set(tri, (vec.get(tri) ?? 0) + 1);
    }
  }
  return vec;
}

function mapToArray(map: Map<string, number>, vocab: string[]): number[] {
  return vocab.map((k) => map.get(k) ?? 0);
}

function sparseCosine(a: Map<string, number>, b: Map<string, number>): number {
  const vocab = Array.from(new Set([...a.keys(), ...b.keys()]));
  return cosineSimilarity(mapToArray(a, vocab), mapToArray(b, vocab));
}

function measureConvergence(r: DebateRound): number {
  const va = textToVec(r.claudeResponse);
  const vb = textToVec(r.codexResponse);
  const vc = textToVec(r.openclawResponse);
  return (sparseCosine(va, vb) + sparseCosine(vb, vc) + sparseCosine(va, vc)) / 3;
}

function measureVariance(prev: DebateRound, curr: DebateRound): number {
  const dA = 1 - sparseCosine(textToVec(prev.claudeResponse), textToVec(curr.claudeResponse));
  const dB = 1 - sparseCosine(textToVec(prev.codexResponse), textToVec(curr.codexResponse));
  const dC = 1 - sparseCosine(textToVec(prev.openclawResponse), textToVec(curr.openclawResponse));
  return (dA + dB + dC) / 3;
}

// ── MoA 聚合 ──────────────────────────────────────────────────────────────────

async function moaAggregate(
  task: string,
  rounds: DebateRound[],
  patternSlugs: string[],
  claudeModel: string,
  timeoutMs: number,
): Promise<string> {
  const prompt = MOA_PROMPT(task, rounds, patternSlugs);
  return claudeRespond(prompt, claudeModel.replace("haiku", "sonnet"), timeoutMs);
}

// ── 主要導出：runDMAD ─────────────────────────────────────────────────────────

/**
 * 執行完整 DMAD 三代理辯論。
 *
 * @param task       任務描述
 * @param db         nuwa SQLite DB（供 OpenClaw 代理查詢 patterns）
 * @param opts       選項
 * @returns          DebateResult（含完整歷程 + MoA 最終答案）
 */
export async function runDMAD(
  task: string,
  db: Database.Database,
  opts: DMADOptions = {},
): Promise<DebateResult> {
  const {
    maxRounds = 3,
    convergenceThreshold = 0.93,
    varianceThreshold = 0.05,
    claudeModel = "claude-haiku-4-5",
    codexModel = "gpt-4.5",
    timeoutMs = 30_000,
  } = opts;

  const debateId = randomUUID();
  const startedAt = new Date().toISOString();
  const rounds: DebateRound[] = [];
  let allPatternSlugs: string[] = [];
  let stoppedBy: DebateResult["stoppedBy"] = "max_rounds";

  // ── Round 1：並行初始提案 ─────────────────────────────────────────────
  const [claudeR1, codexR1, openclawR1] = await Promise.all([
    claudeRespond(CLAUDE_ROLE_R1(task), claudeModel, timeoutMs),
    codexRespond(CODEX_ROLE_R1(task), codexModel, timeoutMs),
    openclawRespond(task, db, 1),
  ]);
  allPatternSlugs = [...new Set([...allPatternSlugs, ...openclawR1.patternSlugs])];

  const round1: DebateRound = {
    round: 1,
    claudeResponse: claudeR1,
    codexResponse: codexR1,
    openclawResponse: openclawR1.response,
    convergenceScore: 0, // 第一輪無法計算
  };
  round1.convergenceScore = measureConvergence(round1);
  rounds.push(round1);

  // ── Round 2-N ─────────────────────────────────────────────────────────
  for (let r = 2; r <= maxRounds; r++) {
    const prevRound = rounds[rounds.length - 1];

    // 停止條件 ①：收斂
    if (prevRound.convergenceScore > convergenceThreshold) {
      stoppedBy = "convergence";
      break;
    }

    const [claudeRn, codexRn, openclawRn] = await Promise.all([
      claudeRespond(
        CLAUDE_ROLE_R2(task, prevRound.codexResponse, prevRound.openclawResponse),
        claudeModel,
        timeoutMs,
      ),
      codexRespond(
        CODEX_ROLE_R2(task, prevRound.claudeResponse, prevRound.openclawResponse),
        codexModel,
        timeoutMs,
      ),
      openclawRespond(task, db, r, {
        claude: prevRound.claudeResponse,
        codex: prevRound.codexResponse,
      }),
    ]);
    allPatternSlugs = [...new Set([...allPatternSlugs, ...openclawRn.patternSlugs])];

    const currRound: DebateRound = {
      round: r,
      claudeResponse: claudeRn,
      codexResponse: codexRn,
      openclawResponse: openclawRn.response,
      convergenceScore: 0,
    };
    currRound.convergenceScore = measureConvergence(currRound);

    // 停止條件 ②：立場變化 < 5%
    const variance = measureVariance(prevRound, currRound);
    rounds.push(currRound);
    if (variance < varianceThreshold) {
      stoppedBy = "variance";
      break;
    }
  }

  // ── MoA 聚合 ──────────────────────────────────────────────────────────
  const finalAnswer = await moaAggregate(task, rounds, allPatternSlugs, claudeModel, timeoutMs * 2);

  const completedAt = new Date().toISOString();
  const finalConvergence = rounds[rounds.length - 1].convergenceScore;

  // ── 費用估算 ──────────────────────────────────────────────────────────
  // Haiku: ~$0.001/輪, MoA Sonnet: ~$0.003
  const estimatedCostUsd = Number.parseFloat((rounds.length * 0.001 + 0.003).toFixed(4));

  const result: DebateResult = {
    id: debateId,
    task,
    rounds,
    finalAnswer,
    convergenceScore: finalConvergence,
    totalRounds: rounds.length,
    stoppedBy,
    patternSlugsUsed: allPatternSlugs,
    estimatedCostUsd,
    startedAt,
    completedAt,
  };

  // ── 寫入 SQLite debates 表 ─────────────────────────────────────────────
  try {
    const hasDebates = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debates'")
      .get();

    if (hasDebates) {
      db.prepare(`
        INSERT OR IGNORE INTO debates
          (id, task, rounds_json, final_answer, convergence_score,
           rounds_count, stopped_by, pattern_slugs_used,
           estimated_cost_usd, started_at, completed_at)
        VALUES
          (@id, @task, @roundsJson, @finalAnswer, @convergenceScore,
           @roundsCount, @stoppedBy, @patternSlugsUsed,
           @estimatedCostUsd, @startedAt, @completedAt)
      `).run({
        id: debateId,
        task: task.slice(0, 500),
        roundsJson: JSON.stringify(rounds),
        finalAnswer: finalAnswer.slice(0, 2000),
        convergenceScore: finalConvergence,
        roundsCount: rounds.length,
        stoppedBy,
        patternSlugsUsed: JSON.stringify(allPatternSlugs),
        estimatedCostUsd,
        startedAt,
        completedAt,
      });
    }
  } catch {
    // debates 表不存在或寫入失敗，靜默略過
  }

  return result;
}
