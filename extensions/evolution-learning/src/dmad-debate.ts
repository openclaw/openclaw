/**
 * dmad-debate.ts — DMAD v2（Diversity-enhanced Multi-Agent Debate + 5-Pillar Self-Evolution）
 *
 * 三代理強制多角度辯論，配備永久自進化五柱架構。
 * 論文基礎：DMAD (ICLR'25) + M-MAD (ACL'25) + FREE-MAD 反順從機制
 *
 * 代理角色：
 *   Claude   → 語言理解與推理（呼叫 `claude -p --output-format json`）
 *   Codex    → 技術可行性（呼叫 `codex exec --json`）
 *   OpenClaw → Pattern 框架（本地 Ollama LLM，零 API 費用）
 *
 * 停止條件（任一滿足即停）：
 *   ① 語義收斂分 > 後端自適應閾值（Ollama: 0.82 / Xenova: 0.78 / TF-IDF: 0.32）
 *   ② 所有代理立場變化 < varianceThreshold（預設 0.05）
 *   ③ 已達最大 3 輪
 *
 * 五柱自進化系統：
 *   Pillar 1 先驗注入  — 語義搜尋歷史辯論，注入最相關先驗知識
 *   Pillar 2 自動校準  — EWMA 動態調整收斂閾值，後端自適應
 *   Pillar 3 答案驗證  — 四維度獨立驗證（正確性/完整性/一致性/具體性）
 *   Pillar 4 路由回饋  — 記錄路由決策信心度到 debates 表，供元學習分析
 *   Pillar 5 元學習    — 見 dmad-meta-learn.mts（每日校準）
 *
 * 費用模型：
 *   - Round 1：Claude Haiku × 1 + Codex × 1（OpenClaw Ollama 零費用）
 *   - Round 2+：Claude Haiku × 1 + Codex × 1（Ollama 零費用）
 *   - MoA 聚合：Claude Sonnet × 1
 *   - 總計：~$0.004–$0.012 per debate
 */

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type Database from "better-sqlite3";
import {
  cosineSimilarity,
  getEmbedder,
  semanticSearchPatterns,
  type Embedder,
} from "./embedding.js";

const execFileAsync = promisify(execFile);
const WINDOWS_UNSAFE_CMD_CHARS_RE = /[&|<>%\r\n]/;

function isWindowsCliHost(): boolean {
  return process.platform === "win32";
}

function escapeWindowsCmdArg(arg: string): string {
  if (WINDOWS_UNSAFE_CMD_CHARS_RE.test(arg)) {
    throw new Error(`Unsafe Windows cmd.exe argument detected: ${JSON.stringify(arg)}`);
  }
  const escaped = arg.replace(/\^/g, "^^");
  if (!escaped.includes(" ") && !escaped.includes('"')) {
    return escaped;
  }
  return `"${escaped.replace(/"/g, '""')}"`;
}

function buildWindowsCmdLine(command: string, args: readonly string[]): string {
  return [escapeWindowsCmdArg(command), ...args.map(escapeWindowsCmdArg)].join(" ");
}

function createAbortError(scope: string): Error & { code: string } {
  const err = new Error(`${scope} aborted`) as Error & { code: string };
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

function combinedAbortSignal(timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (!signal) {
    return timeoutSignal;
  }
  return AbortSignal.any([signal, timeoutSignal]);
}

function terminateChildProcess(child: ReturnType<typeof spawn>) {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        child.kill("SIGTERM");
      });
      return;
    } catch {
      // fall through to direct kill
    }
  }
  child.kill("SIGTERM");
}

function execWindowsCli(
  command: string,
  args: readonly string[],
  stdinText: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  if (signal?.aborted) {
    return Promise.reject(createAbortError(command));
  }

  return new Promise((resolve, reject) => {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", buildWindowsCmdLine(command, args)], {
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let settled = false;
    let timedOut = false;
    let aborted = false;
    const abortHandler = () => {
      aborted = true;
      terminateChildProcess(child);
    };
    const finish = (err: Error | null, stdout = "", stderr = "") => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortHandler);
      if (err) {
        reject(Object.assign(err, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminateChildProcess(child);
    }, timeoutMs);
    signal?.addEventListener("abort", abortHandler, { once: true });

    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk)));
    child.on("error", (err) => finish(err));
    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (aborted) {
        finish(createAbortError(command), stdout, stderr);
        return;
      }
      if (timedOut) {
        finish(
          Object.assign(new Error(`${command} timed out`), { code: "ETIMEDOUT" }),
          stdout,
          stderr,
        );
        return;
      }
      if (code !== 0) {
        finish(
          Object.assign(new Error(`${command} exited with code ${code ?? signal ?? "unknown"}`), {
            code,
          }),
          stdout,
          stderr,
        );
        return;
      }
      finish(null, stdout, stderr);
    });

    child.stdin.write(stdinText);
    child.stdin.end();
  });
}

function execCli(
  command: "claude" | "codex",
  args: readonly string[],
  opts: { stdinText?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<{ stdout: string; stderr: string }> {
  if (opts.signal?.aborted) {
    return Promise.reject(createAbortError(command));
  }
  if (isWindowsCliHost()) {
    return execWindowsCli(command, args, opts.stdinText ?? "", opts.timeoutMs, opts.signal);
  }
  return execFileAsync(command, [...args], { timeout: opts.timeoutMs, signal: opts.signal });
}

function isCliMissingError(err: unknown, command: "claude" | "codex"): boolean {
  const e = err as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
  // ENOENT = OS 層找不到執行檔（真正未安裝）
  if (e.code === "ENOENT") {
    return true;
  }
  // 只檢查 stderr 與錯誤訊息本身；不檢查 stdout（避免 Codex 回應內容誤觸發）
  // 注意：不要用寬鬆的 `not found`，否則會把 `thread ... not found` 誤判成未安裝。
  const diagText = `${e.stderr ?? ""}\n${e.message ?? ""}`.toLowerCase();
  const escapedCommand = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const missingPatterns = [
    new RegExp(`(?:'|")?${escapedCommand}(?:\\.cmd|\\.exe)?(?:'|")?\\s+is not recognized`),
    new RegExp(`(?:'|")?${escapedCommand}(?:\\.cmd|\\.exe)?(?:'|")?\\s*不是內部或外部命令`),
    new RegExp(`command not found(?::)?\\s*(?:'|")?${escapedCommand}(?:\\.cmd|\\.exe)?(?:'|")?`),
    new RegExp(`找不到(?:命令|檔案|程序).*(?:'|")?${escapedCommand}(?:\\.cmd|\\.exe)?(?:'|")?`),
    new RegExp(`(?:'|")?${escapedCommand}(?:\\.cmd|\\.exe)?(?:'|")?.*no such file or directory`),
  ];
  return missingPatterns.some((pattern) => pattern.test(diagText));
}

function stripUnsafeOutputChars(text: string): string {
  return Array.from(text, (char) => {
    const codePoint = char.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x08 ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x80 && codePoint <= 0xff)
    ) {
      return "";
    }
    return char;
  }).join("");
}

// ── 公開型別 ──────────────────────────────────────────────────────────────────

export type CliErrorCode = "claude_missing" | "claude_failed" | "codex_missing" | "codex_failed";

export interface CliErrorSummary {
  claudeMissing: number;
  claudeFailed: number;
  codexMissing: number;
  codexFailed: number;
}

export type DebateQualityStatus = "pass" | "degraded_agents";

export interface DebateRoundTimingsMs {
  claude: number;
  codex: number;
  openclaw: number;
  convergence: number;
  stability: number;
  total: number;
}

export interface DebatePhaseTimingsMs {
  embedder: number;
  routing: number;
  priorSearch: number;
  rounds: number;
  moa: number;
  verification: number;
  trajectory: number;
  dbWrite: number;
  total: number;
}

export type DmadProgressPhase =
  | "embedder"
  | "routing"
  | "priorSearch"
  | "agent"
  | "convergence"
  | "stability"
  | "moa"
  | "verification"
  | "trajectory"
  | "dbWrite";

export type DmadProgressStatus = "start" | "complete" | "error";
export type DmadProgressAgent = "claude" | "codex" | "openclaw";

export interface DmadProgressEvent {
  phase: DmadProgressPhase;
  status: DmadProgressStatus;
  at: string;
  round?: number;
  agent?: DmadProgressAgent;
  durationMs?: number;
  error?: string;
}

export type DmadProgressHandler = (event: DmadProgressEvent) => void;

export interface DebateRound {
  round: number;
  claudeResponse: string;
  codexResponse: string;
  openclawResponse: string;
  convergenceScore: number; // 語義向量 pairwise cosine 均值
  stabilityScore: number; // 與上一輪同代理回應的平均 cosine；第一輪固定 0
  hadCliError: boolean; // 本輪 Claude/Codex CLI 是否降級
  cliErrors: CliErrorCode[];
  timingsMs: DebateRoundTimingsMs;
}

export interface DebateResult {
  id: string;
  task: string;
  rounds: DebateRound[];
  finalAnswer: string;
  convergenceScore: number;
  totalRounds: number;
  stoppedBy: "convergence" | "variance" | "max_rounds";
  patternSlugsUsed: string[];
  hadCliError: boolean;
  cliErrorSummary: CliErrorSummary;
  qualityStatus: DebateQualityStatus;
  degradedReason: string | null;
  /** 各代理貢獻獨特性分（歸一化，越高越獨特）*/
  trajectoryScores: { claude: number; codex: number; openclaw: number };
  phaseTimingsMs: DebatePhaseTimingsMs;
  estimatedCostUsd: number;
  startedAt: string;
  completedAt: string;
}

export interface DMADOptions {
  maxRounds?: number; // 預設 3
  convergenceThreshold?: number; // 若未指定，由 autoCalibrate 動態決定
  varianceThreshold?: number; // 預設 0.05
  claudeModel?: string; // 預設 claude-haiku-4-5
  codexModel?: string; // 預設 gpt-4.5
  ollamaUrl?: string; // OpenClaw 本地 URL（預設 http://localhost:11434）
  ollamaModel?: string; // Ollama 對話模型（預設 qwen3:14b）
  timeoutMs?: number; // 每次 CLI 呼叫 timeout，預設 30000
  moaTimeoutMs?: number; // MoA 聚合 timeout，預設 min(timeoutMs, 15000)
  verificationTimeoutMs?: number; // 驗證 timeout，預設 min(timeoutMs, 10000)
  allowMoaFallback?: boolean; // MoA 逾時時是否用 fallback 答案繼續，預設 true
  allowVerificationFallback?: boolean; // 驗證逾時時是否用 fallback 驗證繼續，預設 true
  skipRouting?: boolean; // 跳過 MasRouter 路由，直接全 MoA
  systemContext?: string; // 系統背景知識注入（R1 提示前置）
  onProgress?: DmadProgressHandler; // 可選進度事件，用於 timeout 診斷
  abortSignal?: AbortSignal; // 可選取消訊號，用於外層 timeout 中止 child process
}

// ── Pillar 類型定義 ───────────────────────────────────────────────────────────

export interface RouteDecision {
  domain: "technical" | "language" | "mixed" | "unknown";
  confidence: "high" | "medium" | "low";
  reason: string;
}

type RcrRole = "language" | "technical" | "pattern";

interface PriorDebate {
  task: string;
  finalAnswer: string;
  convergenceScore: number;
  semanticScore: number;
}

interface VerificationResult {
  pass: boolean;
  confidence: number; // 0-1 均值
  criteria: {
    correctness: number; // 正確性 0-1
    completeness: number; // 完整性 0-1
    consistency: number; // 一致性 0-1
    specificity: number; // 具體性 0-1
  };
  feedback: string;
}

// ── MasRouter v2：前置任務路由（比例信心分）──────────────────────────────────

const ROUTE_TECH_RE =
  /程式|code|bug|fix|implement|api|函數|class|typescript|javascript|script|測試|test|debug|lint|compile|build|deploy|schema|migration|refactor|pr|commit|patch|error|exception|架構|architecture|database|資料庫|效能|performance|型別|type|interface|module|dependency/i;

const ROUTE_LANG_RE =
  /策略|分析|評估|建議|如何|為什麼|意見|報告|文件|規劃|explain|design|review|analyze|recommend|describe|summarize|compare|should|why|what|when|how|plan|assess|evaluate|document|guideline|principle|concept|theory|目標|objective|meaning|purpose/i;

function countRouteMatches(task: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  return [...task.matchAll(new RegExp(pattern.source, flags))].length;
}

/**
 * MasRouter v2 — 比例式信心分
 * techRatio ≥ 0.8 → high-confidence technical
 * langRatio ≥ 0.8 → high-confidence language
 * 60-79% → medium；其他 → mixed/low
 */
export function routeTask(task: string): RouteDecision {
  const techMatches = countRouteMatches(task, ROUTE_TECH_RE);
  const langMatches = countRouteMatches(task, ROUTE_LANG_RE);
  const total = techMatches + langMatches;

  if (total === 0) {
    return { domain: "unknown", confidence: "low", reason: "無明確域關鍵字" };
  }

  const techRatio = techMatches / total;
  const langRatio = langMatches / total;

  if (techRatio >= 0.8) {
    return {
      domain: "technical",
      confidence: "high",
      reason: `技術詞佔 ${Math.round(techRatio * 100)}%`,
    };
  }
  if (langRatio >= 0.8) {
    return {
      domain: "language",
      confidence: "high",
      reason: `語言詞佔 ${Math.round(langRatio * 100)}%`,
    };
  }
  if (techRatio >= 0.6) {
    return {
      domain: "technical",
      confidence: "medium",
      reason: `技術詞略主導（${techMatches} vs ${langMatches}）`,
    };
  }
  if (langRatio >= 0.6) {
    return {
      domain: "language",
      confidence: "medium",
      reason: `語言詞略主導（${langMatches} vs ${techMatches}）`,
    };
  }
  return {
    domain: "mixed",
    confidence: "low",
    reason: `均衡混合（技術 ${techMatches} vs 語言 ${langMatches}）`,
  };
}

// ── RCR v2：角色感知上下文壓縮（BM25-style 相關度排序）───────────────────────

const RCR_KEYWORDS: Record<RcrRole, RegExp> = {
  language:
    /推理|意圖|邏輯|語義|使用者|需求|抽象|概念|策略|目標|purpose|reason|intent|logic|semantic|user|requirement|abstract|concept|strategy|understand|explain|goal|why|objective|meaning/i,
  technical:
    /程式|架構|實作|API|函數|效能|資料庫|schema|code|architecture|implement|function|performance|database|efficiency|error|bug|fix|deploy|build|test|type|interface|module|dependency/i,
  pattern:
    /框架|模式|歷史|案例|慣例|先例|實踐|pattern|template|framework|history|convention|precedent|practice|example|model|principle|guideline|standard/i,
};

/** 智慧句子分割（避免切割版本號如 v3.0、3.14）*/
function splitSentences(text: string): string[] {
  const cjkParts = text
    .split(/[。！？…]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (cjkParts.length > 1) {
    return cjkParts;
  }
  return text
    .split(/(?<![0-9])\.(?![0-9])/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * RCR v2 — BM25-style 角色感知壓縮
 * 每句計算 matchCount / √wordCount，選取最相關的 50%，
 * 強制包含前 minSentences 句作為上下文保底。
 */
function rcr(text: string, receiverRole: RcrRole, minSentences = 2): string {
  const sentences = splitSentences(text);
  if (sentences.length <= minSentences) {
    return text;
  }

  const roleRe = RCR_KEYWORDS[receiverRole];
  const scored = sentences.map((s) => {
    const wordCount = s.split(/\s+/).filter(Boolean).length || 1;
    const matchCount = (s.match(roleRe) ?? []).length;
    return { s, score: matchCount / Math.sqrt(wordCount) };
  });

  const keepCount = Math.max(minSentences, Math.ceil(sentences.length * 0.5));
  const topByScore = new Set(
    scored
      .toSorted((a, b) => b.score - a.score)
      .slice(0, keepCount)
      .map((x) => x.s),
  );
  // 強制包含前 minSentences 句（保底語境）
  for (let i = 0; i < Math.min(minSentences, sentences.length); i++) {
    topByScore.add(sentences[i]);
  }

  const kept = sentences.filter((s) => topByScore.has(s));
  return kept.join(text.includes("。") ? "。" : " ") || text.slice(0, 300);
}

// ── 角色提示模板 v2（擴大上下文 + 反順從強制指令）────────────────────────────

function buildContextPrefix(systemContext?: string, priorContext?: string): string {
  const parts: string[] = [];
  if (systemContext) {
    parts.push(`## 系統背景\n${systemContext.slice(0, 600)}`);
  }
  if (priorContext) {
    parts.push(`## 相關先驗知識\n${priorContext}`);
  }
  return parts.length > 0 ? parts.join("\n\n") + "\n\n" : "";
}

const CLAUDE_ROLE_R1 = (task: string, prefix?: string) =>
  `${prefix ?? ""}你是語言理解與推理代理（Claude）。
請從**語言邏輯、使用者意圖、抽象推理**角度分析以下任務，提出初始方案。
不超過 250 字。嚴禁模糊答案，必須給出具體方向。

任務：${task}`;

const CODEX_ROLE_R1 = (task: string, prefix?: string) =>
  `${prefix ?? ""}你是技術可行性代理（Codex）。
請從**程式碼實作、技術架構、效能邊界**角度審查以下任務，提出技術可行性評估。
不超過 250 字。必須指出具體實作路徑或技術風險。

任務：${task}`;

const CLAUDE_ROLE_R2 = (task: string, codex: string, openclaw: string) =>
  `你是語言理解與推理代理（Claude）。

## 其他代理觀點摘要
[Codex 技術觀點]：${rcr(codex, "language", 3).slice(0, 600)}
[OpenClaw Pattern 觀點]：${rcr(openclaw, "language", 2).slice(0, 400)}

## 任務
${task}

## 重要指令
**明確標出你與上方觀點的分歧點**（不得直接附和或重複已有論點）。
從語言推理和使用者意圖層面補充新論點。不超過 180 字。`;

const CODEX_ROLE_R2 = (task: string, claude: string, openclaw: string) =>
  `你是技術可行性代理（Codex）。

## 其他代理觀點摘要
[Claude 推理觀點]：${rcr(claude, "technical", 3).slice(0, 600)}
[OpenClaw Pattern 觀點]：${rcr(openclaw, "technical", 2).slice(0, 400)}

## 任務
${task}

## 重要指令
**明確指出技術上與上方觀點的矛盾或補充**（不得重複已有論點）。
指出具體實作細節或技術風險。不超過 180 字。`;

const OPENCLAW_ROLE_R2 = (task: string, claude: string, codex: string, patterns: string) =>
  `你是 OpenClaw Pattern 代理，專精從歷史框架和設計模式分析問題。

## 已激活的 Pattern 框架
${patterns || "（無匹配框架）"}

## 其他代理觀點
[Claude 語言分析]：${rcr(claude, "pattern", 2).slice(0, 500)}
[Codex 技術評估]：${rcr(codex, "pattern", 2).slice(0, 500)}

## 任務
${task}

## 重要指令
從 Pattern 框架角度**指出哪些歷史慣例或設計模式與此任務相關**。
標出你的獨特貢獻（不得只附和 Claude 或 Codex），不超過 180 字。`;

/** Round 3（最後一輪）：合成導向提示，鼓勵整合前兩輪觀點達成收斂 */
const CLAUDE_ROLE_R3 = (task: string, codex: string, openclaw: string) =>
  `你是語言理解與推理代理（Claude）。此為最終辯論輪次。

## 前兩輪觀點摘要
[Codex 技術立場]：${rcr(codex, "language", 3).slice(0, 500)}
[OpenClaw Pattern 立場]：${rcr(openclaw, "language", 2).slice(0, 300)}

## 任務
${task}

## 最終輪指令
整合三方觀點，提出**可被三方接受的最終立場**：
1. 採納 Codex 和 OpenClaw 中有充分論據的部分
2. 放棄純重複性爭議
3. 用清晰的語言表達共識核心（不超過 200 字）
避免重申分歧，聚焦在「我們都同意什麼」。`;

const CODEX_ROLE_R3 = (task: string, claude: string, openclaw: string) =>
  `你是技術可行性代理（Codex）。此為最終辯論輪次。

## 前兩輪觀點摘要
[Claude 推理立場]：${rcr(claude, "technical", 3).slice(0, 500)}
[OpenClaw Pattern 立場]：${rcr(openclaw, "technical", 2).slice(0, 300)}

## 任務
${task}

## 最終輪指令
整合三方技術觀點，提出**可被三方接受的技術共識**：
1. 採納 Claude 和 OpenClaw 中技術上合理的部分
2. 放棄純實作細節爭議
3. 指出具體可行的技術路徑（不超過 200 字）
聚焦在「技術上什麼是可行且被共識的」。`;

const OPENCLAW_ROLE_R3 = (task: string, claude: string, codex: string, patterns: string) =>
  `你是 OpenClaw Pattern 代理。此為最終辯論輪次。

## 已激活的 Pattern 框架
${patterns || "（無匹配框架）"}

## 前兩輪觀點摘要
[Claude 語言立場]：${rcr(claude, "pattern", 2).slice(0, 400)}
[Codex 技術立場]：${rcr(codex, "pattern", 2).slice(0, 400)}

## 任務
${task}

## 最終輪指令
從 Pattern 框架角度提出**整合三方的最終框架**：
1. 哪個 Pattern 最能統一三方觀點
2. 採納各方最強的框架洞察
3. 輸出簡潔的最終 Pattern 建議（不超過 200 字）
避免重申差異，聚焦在「什麼框架可以解決這個問題」。`;

const MOA_PROMPT = (task: string, rounds: DebateRound[], patterns: string[]) =>
  `你是 MoA（Mixture of Agents）聚合器，整合三代理多輪辯論輸出最終高品質答案。

## 原始任務
${task}

## 辯論歷程（${rounds.length} 輪）
${rounds
  .map(
    (r, i) => `
### 第 ${i + 1} 輪（收斂分：${r.convergenceScore.toFixed(3)}）
[Claude]   ${r.claudeResponse.slice(0, 400)}
[Codex]    ${r.codexResponse.slice(0, 400)}
[OpenClaw] ${r.openclawResponse.slice(0, 400)}
`,
  )
  .join("\n")}

## 激活的 Pattern 框架
${patterns.length > 0 ? patterns.join("\n") : "（無激活框架）"}

## 輸出格式（必須完整填寫）
**1. 最終建議方案**（400 字以內）：整合三代理最強論點，解決矛盾，給出具體可執行行動。

**2. 論點採用說明**：
- Claude 貢獻：[具體採用哪些推理觀點]
- Codex 貢獻：[具體採用哪些技術觀點]
- OpenClaw 貢獻：[具體採用哪些框架觀點]
- 放棄的觀點：[為何放棄]

**3. 信心評分**（0-1）：[分數] | 理由：[一句話]`;

// ── OpenClaw 代理（Ollama 本地 LLM）──────────────────────────────────────────

async function openclawRespond(
  task: string,
  db: Database.Database,
  round: number,
  ollamaUrl: string,
  ollamaModel: string,
  prevContext?: { claude: string; codex: string; isFinalRound?: boolean },
  signal?: AbortSignal,
): Promise<{ response: string; patternSlugs: string[] }> {
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
    /* FTS5 不可用 */
  }

  if (patterns.length === 0) {
    patterns = db
      .prepare(`
      SELECT slug, target, context, mental_models
      FROM patterns WHERE frozen = 0
      ORDER BY decay_score DESC LIMIT 3
    `)
      .all() as PatternRow[];
  }

  const patternSlugs = patterns.map((p) => p.slug);
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

  // Round 1：固定 pattern 摘要回應（快速、節省 Ollama 資源）
  if (round === 1 || !prevContext) {
    return {
      response:
        patterns.length > 0
          ? `從歷史框架看：\n${patternSummary}\n\n建議優先套用「${patterns[0].slug}」框架：${task.slice(0, 120)}`
          : `目前無相關 pattern，建議先蒸餾此任務框架。任務：${task.slice(0, 120)}`,
      patternSlugs,
    };
  }

  // Round 2+：呼叫 Ollama LLM 進行真實推理（最後一輪用合成提示）
  try {
    const prompt = prevContext.isFinalRound
      ? OPENCLAW_ROLE_R3(task, prevContext.claude, prevContext.codex, patternSummary)
      : OPENCLAW_ROLE_R2(task, prevContext.claude, prevContext.codex, patternSummary);
    const res = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        prompt,
        stream: false,
        options: { temperature: 0.7, num_predict: 350 },
      }),
      signal: combinedAbortSignal(28_000, signal),
    });
    if (res.ok) {
      const json = (await res.json()) as { response?: string };
      if (json.response) {
        return { response: json.response.trim().slice(0, 550), patternSlugs };
      }
    }
  } catch {
    /* Ollama 不可用，進入 fallback */
  }

  // Fallback：模板回應（Ollama 離線時）
  return {
    response:
      `Pattern 視角（${patternSlugs.join(", ") || "無匹配"}）：基於「${patterns[0]?.target ?? "未知框架"}」，` +
      `Claude 強調「${prevContext.claude.slice(0, 120)}」，Codex 指出「${prevContext.codex.slice(0, 120)}」。` +
      `建議整合雙方觀點並以框架原則驗證可行性。`,
    patternSlugs,
  };
}

// ── Claude CLI 代理 ───────────────────────────────────────────────────────────

async function claudeRespond(
  prompt: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  try {
    const { stdout } = isWindowsCliHost()
      ? await execCli("claude", ["--print", "--output-format", "json", "--model", model, "-"], {
          stdinText: prompt,
          timeoutMs,
          signal,
        })
      : await execCli("claude", ["-p", prompt, "--output-format", "json", "--model", model], {
          timeoutMs,
          signal,
        });
    const json = JSON.parse(stdout) as { result?: string; content?: string };
    return json.result ?? json.content ?? stdout.slice(0, 600);
  } catch (err: unknown) {
    if (isCliMissingError(err, "claude")) {
      return "[Claude CLI 未安裝，請執行 npm install -g @anthropic-ai/claude-code]";
    }
    return `[Claude 呼叫失敗：${String(err).slice(0, 120)}]`;
  }
}

// ── Codex CLI 代理 ────────────────────────────────────────────────────────────

async function codexRespond(
  prompt: string,
  model: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const execCodexOnce = async (attemptTimeoutMs: number): Promise<string> => {
    const { stdout } = isWindowsCliHost()
      ? await execCli("codex", ["exec", "--model", model, "--json", "-"], {
          stdinText: prompt,
          timeoutMs: attemptTimeoutMs,
          signal,
        })
      : await execCli("codex", ["exec", "--model", model, "--json", prompt], {
          timeoutMs: attemptTimeoutMs,
          signal,
        });
    const lines = stdout.split("\n").filter(Boolean);
    // Codex CLI v0.128+ 格式：item.completed → item.text（從後往前取第一個有效回應）
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const ev = JSON.parse(lines[i]) as {
          type?: string;
          item?: { type?: string; text?: string };
          payload?: { content?: string };
        };
        // 新格式（v0.128+）
        if (ev.type === "item.completed" && ev.item?.type === "agent_message" && ev.item.text) {
          return ev.item.text;
        }
        // 舊格式 fallback
        if (ev.type === "turn.completed" && ev.payload?.content) {
          return ev.payload.content;
        }
      } catch {
        /* skip */
      }
    }
    // 都找不到時回傳原始輸出（去掉 PID 亂碼行）
    const cleanLines = lines.filter((l) => {
      try {
        JSON.parse(l);
        return true;
      } catch {
        return false;
      }
    });
    return (
      cleanLines
        .map((l) => {
          try {
            const ev = JSON.parse(l) as { type?: string; item?: { text?: string } };
            return ev.item?.text ?? "";
          } catch {
            return "";
          }
        })
        .filter(Boolean)
        .join("\n")
        .slice(0, 600) || stripUnsafeOutputChars(stdout).slice(0, 600)
    );
  };

  try {
    return await execCodexOnce(timeoutMs);
  } catch (err: unknown) {
    if (isCliMissingError(err, "codex")) {
      return "[Codex CLI 未安裝，請執行 npm install -g @openai/codex]";
    }
    if (isTimeoutOrAbortError(err)) {
      const retryTimeoutMs = Math.min(
        120_000,
        Math.max(timeoutMs + 5000, Math.floor(timeoutMs * 1.6)),
      );
      try {
        return await execCodexOnce(retryTimeoutMs);
      } catch (retryErr: unknown) {
        if (isCliMissingError(retryErr, "codex")) {
          return "[Codex CLI 未安裝，請執行 npm install -g @openai/codex]";
        }
        return `[Codex 呼叫失敗：${String(retryErr).slice(0, 120)} | retry_timeout_ms=${retryTimeoutMs}]`;
      }
    }
    return `[Codex 呼叫失敗：${String(err).slice(0, 120)}]`;
  }
}

function detectRoundCliErrors(round: Pick<DebateRound, "claudeResponse" | "codexResponse">) {
  const errors: CliErrorCode[] = [];
  if (round.claudeResponse.includes("Claude CLI 未安裝")) {
    errors.push("claude_missing");
  } else if (round.claudeResponse.includes("Claude 呼叫失敗")) {
    errors.push("claude_failed");
  }
  if (round.codexResponse.includes("Codex CLI 未安裝")) {
    errors.push("codex_missing");
  } else if (round.codexResponse.includes("Codex 呼叫失敗")) {
    errors.push("codex_failed");
  }
  return errors;
}

function annotateCliErrors(round: DebateRound): DebateRound {
  round.cliErrors = detectRoundCliErrors(round);
  round.hadCliError = round.cliErrors.length > 0;
  return round;
}

function summarizeCliErrors(rounds: DebateRound[]): CliErrorSummary {
  const summary: CliErrorSummary = {
    claudeMissing: 0,
    claudeFailed: 0,
    codexMissing: 0,
    codexFailed: 0,
  };
  for (const round of rounds) {
    for (const error of new Set(round.cliErrors)) {
      if (error === "claude_missing") {
        summary.claudeMissing++;
      }
      if (error === "claude_failed") {
        summary.claudeFailed++;
      }
      if (error === "codex_missing") {
        summary.codexMissing++;
      }
      if (error === "codex_failed") {
        summary.codexFailed++;
      }
    }
  }
  return summary;
}

function degradedReasonFromCliSummary(summary: CliErrorSummary): string | null {
  const parts = [
    ["claude_missing", summary.claudeMissing],
    ["claude_failed", summary.claudeFailed],
    ["codex_missing", summary.codexMissing],
    ["codex_failed", summary.codexFailed],
  ]
    .filter(([, count]) => Number(count) > 0)
    .map(([code, count]) => `${code}=${count}`);
  return parts.length > 0 ? parts.join(",") : null;
}

// ── 收斂偵測（語義向量版，含 bigram fallback）────────────────────────────────

/**
 * 後端自適應收斂閾值（基於 7 場真實辯論校準）
 * - ollama: 實際觀測最高 0.681，設 0.65 可讓 Round 3 達成真正收斂
 * - xenova: 語義空間略緊，設 0.62
 * - tfidf:  詞頻向量空間較寬鬆，維持 0.32
 */
function thresholdForBackend(backend: Embedder["backend"]): number {
  return { ollama: 0.65, xenova: 0.62, tfidf: 0.32 }[backend];
}

/** Bigram 向量（embedder 失敗時的 fallback）*/
function bigramVec(text: string): Map<string, number> {
  const chars = text.replace(/\s+/g, "").slice(0, 400);
  const v = new Map<string, number>();
  for (let i = 0; i < chars.length - 1; i++) {
    const bi = chars.slice(i, i + 2);
    v.set(bi, (v.get(bi) ?? 0) + 1);
  }
  return v;
}

function sparseCosineMaps(a: Map<string, number>, b: Map<string, number>): number {
  const vocab = [...new Set([...a.keys(), ...b.keys()])];
  return cosineSimilarity(
    vocab.map((k) => a.get(k) ?? 0),
    vocab.map((k) => b.get(k) ?? 0),
  );
}

/** Bigram cosine fallback（3-way 均值）*/
function bigramConvergence(r: DebateRound): number {
  const va = bigramVec(r.claudeResponse);
  const vb = bigramVec(r.codexResponse);
  const vc = bigramVec(r.openclawResponse);
  return (sparseCosineMaps(va, vb) + sparseCosineMaps(vb, vc) + sparseCosineMaps(va, vc)) / 3;
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(1, value));
}

function elapsedMs(startMs: number): number {
  return Math.max(0, Date.now() - startMs);
}

function emitProgress(onProgress: DmadProgressHandler | undefined, event: DmadProgressEvent) {
  if (!onProgress) {
    return;
  }
  try {
    onProgress(event);
  } catch {
    /* progress observers must not affect debate execution */
  }
}

async function timedAsync<T>(
  fn: () => Promise<T>,
  progress?: {
    onProgress?: DmadProgressHandler;
    phase: DmadProgressPhase;
    round?: number;
    agent?: DmadProgressAgent;
  },
): Promise<{ value: T; durationMs: number }> {
  const startMs = Date.now();
  emitProgress(progress?.onProgress, {
    phase: progress?.phase ?? "agent",
    status: "start",
    at: new Date().toISOString(),
    round: progress?.round,
    agent: progress?.agent,
  });
  try {
    const value = await fn();
    const durationMs = elapsedMs(startMs);
    emitProgress(progress?.onProgress, {
      phase: progress?.phase ?? "agent",
      status: "complete",
      at: new Date().toISOString(),
      round: progress?.round,
      agent: progress?.agent,
      durationMs,
    });
    return { value, durationMs };
  } catch (err) {
    const durationMs = elapsedMs(startMs);
    emitProgress(progress?.onProgress, {
      phase: progress?.phase ?? "agent",
      status: "error",
      at: new Date().toISOString(),
      round: progress?.round,
      agent: progress?.agent,
      durationMs,
      error: String(err).slice(0, 160),
    });
    throw err;
  }
}

/** 語義向量收斂分（平均 pairwise cosine，embedder 失敗時回退 bigram）*/
async function measureConvergence(r: DebateRound, embedder: Embedder): Promise<number> {
  try {
    const [va, vb, vc] = await Promise.all([
      embedder.embed(r.claudeResponse.slice(0, 600)),
      embedder.embed(r.codexResponse.slice(0, 600)),
      embedder.embed(r.openclawResponse.slice(0, 600)),
    ]);
    const ab = cosineSimilarity(va, vb);
    const bc = cosineSimilarity(vb, vc);
    const ac = cosineSimilarity(va, vc);
    return (ab + bc + ac) / 3;
  } catch {
    return bigramConvergence(r);
  }
}

/** 前後兩輪立場變化量（各代理自身 cosine 距離均值）*/
async function measureVariance(
  prev: DebateRound,
  curr: DebateRound,
  embedder: Embedder,
): Promise<number> {
  try {
    const [pA, pB, pC, cA, cB, cC] = await Promise.all([
      embedder.embed(prev.claudeResponse.slice(0, 400)),
      embedder.embed(prev.codexResponse.slice(0, 400)),
      embedder.embed(prev.openclawResponse.slice(0, 400)),
      embedder.embed(curr.claudeResponse.slice(0, 400)),
      embedder.embed(curr.codexResponse.slice(0, 400)),
      embedder.embed(curr.openclawResponse.slice(0, 400)),
    ]);
    return (
      (1 -
        cosineSimilarity(pA, cA) +
        (1 - cosineSimilarity(pB, cB)) +
        (1 - cosineSimilarity(pC, cC))) /
      3
    );
  } catch {
    const dA = 1 - sparseCosineMaps(bigramVec(prev.claudeResponse), bigramVec(curr.claudeResponse));
    const dB = 1 - sparseCosineMaps(bigramVec(prev.codexResponse), bigramVec(curr.codexResponse));
    const dC =
      1 - sparseCosineMaps(bigramVec(prev.openclawResponse), bigramVec(curr.openclawResponse));
    return (dA + dB + dC) / 3;
  }
}

/** 各代理貢獻獨特性分（1 - 與其他兩者的平均相似度，再歸一化）*/
async function measureTrajectoryScores(
  rounds: DebateRound[],
  embedder: Embedder,
): Promise<DebateResult["trajectoryScores"]> {
  if (rounds.length === 0) {
    return { claude: 0.333, codex: 0.333, openclaw: 0.333 };
  }
  const last = rounds[rounds.length - 1];
  try {
    const [va, vb, vc] = await Promise.all([
      embedder.embed(last.claudeResponse.slice(0, 600)),
      embedder.embed(last.codexResponse.slice(0, 600)),
      embedder.embed(last.openclawResponse.slice(0, 600)),
    ]);
    const claudeU = 1 - (cosineSimilarity(va, vb) + cosineSimilarity(va, vc)) / 2;
    const codexU = 1 - (cosineSimilarity(vb, va) + cosineSimilarity(vb, vc)) / 2;
    const oclawU = 1 - (cosineSimilarity(vc, va) + cosineSimilarity(vc, vb)) / 2;
    const total = Math.max(claudeU + codexU + oclawU, 1e-9);
    return {
      claude: Number((claudeU / total).toFixed(4)),
      codex: Number((codexU / total).toFixed(4)),
      openclaw: Number((oclawU / total).toFixed(4)),
    };
  } catch {
    return { claude: 0.333, codex: 0.333, openclaw: 0.333 };
  }
}

// ── Pillar 1：跨辯論先驗注入（語義搜尋）─────────────────────────────────────

async function searchPriorDebates(
  task: string,
  db: Database.Database,
  topK = 1,
): Promise<PriorDebate[]> {
  try {
    const hasDebates = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debates'")
      .get();
    if (!hasDebates) {
      return [];
    }

    type Row = { task: string; final_answer: string; convergence_score: number };
    const rows = db
      .prepare(`
      SELECT task, final_answer, convergence_score
      FROM debates
      WHERE convergence_score > 0.1
      ORDER BY started_at DESC
      LIMIT 20
    `)
      .all() as Row[];

    if (rows.length === 0) {
      return [];
    }

    const candidates = rows.map((r) => ({
      slug: r.task.slice(0, 40),
      text: r.task,
    }));
    const results = await semanticSearchPatterns(task, candidates, topK);

    return results
      .filter((r) => r.score > 0.45)
      .map((r) => {
        const idx = candidates.findIndex((c) => c.slug === r.slug);
        const row = rows[idx];
        return row
          ? {
              task: row.task,
              finalAnswer: row.final_answer,
              convergenceScore: row.convergence_score,
              semanticScore: r.score,
            }
          : null;
      })
      .filter((x): x is PriorDebate => x !== null);
  } catch {
    return [];
  }
}

// ── Pillar 2：自動校準（EWMA + 後端自適應）──────────────────────────────────

function autoCalibrate(db: Database.Database, embedderBackend: Embedder["backend"]): number {
  const backendDefault = thresholdForBackend(embedderBackend);
  try {
    const hasDebates = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debates'")
      .get();
    if (!hasDebates) {
      return backendDefault;
    }

    const rows = db
      .prepare(`
      SELECT convergence_score FROM debates
      ORDER BY started_at DESC LIMIT 30
    `)
      .all() as { convergence_score: number }[];

    if (rows.length < 5) {
      return backendDefault;
    }

    // 指數加權移動平均（α=0.15，新資料權重更高）
    let ewma = rows[0].convergence_score;
    for (let i = 1; i < rows.length; i++) {
      ewma = 0.15 * rows[i].convergence_score + 0.85 * ewma;
    }

    // 建議閾值 = EWMA × 0.92，限制在後端合理範圍 [0.7×default, 1.15×default]
    const lo = backendDefault * 0.7;
    const hi = backendDefault * 1.15;
    return Number(Math.max(lo, Math.min(hi, ewma * 0.92)).toFixed(4));
  } catch {
    return backendDefault;
  }
}

// ── Pillar 3：四維度答案驗證 ──────────────────────────────────────────────────

async function verifyAnswer(
  task: string,
  answer: string,
  claudeModel: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<VerificationResult> {
  const prompt = `你是獨立驗證代理。請用四個維度評估以下答案的品質：

## 原始任務
${task}

## 待驗證答案
${answer.slice(0, 800)}

## 評估維度（各 0-1 分）
1. 正確性（correctness）：事實/邏輯是否正確？
2. 完整性（completeness）：是否涵蓋任務所有關鍵面向？
3. 一致性（consistency）：答案內部邏輯是否自洽？
4. 具體性（specificity）：是否給出具體可執行方向（非泛泛而談）？

## 嚴格輸出格式（JSON only，無任何說明文字）
{"correctness":0.0,"completeness":0.0,"consistency":0.0,"specificity":0.0,"feedback":"主要問題一句話"}`;

  try {
    const raw = await claudeRespond(prompt, claudeModel, timeoutMs, signal);
    const m = raw.match(/\{[\s\S]*?\}/);
    if (!m) {
      throw new Error("no JSON");
    }
    const p = JSON.parse(m[0]) as Partial<VerificationResult["criteria"] & { feedback: string }>;
    const criteria = {
      correctness: p.correctness ?? 0.5,
      completeness: p.completeness ?? 0.5,
      consistency: p.consistency ?? 0.5,
      specificity: p.specificity ?? 0.5,
    };
    const confidence =
      (criteria.correctness + criteria.completeness + criteria.consistency + criteria.specificity) /
      4;
    return {
      pass: confidence >= 0.6,
      confidence: Number(confidence.toFixed(4)),
      criteria,
      feedback: p.feedback ?? "驗證完成",
    };
  } catch {
    return {
      pass: true,
      confidence: 0.5,
      criteria: { correctness: 0.5, completeness: 0.5, consistency: 0.5, specificity: 0.5 },
      feedback: "驗證解析失敗，預設通過",
    };
  }
}

// ── Pillar 4：確保 debates 表包含 5-pillar 欄位 ──────────────────────────────

function ensureDebatesColumns(db: Database.Database): void {
  const add = (col: string, type: string) => {
    try {
      db.prepare(`ALTER TABLE debates ADD COLUMN ${col} ${type}`).run();
    } catch {
      /* 已存在 */
    }
  };
  add("route_confidence", "TEXT");
  add("verify_pass", "INTEGER");
  add("verify_confidence", "REAL");
  add("prior_injected", "INTEGER");
  add("calibrated_threshold", "REAL");
  add("trajectory_scores", "TEXT");
}

// ── DTE 進化：辯論驅動 Pattern 強化 ──────────────────────────────────────────

function evolveDmadPatterns(db: Database.Database, winnerSlug: string): void {
  try {
    db.prepare(`
      UPDATE patterns
      SET decay_score = MIN(1.0, decay_score + 0.05), updated_at = datetime('now')
      WHERE slug = ?
    `).run(winnerSlug);
  } catch {
    /* patterns 表操作失敗，靜默略過 */
  }
}

// ── MoA 聚合 ─────────────────────────────────────────────────────────────────

async function moaAggregate(
  task: string,
  rounds: DebateRound[],
  patternSlugs: string[],
  claudeModel: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  const sonetModel = claudeModel.includes("sonnet")
    ? claudeModel
    : claudeModel.replace("haiku", "sonnet");
  return claudeRespond(MOA_PROMPT(task, rounds, patternSlugs), sonetModel, timeoutMs, signal);
}

function errorSummary(err: unknown): string {
  const e = err as { message?: unknown; code?: unknown } | null | undefined;
  const message = typeof e?.message === "string" ? e.message : typeof err === "string" ? err : "";
  const code = typeof e?.code === "string" ? e.code : "";
  return [code, message].filter(Boolean).join(":").slice(0, 200);
}

function isTimeoutOrAbortError(err: unknown): boolean {
  const text = errorSummary(err).toLowerCase();
  return text.includes("etimedout") || text.includes("timed out") || text.includes("abort");
}

function buildMoaFallbackAnswer(
  task: string,
  rounds: DebateRound[],
  patternSlugs: string[],
  reason: string,
): string {
  const last = rounds[rounds.length - 1];
  const claude = last?.claudeResponse?.slice(0, 220) ?? "";
  const codex = last?.codexResponse?.slice(0, 220) ?? "";
  const openclaw = last?.openclawResponse?.slice(0, 220) ?? "";
  const patterns = patternSlugs.length > 0 ? patternSlugs.join(", ") : "none";
  return [
    "## MoA Fallback Summary (timeout-safe)",
    "",
    `task: ${task.slice(0, 180)}`,
    `reason: ${reason || "moa_timeout_or_abort"}`,
    "",
    "### Latest round snapshot",
    `- Claude: ${claude}`,
    `- Codex: ${codex}`,
    `- OpenClaw: ${openclaw}`,
    `- Patterns: ${patterns}`,
    "",
    "### Safety",
    "- Paper-only continuation.",
    "- Live trading / broker write remain disabled.",
  ].join("\n");
}

function buildVerificationFallback(reason: string): VerificationResult {
  return {
    pass: false,
    confidence: 0,
    criteria: {
      correctness: 0,
      completeness: 0,
      consistency: 0,
      specificity: 0,
    },
    feedback: `verification_fallback:${reason || "timeout_or_abort"}`,
  };
}

// ── 主要導出：runDMAD ─────────────────────────────────────────────────────────

/**
 * 執行完整 DMAD 三代理辯論（含五柱自進化）。
 *
 * @param task    任務描述
 * @param db      nuwa SQLite DB（供 OpenClaw 代理查詢 patterns）
 * @param opts    選項
 * @returns       DebateResult（含完整歷程 + MoA 最終答案）
 */
export async function runDMAD(
  task: string,
  db: Database.Database,
  opts: DMADOptions = {},
): Promise<DebateResult> {
  const {
    maxRounds = 3,
    convergenceThreshold,
    varianceThreshold = 0.05,
    claudeModel = "claude-haiku-4-5",
    codexModel = "gpt-4.5",
    ollamaUrl = process.env["OLLAMA_URL"] ?? "http://localhost:11434",
    ollamaModel = process.env["OLLAMA_MODEL"] ?? "qwen3:14b",
    timeoutMs = 30_000,
    moaTimeoutMs = Math.min(timeoutMs, 15_000),
    verificationTimeoutMs = Math.min(timeoutMs, 10_000),
    allowMoaFallback = true,
    allowVerificationFallback = true,
    skipRouting = false,
    systemContext,
    onProgress,
    abortSignal,
  } = opts;

  const debateId = randomUUID();
  const startedAt = new Date().toISOString();
  const runStartMs = Date.now();
  const phaseTimingsMs: DebatePhaseTimingsMs = {
    embedder: 0,
    routing: 0,
    priorSearch: 0,
    rounds: 0,
    moa: 0,
    verification: 0,
    trajectory: 0,
    dbWrite: 0,
    total: 0,
  };
  const rounds: DebateRound[] = [];
  let allPatternSlugs: string[] = [];
  let stoppedBy: DebateResult["stoppedBy"] = "max_rounds";

  // ── 初始化 Embedder（所有語義計算的基礎）───────────────────────────────
  const embedderTimed = await timedAsync(
    () => getEmbedder({ ollamaUrl, preferBackend: "ollama" }, []),
    { onProgress, phase: "embedder" },
  );
  const embedder = embedderTimed.value;
  phaseTimingsMs.embedder = embedderTimed.durationMs;

  // ── Pillar 2：EWMA 自動校準收斂閾值 ─────────────────────────────────────
  const effectiveThreshold = convergenceThreshold ?? autoCalibrate(db, embedder.backend);

  // ── MasRouter v2：前置路由 ───────────────────────────────────────────────
  const routingStartMs = Date.now();
  emitProgress(onProgress, {
    phase: "routing",
    status: "start",
    at: new Date().toISOString(),
  });
  const route: RouteDecision = skipRouting
    ? { domain: "mixed", confidence: "low", reason: "skipRouting=true" }
    : routeTask(task);
  phaseTimingsMs.routing = elapsedMs(routingStartMs);
  emitProgress(onProgress, {
    phase: "routing",
    status: "complete",
    at: new Date().toISOString(),
    durationMs: phaseTimingsMs.routing,
  });

  // ── Pillar 1：語義先驗注入 ───────────────────────────────────────────────
  const priorsTimed = await timedAsync(() => searchPriorDebates(task, db, 1), {
    onProgress,
    phase: "priorSearch",
  });
  const priors = priorsTimed.value;
  phaseTimingsMs.priorSearch = priorsTimed.durationMs;
  const priorContext =
    priors.length > 0
      ? `歷史相關辯論（相似度 ${priors[0].semanticScore.toFixed(2)}）：${priors[0].finalAnswer.slice(0, 280)}`
      : undefined;
  const priorInjected = priors.length > 0 ? 1 : 0;

  const contextPrefix = buildContextPrefix(systemContext, priorContext);

  // ── Round 1：並行初始提案 ─────────────────────────────────────────────────
  const roundsStartMs = Date.now();
  const round1StartMs = Date.now();
  const [claudeR1Timed, codexR1Timed, openclawR1Timed] = await Promise.all([
    timedAsync(
      () => claudeRespond(CLAUDE_ROLE_R1(task, contextPrefix), claudeModel, timeoutMs, abortSignal),
      {
        onProgress,
        phase: "agent",
        round: 1,
        agent: "claude",
      },
    ),
    timedAsync(
      () => codexRespond(CODEX_ROLE_R1(task, contextPrefix), codexModel, timeoutMs, abortSignal),
      {
        onProgress,
        phase: "agent",
        round: 1,
        agent: "codex",
      },
    ),
    timedAsync(() => openclawRespond(task, db, 1, ollamaUrl, ollamaModel, undefined, abortSignal), {
      onProgress,
      phase: "agent",
      round: 1,
      agent: "openclaw",
    }),
  ]);
  const claudeR1 = claudeR1Timed.value;
  const codexR1 = codexR1Timed.value;
  const openclawR1 = openclawR1Timed.value;
  allPatternSlugs = [...new Set([...allPatternSlugs, ...openclawR1.patternSlugs])];

  const round1: DebateRound = {
    round: 1,
    claudeResponse: claudeR1,
    codexResponse: codexR1,
    openclawResponse: openclawR1.response,
    convergenceScore: 0,
    stabilityScore: 0,
    hadCliError: false,
    cliErrors: [],
    timingsMs: {
      claude: claudeR1Timed.durationMs,
      codex: codexR1Timed.durationMs,
      openclaw: openclawR1Timed.durationMs,
      convergence: 0,
      stability: 0,
      total: 0,
    },
  };
  annotateCliErrors(round1);
  const round1ConvergenceTimed = await timedAsync(() => measureConvergence(round1, embedder), {
    onProgress,
    phase: "convergence",
    round: 1,
  });
  round1.convergenceScore = round1ConvergenceTimed.value;
  round1.timingsMs.convergence = round1ConvergenceTimed.durationMs;
  round1.timingsMs.total = elapsedMs(round1StartMs);
  rounds.push(round1);

  // ── Round 2-N ─────────────────────────────────────────────────────────────
  for (let r = 2; r <= maxRounds; r++) {
    const prevRound = rounds[rounds.length - 1];

    // 停止條件 ①：語義收斂
    if (prevRound.convergenceScore > effectiveThreshold) {
      stoppedBy = "convergence";
      break;
    }

    const roundStartMs = Date.now();
    // 最後一輪切換為合成導向提示，鼓勵整合達成收斂
    const isFinalRound = r === maxRounds;
    const claudePrompt = isFinalRound
      ? CLAUDE_ROLE_R3(task, prevRound.codexResponse, prevRound.openclawResponse)
      : CLAUDE_ROLE_R2(task, prevRound.codexResponse, prevRound.openclawResponse);
    const codexPrompt = isFinalRound
      ? CODEX_ROLE_R3(task, prevRound.claudeResponse, prevRound.openclawResponse)
      : CODEX_ROLE_R2(task, prevRound.claudeResponse, prevRound.openclawResponse);

    const [claudeRnTimed, codexRnTimed, openclawRnTimed] = await Promise.all([
      timedAsync(() => claudeRespond(claudePrompt, claudeModel, timeoutMs, abortSignal), {
        onProgress,
        phase: "agent",
        round: r,
        agent: "claude",
      }),
      timedAsync(() => codexRespond(codexPrompt, codexModel, timeoutMs, abortSignal), {
        onProgress,
        phase: "agent",
        round: r,
        agent: "codex",
      }),
      timedAsync(
        () =>
          openclawRespond(
            task,
            db,
            r,
            ollamaUrl,
            ollamaModel,
            {
              claude: prevRound.claudeResponse,
              codex: prevRound.codexResponse,
              isFinalRound,
            },
            abortSignal,
          ),
        { onProgress, phase: "agent", round: r, agent: "openclaw" },
      ),
    ]);
    const claudeRn = claudeRnTimed.value;
    const codexRn = codexRnTimed.value;
    const openclawRn = openclawRnTimed.value;
    allPatternSlugs = [...new Set([...allPatternSlugs, ...openclawRn.patternSlugs])];

    const currRound: DebateRound = {
      round: r,
      claudeResponse: claudeRn,
      codexResponse: codexRn,
      openclawResponse: openclawRn.response,
      convergenceScore: 0,
      stabilityScore: 0,
      hadCliError: false,
      cliErrors: [],
      timingsMs: {
        claude: claudeRnTimed.durationMs,
        codex: codexRnTimed.durationMs,
        openclaw: openclawRnTimed.durationMs,
        convergence: 0,
        stability: 0,
        total: 0,
      },
    };
    annotateCliErrors(currRound);
    const convergenceTimed = await timedAsync(() => measureConvergence(currRound, embedder), {
      onProgress,
      phase: "convergence",
      round: r,
    });
    currRound.convergenceScore = convergenceTimed.value;
    currRound.timingsMs.convergence = convergenceTimed.durationMs;

    // 停止條件 ②：立場變化 < threshold
    const varianceTimed = await timedAsync(() => measureVariance(prevRound, currRound, embedder), {
      onProgress,
      phase: "stability",
      round: r,
    });
    const variance = varianceTimed.value;
    currRound.stabilityScore = clampScore(1 - variance);
    currRound.timingsMs.stability = varianceTimed.durationMs;
    currRound.timingsMs.total = elapsedMs(roundStartMs);
    rounds.push(currRound);
    if (variance < varianceThreshold) {
      stoppedBy = "variance";
      break;
    }
    // fencepost fix：最後一輪結束後也檢查是否已達收斂閾值
    if (r === maxRounds && currRound.convergenceScore > effectiveThreshold) {
      stoppedBy = "convergence";
    }
  }
  phaseTimingsMs.rounds = elapsedMs(roundsStartMs);

  // ── MoA 聚合 ──────────────────────────────────────────────────────────────
  let finalAnswer = "";
  let moaFallbackUsed = false;
  let moaFallbackReason = "";
  const moaStartMs = Date.now();
  try {
    const finalAnswerTimed = await timedAsync(
      () =>
        moaAggregate(
          task,
          rounds,
          allPatternSlugs,
          claudeModel,
          Math.max(1_000, moaTimeoutMs),
          abortSignal,
        ),
      { onProgress, phase: "moa" },
    );
    finalAnswer = finalAnswerTimed.value;
    phaseTimingsMs.moa = finalAnswerTimed.durationMs;
  } catch (err) {
    phaseTimingsMs.moa = elapsedMs(moaStartMs);
    if (!allowMoaFallback) {
      throw err;
    }
    moaFallbackUsed = true;
    moaFallbackReason = isTimeoutOrAbortError(err) ? "timeout_or_abort" : errorSummary(err);
    finalAnswer = buildMoaFallbackAnswer(task, rounds, allPatternSlugs, moaFallbackReason);
  }

  // ── Pillar 3：四維度驗證 ──────────────────────────────────────────────────
  let verification: VerificationResult;
  let verificationFallbackUsed = false;
  let verificationFallbackReason = "";
  const verificationStartMs = Date.now();
  try {
    const verificationTimed = await timedAsync(
      () =>
        verifyAnswer(
          task,
          finalAnswer,
          claudeModel,
          Math.max(1_000, verificationTimeoutMs),
          abortSignal,
        ),
      { onProgress, phase: "verification" },
    );
    verification = verificationTimed.value;
    phaseTimingsMs.verification = verificationTimed.durationMs;
  } catch (err) {
    phaseTimingsMs.verification = elapsedMs(verificationStartMs);
    if (!allowVerificationFallback) {
      throw err;
    }
    verificationFallbackUsed = true;
    verificationFallbackReason = isTimeoutOrAbortError(err)
      ? "timeout_or_abort"
      : errorSummary(err);
    verification = buildVerificationFallback(verificationFallbackReason);
  }

  // ── 軌跡分析（各代理貢獻獨特性）─────────────────────────────────────────
  const trajectoryTimed = await timedAsync(() => measureTrajectoryScores(rounds, embedder), {
    onProgress,
    phase: "trajectory",
  });
  const trajectoryScores = trajectoryTimed.value;
  phaseTimingsMs.trajectory = trajectoryTimed.durationMs;

  const completedAt = new Date().toISOString();
  const finalScore = rounds[rounds.length - 1].convergenceScore;
  const estimatedCostUsd = Number.parseFloat((rounds.length * 0.002 + 0.003).toFixed(4));
  const cliErrorSummary = summarizeCliErrors(rounds);
  const hadCliError = rounds.some((round) => round.hadCliError);
  const degradedParts: string[] = [];
  const cliDegradedReason = degradedReasonFromCliSummary(cliErrorSummary);
  if (cliDegradedReason) {
    degradedParts.push(cliDegradedReason);
  }
  if (moaFallbackUsed) {
    degradedParts.push(`moa_fallback=${moaFallbackReason || "true"}`);
  }
  if (verificationFallbackUsed) {
    degradedParts.push(`verification_fallback=${verificationFallbackReason || "true"}`);
  }
  const degradedReason = degradedParts.length > 0 ? degradedParts.join(",") : null;

  const result: DebateResult = {
    id: debateId,
    task,
    rounds,
    finalAnswer,
    convergenceScore: finalScore,
    totalRounds: rounds.length,
    stoppedBy,
    patternSlugsUsed: allPatternSlugs,
    hadCliError,
    cliErrorSummary,
    qualityStatus: degradedReason ? "degraded_agents" : "pass",
    degradedReason,
    trajectoryScores,
    phaseTimingsMs,
    estimatedCostUsd,
    startedAt,
    completedAt,
  };

  // ── 寫入 SQLite（含 5-pillar 擴充欄位）──────────────────────────────────
  const dbWriteStartMs = Date.now();
  emitProgress(onProgress, {
    phase: "dbWrite",
    status: "start",
    at: new Date().toISOString(),
  });
  try {
    const hasDebates = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='debates'")
      .get();

    if (hasDebates) {
      ensureDebatesColumns(db);
      db.prepare(`
        INSERT OR IGNORE INTO debates
          (id, task, rounds_json, final_answer, convergence_score,
           rounds_count, stopped_by, pattern_slugs_used,
           estimated_cost_usd, started_at, completed_at,
           route_confidence, verify_pass, verify_confidence,
           prior_injected, calibrated_threshold, trajectory_scores)
        VALUES
          (@id, @task, @roundsJson, @finalAnswer, @convergenceScore,
           @roundsCount, @stoppedBy, @patternSlugsUsed,
           @estimatedCostUsd, @startedAt, @completedAt,
           @routeConfidence, @verifyPass, @verifyConfidence,
           @priorInjected, @calibratedThreshold, @trajectoryScoresJson)
      `).run({
        id: debateId,
        task: task.slice(0, 500),
        roundsJson: JSON.stringify(rounds),
        finalAnswer: finalAnswer.slice(0, 2000),
        convergenceScore: finalScore,
        roundsCount: rounds.length,
        stoppedBy,
        patternSlugsUsed: JSON.stringify(allPatternSlugs),
        estimatedCostUsd,
        startedAt,
        completedAt,
        routeConfidence: route.confidence,
        verifyPass: verification.pass ? 1 : 0,
        verifyConfidence: verification.confidence,
        priorInjected,
        calibratedThreshold: effectiveThreshold,
        trajectoryScoresJson: JSON.stringify(trajectoryScores),
      });

      // DTE：最獨特代理的 pattern 強化
      const winnerAgent = Object.entries(trajectoryScores).toSorted(
        ([, a], [, b]) => b - a,
      )[0]?.[0];
      if (winnerAgent === "openclaw" && allPatternSlugs[0]) {
        evolveDmadPatterns(db, allPatternSlugs[0]);
      }
    }
  } catch {
    /* debates 表不存在或寫入失敗，靜默略過 */
  } finally {
    phaseTimingsMs.dbWrite = elapsedMs(dbWriteStartMs);
    phaseTimingsMs.total = elapsedMs(runStartMs);
    emitProgress(onProgress, {
      phase: "dbWrite",
      status: "complete",
      at: new Date().toISOString(),
      durationMs: phaseTimingsMs.dbWrite,
    });
  }

  return result;
}
