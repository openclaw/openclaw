/**
 * cognitive-cycle.ts — ABCD 統合認知迴圈入口
 *
 * 整合四層創新架構：
 *   A：EvoAgentX 角色演化（role-evolution.ts）
 *   B：MAR 多角色反思（mar-reflexion.ts）
 *   C：GoT 圖思維（got-reasoning.ts）
 *   D：Constitutional 憲法辯論（constitutional.ts）
 *
 * 由 Hermes 擔任統一認知指揮官：
 *   - TypeScript 邏輯層：選角色、選策略、選原則（不呼叫 LLM）
 *   - LLM 層：批評 prompt / Judge prompt 組裝好後回傳 MCP，由 MCP 呼叫 Claude
 *
 * 實際 LLM 呼叫全部在 mcp/server.ts 完成；
 * 本模組只負責 prompt 組裝、策略決策、學習結果回寫。
 */

import path from "node:path";
import type Database from "better-sqlite3";
import { getConstitution, hermesUpdateConstitution } from "./constitutional.js";
import { runGoT } from "./got-reasoning.js";
import type { GoTResult, GoTOptions } from "./got-reasoning.js";
import { runMAR } from "./mar-reflexion.js";
import type { MARResult, MAROptions } from "./mar-reflexion.js";
import { runEvolutionCycle } from "./role-evolution.js";
import type { EvolutionResult } from "./role-evolution.js";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface CognitiveCycleInput {
  task: string;
  taskType: TaskType;
  proposal: string; // 初始提案（由 MCP 呼叫 Claude 產生後傳入）
  db: Database.Database;
  learningStatePath?: string; // 預設：reports/hermes-agent/state/learning-state.json
}

export interface CognitiveCycleResult {
  // GoT 結果
  got: GoTResult;
  // MAR 結果
  mar: MARResult;
  // 最終答案（由 MCP 呼叫 Claude Sonnet MoA 聚合後填入，這裡為佔位）
  finalAnswer: string;
  // 各層的 prompt 文字（供 MCP 依序呼叫 Claude）
  prompts: {
    gotNodes: string[]; // 每個 GoT 節點的推理 prompt（Haiku）
    criticPrompts: string[]; // 每個批評者的 prompt（Haiku）
    judgePrompt: string; // Judge 整合 prompt（Sonnet）
    moaPrompt: string; // MoA 聚合 prompt（Sonnet）
  };
  // 統計
  stats: {
    gotNodes: number;
    critics: number;
    retries: number;
    totalEstimatedCostUsd: number;
    skippedMAR: boolean;
  };
}

export type TaskType =
  | "architecture"
  | "security"
  | "cost_optimization"
  | "code_quality"
  | "agent_design"
  | "general";

// ── 預設值 ──────────────────────────────────────────────────────────────────

const DEFAULT_LEARNING_STATE_PATH = path.join(
  process.cwd(),
  "reports/hermes-agent/state/learning-state.json",
);

const DEFAULT_GOT_OPTIONS: GoTOptions = {
  maxNodes: 8,
  mergeThreshold: 0.85,
  budgetUsd: 0.5,
};

const DEFAULT_MAR_OPTIONS: MAROptions = {
  maxRetries: 2,
  confidenceThreshold: 0.7,
  budgetUsd: 1.0,
  numCritics: 3,
};

// ── 主要導出函數 ──────────────────────────────────────────────────────────────

/**
 * 執行完整 ABCD 認知迴圈。
 *
 * 流程：
 *   1. [D] 同步憲法原則（hermesUpdateConstitution）
 *   2. [C] GoT 拆解任務 + 遍歷策略決策
 *   3. [B] MAR 多角色批評 + Judge 整合（prompt 組裝，LLM 由 MCP 呼叫）
 *   4. 組裝 MoA 聚合 prompt
 *   5. 回傳所有 prompts + 統計供 MCP 依序執行
 *
 * @returns CognitiveCycleResult — 含所有 promptText，MCP 依序呼叫 Claude 填入結果
 */
export async function runCognitiveCycle(
  input: CognitiveCycleInput,
  gotOptions: GoTOptions = DEFAULT_GOT_OPTIONS,
  marOptions: MAROptions = DEFAULT_MAR_OPTIONS,
): Promise<CognitiveCycleResult> {
  const { task, taskType, proposal, db } = input;
  const learningStatePath = input.learningStatePath ?? DEFAULT_LEARNING_STATE_PATH;

  // ── D: 憲法原則同步（純 TypeScript，無 LLM）────────────────────────────
  hermesUpdateConstitution(taskType, db);
  // getConstitution 回傳 ConstitutionalPrinciple[]，取 .principle 轉成 string[]
  const principles = getConstitution(taskType, db).map((p) => p.principle);

  // ── C: GoT 圖思維拆解（無 LLM，組裝 prompt 框架）──────────────────────
  const got = await runGoT(task, taskType, db, gotOptions);
  const gotNodePrompts = got.merged.map(
    (node) => node.content, // 每個節點的 content 含 promptText
  );

  // ── B: MAR 多角色反思（無 LLM，組裝批評 + Judge prompt）───────────────
  const mar = await runMAR(task, taskType, proposal, db, learningStatePath, {
    ...marOptions,
    // 憲法原則注入到批評者
  });

  // ── 組裝 MoA 聚合 prompt（Sonnet，由 MCP 呼叫）──────────────────────
  const moaPrompt = buildMoAPrompt(task, proposal, got, mar, principles);

  // ── 費用統計 ────────────────────────────────────────────────────────────
  const gotCost = got.merged.length * 0.0003;
  const marCost = mar.skippedDueToCost
    ? 0
    : mar.criticResponses.length * 0.0003 + (1 + mar.retries) * 0.003;
  const moaCost = 0.003; // Sonnet 一次

  return {
    got,
    mar,
    finalAnswer: "", // 由 MCP 呼叫 Claude MoA 後填入
    prompts: {
      gotNodes: gotNodePrompts,
      criticPrompts: mar.criticResponses.map((c) => c.promptText),
      judgePrompt:
        mar.criticResponses.length > 0
          ? buildJudgeSummaryPrompt(task, proposal, mar.criticResponses)
          : "",
      moaPrompt,
    },
    stats: {
      gotNodes: got.merged.length,
      critics: mar.criticResponses.length,
      retries: mar.retries,
      totalEstimatedCostUsd: Number.parseFloat((gotCost + marCost + moaCost).toFixed(4)),
      skippedMAR: mar.skippedDueToCost,
    },
  };
}

/**
 * 週期性演化任務（由 Croner 每週日呼叫）。
 * 評估角色適應度 + 演化新角色。
 */
export async function runWeeklyEvolution(
  db: Database.Database,
  learningStatePath: string = DEFAULT_LEARNING_STATE_PATH,
): Promise<EvolutionResult> {
  return runEvolutionCycle(db, learningStatePath);
}

// ── 內部 prompt 組裝輔助 ─────────────────────────────────────────────────────

function buildMoAPrompt(
  task: string,
  initialProposal: string,
  got: GoTResult,
  mar: MARResult,
  principles: string[],
): string {
  const gotSummary = got.merged.map((n, i) => `[思維節點 ${i + 1}] ${n.content}`).join("\n");

  const criticSummary =
    mar.criticResponses.length > 0
      ? mar.criticResponses
          .map(
            (c) =>
              `[${c.personaSlug}] 引用原則「${c.principleUsed}」：${c.critique || c.promptText}`,
          )
          .join("\n")
      : "（MAR 反思因費用限制已跳過）";

  return `你是 MoA（Mixture of Agents）聚合器，任務是整合多個代理的思維與批評，產出最終高品質答案。

## 原始任務
${task}

## 初始提案
${initialProposal}

## GoT 圖思維分析（${got.merged.length} 個節點，策略：${got.strategy}）
${gotSummary}

## 多角色批評（MAR 反思）
${criticSummary}

## 適用憲法原則
${principles.map((p, i) => `${i + 1}. ${p}`).join("\n")}

## 你的任務
綜合以上所有觀點，輸出：
1. 最終建議方案（300 字以內）
2. 採納了哪些批評（列點）
3. 信心分（0-1）
4. 若信心 < 0.7，指出哪個部分需要進一步討論`;
}

function buildJudgeSummaryPrompt(
  task: string,
  proposal: string,
  critiques: import("./mar-reflexion.js").CriticResponse[],
): string {
  return `你是 Hermes Judge 代理，負責整合多位批評者的意見，決定方案是否需要反思重試。

## 任務
${task}

## 當前提案
${proposal}

## 批評者意見
${critiques.map((c) => `[${c.personaSlug}] 原則「${c.principleUsed}」\n批評：${c.critique || "（待 MCP 填入）"}`).join("\n\n")}

## 你的決策（請以 JSON 格式回答）
{
  "confidence": 0.0-1.0,
  "shouldRetry": true/false,
  "failedNodes": ["需要重試的 GoT 節點 id"],
  "adoptedCritics": ["採納了哪些 personaSlug 的批評"],
  "reasoning": "整合推理說明"
}`;
}
