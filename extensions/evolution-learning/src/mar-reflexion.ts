/**
 * mar-reflexion.ts — MAR（Multi-Agent Reflexion）多角色反思層
 *
 * 協調多個 persona 批評者（Haiku）與一個 Judge 裁決者（Sonnet），
 * 對 GoT 輸出的 proposal 進行多輪反思，提升最終答案品質。
 *
 * 架構：
 *   1. 從 personas 表取 numCritics 個多元高 fitness 角色
 *   2. 從 constitution_principles 取對應原則，組裝批評 prompt
 *   3. 組裝 Judge prompt（供 MCP 呼叫 Claude Sonnet）
 *   4. 記錄批評有效性至 Hermes learning-state.json 與 causal_edges
 *
 * 實際 LLM 呼叫由 MCP server 負責；本模組僅組裝 promptText，
 * MCP 填入 critique/reasoning/confidence 等欄位後再呼叫後續流程。
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type Database from "better-sqlite3";
import type { Persona } from "./role-evolution.js";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface CriticResponse {
  personaSlug: string;
  critique: string; // 批評內容（由 MCP 呼叫 Claude 後填入）
  principleUsed: string; // 引用的憲法原則
  wasAdopted: boolean; // Judge 是否採納此批評（Judge 決策後填入）
  promptText: string; // 組裝好的批評 prompt（供 MCP 呼叫）
}

export interface JudgeDecision {
  confidence: number; // 0-1
  shouldRetry: boolean; // confidence < 0.7
  failedNodes: string[]; // 需要重試的 GoT 節點 id
  reasoning: string; // Judge 的整合推理（由 MCP 呼叫 Claude Sonnet 後填入）
  promptText: string; // Judge prompt（供 MCP 呼叫）
}

export interface MARResult {
  answer: string;
  retries: number;
  finalConfidence: number;
  skippedDueToCost: boolean;
  criticResponses: CriticResponse[];
}

export interface MAROptions {
  maxRetries?: number; // 預設 2
  confidenceThreshold?: number; // 預設 0.7
  budgetUsd?: number; // 預設 1.0
  numCritics?: number; // 預設 3
}

// ── Hermes learning-state.json 型別 ──────────────────────────────────────────

interface LearningStateRecord {
  traceId: string;
  status: "success" | "failure";
  summary: string;
  tags: string[];
  recordedAt: string;
}

interface LearningState {
  success_patterns: LearningStateRecord[];
  failure_patterns: LearningStateRecord[];
}

// ── SQLite 列型別 ─────────────────────────────────────────────────────────────

interface PersonaRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  style: string | null;
  focus: string | null;
  base_pattern_slug: string | null;
  agent_type: string;
  fitness_score: number;
  created_at: string;
  updated_at: string;
}

interface PrincipleRow {
  principle: string;
}

// ── 常數 ─────────────────────────────────────────────────────────────────────

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.7;
const DEFAULT_BUDGET_USD = 1.0;
const DEFAULT_NUM_CRITICS = 3;
const HAIKU_COST_PER_CALL = 0.0003;
const SONNET_COST_PER_CALL = 0.003;
const MAX_LEARNING_RECORDS = 100;

// ── 費用估算 ──────────────────────────────────────────────────────────────────

/**
 * retries * (critics * $0.0003 Haiku + $0.003 Sonnet Judge)
 */
export function estimateMARCost(retries: number, critics: number): number {
  return retries * (critics * HAIKU_COST_PER_CALL + SONNET_COST_PER_CALL);
}

// ── Persona 查詢 ──────────────────────────────────────────────────────────────

function queryDiversePersonas(db: Database.Database, numCritics: number): Persona[] {
  // 取高 fitness 且 style/focus 多元的角色（按 fitness DESC + style 分散）
  const rows = db
    .prepare(
      `SELECT * FROM personas
       ORDER BY fitness_score DESC, agent_type ASC
       LIMIT ?`,
    )
    .all(numCritics * 3) as PersonaRow[];

  // 依 style 多元化選取（每種 style 最多取一個，不足則補）
  const seen = new Set<string>();
  const diverse: PersonaRow[] = [];

  for (const row of rows) {
    const key = row.style ?? row.focus ?? row.slug;
    if (!seen.has(key)) {
      seen.add(key);
      diverse.push(row);
    }
    if (diverse.length >= numCritics) {
      break;
    }
  }

  // 若多元化後不足，補齊剩餘高 fitness 角色
  if (diverse.length < numCritics) {
    for (const row of rows) {
      if (!diverse.some((r) => r.id === row.id)) {
        diverse.push(row);
      }
      if (diverse.length >= numCritics) {
        break;
      }
    }
  }

  return diverse.slice(0, numCritics).map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    style: row.style,
    focus: row.focus,
    basePatternSlug: row.base_pattern_slug,
    agentType: row.agent_type,
    fitnessScore: row.fitness_score,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

// ── 憲法原則查詢 ──────────────────────────────────────────────────────────────

function queryPrinciples(db: Database.Database, taskType: string, count: number): string[] {
  const rows = db
    .prepare(
      `SELECT principle FROM constitution_principles
       WHERE task_type = ?
       ORDER BY weight DESC, win_count DESC
       LIMIT ?`,
    )
    .all(taskType, count) as PrincipleRow[];

  return rows.map((r) => r.principle);
}

// ── Prompt 組裝 ───────────────────────────────────────────────────────────────

/**
 * 為每個 persona 組裝批評 prompt。
 * principles[i] 對應 personas[i] 使用的原則（不足時循環使用）。
 */
export function buildCriticPrompts(
  proposal: string,
  task: string,
  personas: Persona[],
  principles: string[][],
): CriticResponse[] {
  return personas.map((persona, i) => {
    const personaPrinciples = principles[i] ?? principles[0] ?? [];
    const principleText = personaPrinciples.join("\n- ");

    const promptText = [
      `你正在扮演角色：${persona.name}（${persona.description}）`,
      `風格：${persona.style ?? "中立"}，關注點：${persona.focus ?? "整體品質"}`,
      ``,
      `任務：${task}`,
      ``,
      `以下是待審查的方案：`,
      `---`,
      proposal,
      `---`,
      ``,
      `請依據以下憲法原則，以 ${persona.name} 的視角提出具體批評：`,
      `- ${principleText}`,
      ``,
      `批評要求：`,
      `1. 指出方案中的具體問題（不超過 3 點）`,
      `2. 每點批評必須能對應到上述原則之一`,
      `3. 提出可操作的改善建議`,
    ].join("\n");

    return {
      personaSlug: persona.slug,
      critique: "", // MCP 呼叫後填入
      principleUsed: personaPrinciples[0] ?? "",
      wasAdopted: false, // Judge 決策後填入
      promptText,
    };
  });
}

/**
 * 組裝 Judge prompt。
 * 回傳 promptText 已填好，confidence/reasoning/failedNodes 留空待 MCP 填入。
 */
export function buildJudgePrompt(
  task: string,
  proposal: string,
  critiques: CriticResponse[],
): JudgeDecision {
  const critiqueLines = critiques.map(
    (c, i) =>
      `[批評者 ${i + 1}（${c.personaSlug}）]\n原則：${c.principleUsed}\n批評：${c.critique || "(待 MCP 填入)"}`,
  );

  const promptText = [
    `你是最終裁決 Judge，整合多位批評者的意見，決定方案是否足夠好或需要重試。`,
    ``,
    `任務：${task}`,
    ``,
    `待評方案：`,
    `---`,
    proposal,
    `---`,
    ``,
    `批評者意見（共 ${critiques.length} 位）：`,
    critiqueLines.join("\n\n"),
    ``,
    `請完成以下裁決：`,
    `1. confidence（0-1）：你對方案品質的整體信心分數`,
    `2. shouldRetry：若 confidence < 0.7 則為 true`,
    `3. failedNodes：若需重試，列出對應 GoT 節點 id`,
    `4. reasoning：整合所有批評，說明裁決理由（100字以內）`,
    `5. wasAdopted：對每位批評者的批評，標記是否被採納`,
    ``,
    `回傳格式（JSON）：`,
    `{`,
    `  "confidence": 0.85,`,
    `  "shouldRetry": false,`,
    `  "failedNodes": [],`,
    `  "reasoning": "方案整體符合原則...",`,
    `  "adoptedCritics": ["persona-slug-1"]`,
    `}`,
  ].join("\n");

  return {
    confidence: 0, // MCP 填入
    shouldRetry: false, // MCP 填入
    failedNodes: [], // MCP 填入
    reasoning: "", // MCP 填入
    promptText,
  };
}

// ── Hermes learning-state.json 讀寫 ─────────────────────────────────────────

function readLearningState(statePath: string): LearningState {
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    return JSON.parse(raw) as LearningState;
  } catch {
    return { success_patterns: [], failure_patterns: [] };
  }
}

function writeLearningState(statePath: string, state: LearningState): void {
  // 各最多保留 100 筆
  state.success_patterns = state.success_patterns.slice(-MAX_LEARNING_RECORDS);
  state.failure_patterns = state.failure_patterns.slice(-MAX_LEARNING_RECORDS);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf8");
}

// ── 批評有效性記錄 ────────────────────────────────────────────────────────────

/**
 * 把 wasAdopted 結果寫進 Hermes learning-state.json（read-modify-write）
 * + 寫 causal_edges（relation = 'mar_judge'）
 */
export function recordCriticEffectiveness(
  critiques: CriticResponse[],
  taskType: string,
  db: Database.Database,
  learningStatePath: string,
): void {
  const state = readLearningState(learningStatePath);

  for (const c of critiques) {
    const record: LearningStateRecord = {
      traceId: randomUUID(),
      status: c.wasAdopted ? "success" : "failure",
      summary: `[MAR] ${c.personaSlug} 批評原則：${c.principleUsed}`,
      tags: [taskType, c.personaSlug, "mar_critic"],
      recordedAt: new Date().toISOString(),
    };

    if (c.wasAdopted) {
      state.success_patterns.push(record);
    } else {
      state.failure_patterns.push(record);
    }

    // 寫 causal_edges
    db.prepare(
      `INSERT INTO causal_edges (id, from_slug, to_slug, relation, weight)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(randomUUID(), c.personaSlug, taskType, "mar_judge", c.wasAdopted ? 1.0 : 0.0);
  }

  writeLearningState(learningStatePath, state);
}

// ── 主要流程 ──────────────────────────────────────────────────────────────────

/**
 * 完整 MAR 反思流程。
 * 本函數組裝所有 promptText 供 MCP server 呼叫，
 * 實際 LLM 結果由 MCP 填入後再更新 CriticResponse/JudgeDecision。
 */
export async function runMAR(
  task: string,
  taskType: string,
  proposal: string,
  db: Database.Database,
  learningStatePath: string,
  options: MAROptions = {},
): Promise<MARResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const confidenceThreshold = options.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const budgetUsd = options.budgetUsd ?? DEFAULT_BUDGET_USD;
  const numCritics = options.numCritics ?? DEFAULT_NUM_CRITICS;

  // Step 1：費用預估，超限則跳過
  const estimatedCost = estimateMARCost(maxRetries, numCritics);
  if (estimatedCost > budgetUsd) {
    return {
      answer: proposal,
      retries: 0,
      finalConfidence: 0,
      skippedDueToCost: true,
      criticResponses: [],
    };
  }

  // Step 2：從 personas 表取多元高 fitness 角色
  const personas = queryDiversePersonas(db, numCritics);

  // Step 3：為每個 persona 取 2 條憲法原則
  const principlesPerPersona = personas.map(() => queryPrinciples(db, taskType, 2));

  // Step 4：組裝批評 prompts
  const criticResponses = buildCriticPrompts(proposal, task, personas, principlesPerPersona);

  // Step 5：組裝 Judge prompt
  const judgeDecision = buildJudgePrompt(task, proposal, criticResponses);

  // Step 6：模擬信心分數（MCP server 實際呼叫後填入真實值）
  const simulatedConfidence = 0.8;
  judgeDecision.confidence = simulatedConfidence;
  judgeDecision.shouldRetry = simulatedConfidence < confidenceThreshold;

  // Step 7：記錄批評有效性
  const learningStateDir = path.dirname(learningStatePath);
  try {
    fs.mkdirSync(learningStateDir, { recursive: true });
  } catch {
    // 目錄已存在，忽略
  }
  recordCriticEffectiveness(criticResponses, taskType, db, learningStatePath);

  return {
    answer: proposal,
    retries: judgeDecision.shouldRetry ? 1 : 0,
    finalConfidence: judgeDecision.confidence,
    skippedDueToCost: false,
    criticResponses,
  };
}
