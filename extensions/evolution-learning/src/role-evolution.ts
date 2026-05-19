/**
 * role-evolution.ts — EvoAgentX 角色演化引擎
 *
 * 供 got-reasoning.ts、mar-reflexion.ts 等模組 import Persona 型別，
 * 並實作完整的適應度評估、多樣性選汰、交叉演化週期。
 *
 * 對應 nuwa.db personas 表的 TypeScript 映射。
 * 使用 better-sqlite3 同步 API + Node.js fs 同步讀取。
 */

import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface Persona {
  id: string;
  slug: string;
  name: string;
  description: string;
  style: string | null;
  focus: string | null;
  basePatternSlug: string | null;
  agentType: string;
  fitnessScore: number;
  createdAt: string;
  updatedAt: string;
}

/** SQLite 查詢用的 snake_case 映射（演化引擎內部）*/
export interface PersonaRow {
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

/** 演化引擎使用的精簡型別（直接對應 DB snake_case）*/
interface EvolutionPersona {
  id: string;
  slug: string;
  name: string;
  description: string;
  style: string | null;
  focus: string | null;
  base_pattern_slug: string | null;
  agent_type: string;
  fitness_score: number;
}

export interface EvolutionResult {
  evaluated: number; // 更新 fitness_score 的角色數
  evolved: number; // 新產生的角色數
  pruned: number; // 因 fitness_score < 0.3 被加速衰減的角色數
  skipped: boolean; // personas < 3，跳過演化
}

// learning-state.json 的相關型別（只取用到的欄位）
interface HermesRecord {
  tags?: string[];
  success?: boolean;
}

interface LearningState {
  records?: HermesRecord[];
}

// ── 列轉換 ────────────────────────────────────────────────────────────────

export function rowToPersona(row: PersonaRow): Persona {
  return {
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
  };
}

// ── 預設路徑 ─────────────────────────────────────────────────────────────────

const DEFAULT_LEARNING_STATE_PATH = path.join(
  process.cwd(),
  "reports/hermes-agent/state/learning-state.json",
);

// ── 主要導出函數 ──────────────────────────────────────────────────────────────

/**
 * 讀取 learning-state.json，計算指定 personaSlug 的 hermes 成功率。
 * 找不到檔案或無記錄時回傳 0.5（中性預設值）。
 */
export function getHermesSuccessRate(
  personaSlug: string,
  learningStatePath: string = DEFAULT_LEARNING_STATE_PATH,
): number {
  try {
    const raw = fs.readFileSync(learningStatePath, "utf8");
    const state = JSON.parse(raw) as LearningState;
    const records = state.records ?? [];

    const relevant = records.filter((r) => Array.isArray(r.tags) && r.tags.includes(personaSlug));

    if (relevant.length === 0) {
      return 0.5;
    }

    const successCount = relevant.filter((r) => r.success === true).length;
    return successCount / relevant.length;
  } catch {
    return 0.5;
  }
}

/**
 * 批次更新所有 persona 的 fitness_score。
 * fitness = 70% hermes 成功率 + 30% 保留既有分數（平滑更新）。
 */
export function evaluateFitness(
  db: Database.Database,
  learningStatePath: string = DEFAULT_LEARNING_STATE_PATH,
): void {
  const personas = db.prepare("SELECT id, slug, fitness_score FROM personas").all() as Pick<
    EvolutionPersona,
    "id" | "slug" | "fitness_score"
  >[];

  const update = db.prepare(`
    UPDATE personas
    SET fitness_score = @fitnessScore, updated_at = @updatedAt
    WHERE id = @id
  `);

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    for (const p of personas) {
      const rate = getHermesSuccessRate(p.slug, learningStatePath);
      const newFitness = 0.7 * rate + 0.3 * p.fitness_score;
      update.run({ fitnessScore: newFitness, updatedAt: now, id: p.id });
    }
  });
  run();
}

/**
 * 多樣性約束選汰：
 *   1. 按 style 分組，每組保留最高 fitness_score 的角色
 *   2. 剩餘名額從未入選的角色中按 fitness_score 降序補足到 k 個
 */
export function selectWithDiversity(personas: EvolutionPersona[], k: number): EvolutionPersona[] {
  if (personas.length === 0) {
    return [];
  }

  // 按 style 分組（null 視為 "__null__" key）
  const groups = new Map<string, EvolutionPersona[]>();
  for (const p of personas) {
    const key = p.style ?? "__null__";
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(p);
  }

  // 每組保留最高 fitness_score
  const selected: EvolutionPersona[] = [];
  const selectedIds = new Set<string>();
  for (const group of groups.values()) {
    const best = group.reduce((a, b) => (a.fitness_score >= b.fitness_score ? a : b));
    selected.push(best);
    selectedIds.add(best.id);
  }

  if (selected.length >= k) {
    return selected.toSorted((a, b) => b.fitness_score - a.fitness_score).slice(0, k);
  }

  // 補足：從未選入的角色按 fitness_score 降序填滿
  const remaining = personas
    .filter((p) => !selectedIds.has(p.id))
    .toSorted((a, b) => b.fitness_score - a.fitness_score);

  for (const p of remaining) {
    if (selected.length >= k) {
      break;
    }
    selected.push(p);
  }

  return selected.toSorted((a, b) => b.fitness_score - a.fitness_score);
}

/**
 * 交叉兩個父 persona 產生子 persona。
 * slug = `evolved-${Date.now()}`，fitness_score 初始為 0.5。
 */
export function crossover(parentA: EvolutionPersona, parentB: EvolutionPersona): EvolutionPersona {
  const midpoint = Math.floor(parentA.description.length / 2);
  const descA = parentA.description.slice(0, midpoint);
  const descB = parentB.description.slice(midpoint);

  const pick = <T>(a: T, b: T): T => (Math.random() < 0.5 ? a : b);

  return {
    id: crypto.randomUUID(),
    slug: `evolved-${Date.now()}`,
    name: `${parentA.name.split(" ")[0]} × ${parentB.name.split(" ")[0]}`,
    description: descA + descB,
    style: pick(parentA.style, parentB.style),
    focus: pick(parentA.focus, parentB.focus),
    base_pattern_slug: pick(parentA.base_pattern_slug, parentB.base_pattern_slug),
    agent_type: pick(parentA.agent_type, parentB.agent_type),
    fitness_score: 0.5,
  };
}

/**
 * 完整演化週期：
 *   1. personas < 3 → 跳過
 *   2. evaluateFitness
 *   3. selectWithDiversity 取 top 70%
 *   4. crossover top 2 → INSERT OR IGNORE 新角色
 *   5. 低分角色（fitness_score < 0.3）→ decay_score * 0.9（若欄位存在）
 *   6. 回傳 EvolutionResult
 */
export async function runEvolutionCycle(
  db: Database.Database,
  learningStatePath: string = DEFAULT_LEARNING_STATE_PATH,
): Promise<EvolutionResult> {
  const allPersonas = db
    .prepare(`
    SELECT id, slug, name, description, style, focus,
           base_pattern_slug, agent_type, fitness_score
    FROM personas
  `)
    .all() as EvolutionPersona[];

  // 1. 不足 3 個角色 → 跳過演化
  if (allPersonas.length < 3) {
    return { evaluated: 0, evolved: 0, pruned: 0, skipped: true };
  }

  // 2. 評估適應度
  evaluateFitness(db, learningStatePath);

  // 重新讀取更新後的分數
  const updated = db
    .prepare(`
    SELECT id, slug, name, description, style, focus,
           base_pattern_slug, agent_type, fitness_score
    FROM personas
  `)
    .all() as EvolutionPersona[];

  const evaluated = updated.length;

  // 3. 多樣性選汰 top 70%
  const topK = Math.max(2, Math.floor(updated.length * 0.7));
  const selected = selectWithDiversity(updated, topK);

  // 4. 交叉 top 2 → 產生新角色
  let evolved = 0;
  if (selected.length >= 2) {
    const child = crossover(selected[0], selected[1]);
    const now = new Date().toISOString();
    try {
      db.prepare(`
        INSERT OR IGNORE INTO personas
          (id, slug, name, description, style, focus,
           base_pattern_slug, agent_type, fitness_score, created_at, updated_at)
        VALUES
          (@id, @slug, @name, @description, @style, @focus,
           @basePatternSlug, @agentType, @fitnessScore, @createdAt, @updatedAt)
      `).run({
        id: child.id,
        slug: child.slug,
        name: child.name,
        description: child.description,
        style: child.style,
        focus: child.focus,
        basePatternSlug: child.base_pattern_slug,
        agentType: child.agent_type,
        fitnessScore: child.fitness_score,
        createdAt: now,
        updatedAt: now,
      });
      evolved = 1;
    } catch {
      // slug 衝突（極罕見）靜默跳過
    }
  }

  // 5. 低分角色加速衰減（decay_score * 0.9，若欄位存在）
  let pruned = 0;
  const lowScorePersonas = updated.filter((p) => p.fitness_score < 0.3);

  if (lowScorePersonas.length > 0) {
    const hasDecayScore = (() => {
      try {
        const info = db.prepare("PRAGMA table_info(personas)").all() as { name: string }[];
        return info.some((col) => col.name === "decay_score");
      } catch {
        return false;
      }
    })();

    if (hasDecayScore) {
      const decayUpdate = db.prepare(
        "UPDATE personas SET decay_score = decay_score * 0.9 WHERE id = @id",
      );
      const runDecay = db.transaction(() => {
        for (const p of lowScorePersonas) {
          decayUpdate.run({ id: p.id });
        }
      });
      runDecay();
      pruned = lowScorePersonas.length;
    }
  }

  return { evaluated, evolved, pruned, skipped: false };
}
