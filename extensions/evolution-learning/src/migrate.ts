/**
 * nuwa JSON → SQLite 遷移腳本
 *
 * 將舊版 evolution-state/ 目錄下的 JSON/JSONL 檔案一次性遷移到 nuwa.db。
 * 使用 migration-done.json 標記避免重複執行。
 *
 * 呼叫方式：
 *   await migrateIfNeeded(stateDir, db.local)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

// ── 型別定義 ────────────────────────────────────────────────────────────────

interface RawPattern {
  id?: string;
  slug: string;
  target: string;
  confidence?: number;
  successRate?: number;
  sampleCount?: number;
  mentalModels?: string[];
  keywords?: string[];
  context?: string;
  skillPath?: string | null;
  frozen?: boolean;
  lastUsed?: string | null;
  createdAt?: string;
  parentSlug?: string | null;
  scope?: "local" | "global" | "shared";
  decayScore?: number;
  lastActivated?: string | null;
}

interface RawStemCell {
  id?: string;
  slug: string;
  target: string;
  status?: "embryo" | "incubating" | "ready" | "installed";
  maturityScore?: number;
  usageCount?: number;
  positiveRating?: number;
  lastEvaluated?: string | null;
}

interface RawCellRegistry {
  version?: number;
  stemCells?: RawStemCell[];
}

interface RawPersona {
  id?: string;
  slug: string;
  name: string;
  description: string;
  style?: string | null;
  focus?: string | null;
  basePatternSlug?: string | null;
  agentType?: string;
  fitnessScore?: number;
}

interface RawConstitutionPrinciple {
  id?: string;
  taskType: string;
  principle: string;
  weight?: number;
  winCount?: number;
}

export interface MigrationResult {
  skipped: boolean; // true = migration-done.json 已存在，略過
  patterns: number; // 從 patterns.jsonl 遷移的數量
  cells: number; // 從 cell-registry.json 遷移的數量
  seeded: number; // 從 seed-patterns.jsonl 載入的數量（僅在 patterns 表為空時）
  seededPersonas: number; // 從 seed-personas.jsonl 載入的數量
  seededConstitution: number; // 從 seed-constitution.jsonl 載入的數量
  errors: string[]; // 非致命錯誤列表（不中斷主流程）
}

// ── 工具函數 ────────────────────────────────────────────────────────────────

async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

function parseJsonlLines<T>(content: string): T[] {
  const result: T[] = [];
  for (const line of content.split("\n")) {
    const t = line.trim();
    if (!t) {
      continue;
    }
    try {
      result.push(JSON.parse(t) as T);
    } catch {
      // 跳過無法解析的行，繼續處理下一行
    }
  }
  return result;
}

// seed-*.jsonl 均位於 extensions/evolution-learning/ 根目錄
function resolveSeedPath(filename: string): string {
  try {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return path.join(moduleDir, "..", filename);
  } catch {
    // fallback：從 process.cwd() 推算（非標準 ESM 環境）
    return path.join(process.cwd(), filename);
  }
}

const DEBATES_EXTRA_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: "rounds_json", ddl: "rounds_json TEXT NOT NULL DEFAULT '[]'" },
  { name: "stopped_by", ddl: "stopped_by TEXT" },
  { name: "pattern_slugs_used", ddl: "pattern_slugs_used TEXT DEFAULT '[]'" },
  { name: "estimated_cost_usd", ddl: "estimated_cost_usd REAL DEFAULT 0" },
  { name: "completed_at", ddl: "completed_at TEXT" },
];

/**
 * 確保 debates 表具備新版 DMAD 欄位。
 * 即使 migration-done.json 已存在，也要在啟動時補齊舊 DB 欄位。
 */
function ensureDebatesSchema(db: Database.Database, errors: string[]): void {
  try {
    const debatesTable = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'debates'")
      .get() as { name: string } | undefined;
    if (!debatesTable) {
      return;
    }

    const tableInfo = db.prepare("PRAGMA table_info(debates)").all() as Array<{ name: string }>;
    const existingColumns = new Set(tableInfo.map((c) => c.name));

    for (const col of DEBATES_EXTRA_COLUMNS) {
      if (existingColumns.has(col.name)) {
        continue;
      }
      try {
        db.exec(`ALTER TABLE debates ADD COLUMN ${col.ddl}`);
        existingColumns.add(col.name);
      } catch (err) {
        errors.push(`debates 欄位補齊失敗（${col.name}）：${String(err)}`);
      }
    }

    // 若舊欄位 rounds 有內容，且 rounds_json 尚未被寫入，做一次回填
    if (existingColumns.has("rounds") && existingColumns.has("rounds_json")) {
      db.exec(`
        UPDATE debates
        SET rounds_json = rounds
        WHERE (rounds_json IS NULL OR rounds_json = '' OR rounds_json = '[]')
          AND rounds IS NOT NULL
          AND rounds != ''
      `);
    }
  } catch (err) {
    errors.push(`debates schema 檢查失敗：${String(err)}`);
  }
}

// ── Pattern 插入輔助 ─────────────────────────────────────────────────────────

function buildPatternRow(p: RawPattern, defaultScope: "local" | "global" = "local") {
  return {
    id: p.id ?? crypto.randomUUID(),
    slug: p.slug,
    target: p.target,
    confidence: p.confidence ?? 0,
    successRate: p.successRate ?? 0,
    sampleCount: p.sampleCount ?? 0,
    mentalModels: JSON.stringify(p.mentalModels ?? []),
    keywords: JSON.stringify(p.keywords ?? []),
    context: p.context ?? "",
    skillPath: p.skillPath ?? null,
    frozen: p.frozen ? 1 : 0,
    lastUsed: p.lastUsed ?? null,
    createdAt: p.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    parentSlug: p.parentSlug ?? null,
    scope: p.scope ?? defaultScope,
    decayScore: p.decayScore ?? 1.0,
    lastActivated: p.lastActivated ?? null,
  };
}

// ── 主要導出函數 ──────────────────────────────────────────────────────────────

/**
 * 若尚未遷移，將 evolution-state/ 下的 JSON/JSONL 資料遷移到 SQLite。
 *
 * @param stateDir 插件工作目錄（patterns.jsonl / cell-registry.json 所在地）
 * @param db       已初始化的 SQLite 實例（openDb() 回傳的 local 或 global）
 */
export async function migrateIfNeeded(
  stateDir: string,
  db: Database.Database,
): Promise<MigrationResult> {
  const doneFlag = path.join(stateDir, "migration-done.json");
  const errors: string[] = [];

  // 先補齊 debates 欄位，再判斷是否略過 migration
  ensureDebatesSchema(db, errors);

  // ── 1. 已遷移過 → 直接略過 ─────────────────────────────────────────────
  if (await safeReadFile(doneFlag)) {
    return {
      skipped: true,
      patterns: 0,
      cells: 0,
      seeded: 0,
      seededPersonas: 0,
      seededConstitution: 0,
      errors,
    };
  }

  // ── 2. 讀取來源檔案（async，在 transaction 之前完成）───────────────────
  const [patternsContent, registryContent] = await Promise.all([
    safeReadFile(path.join(stateDir, "patterns.jsonl")),
    safeReadFile(path.join(stateDir, "cell-registry.json")),
  ]);

  const rawPatterns: RawPattern[] = patternsContent
    ? parseJsonlLines<RawPattern>(patternsContent)
    : [];

  let rawCells: RawStemCell[] = [];
  if (registryContent) {
    try {
      const reg = JSON.parse(registryContent) as RawCellRegistry;
      rawCells = reg.stemCells ?? [];
    } catch (err) {
      errors.push(`cell-registry.json 解析失敗：${String(err)}`);
    }
  }

  // ── 3. 準備 INSERT 語句 ─────────────────────────────────────────────────
  const insertPattern = db.prepare(`
    INSERT OR IGNORE INTO patterns (
      id, slug, target, confidence, success_rate, sample_count,
      mental_models, keywords, context, skill_path, frozen,
      last_used, created_at, updated_at,
      parent_slug, scope, decay_score, last_activated
    ) VALUES (
      @id, @slug, @target, @confidence, @successRate, @sampleCount,
      @mentalModels, @keywords, @context, @skillPath, @frozen,
      @lastUsed, @createdAt, @updatedAt,
      @parentSlug, @scope, @decayScore, @lastActivated
    )
  `);

  const insertCell = db.prepare(`
    INSERT OR IGNORE INTO stem_cells (
      id, slug, target, status, maturity_score, usage_count,
      positive_rating, last_evaluated
    ) VALUES (
      @id, @slug, @target, @status, @maturityScore, @usageCount,
      @positiveRating, @lastEvaluated
    )
  `);

  // ── 4. BEGIN IMMEDIATE transaction 包裹所有寫入 ─────────────────────────
  // better-sqlite3 的 .transaction() 預設使用 DEFERRED，
  // 這裡改用 immediate 模式避免多客戶端同時啟動時的 SQLITE_BUSY
  let migratedPatterns = 0;
  let migratedCells = 0;

  const runMigration = db.transaction(() => {
    // 4a. 遷移 patterns
    for (const p of rawPatterns) {
      try {
        const changes = insertPattern.run(buildPatternRow(p, "local"));
        if (changes.changes > 0) {
          migratedPatterns++;
        }
      } catch (err) {
        errors.push(`pattern '${p.slug}' 寫入失敗：${String(err)}`);
      }
    }

    // 4b. 遷移 stem cells
    for (const cell of rawCells) {
      try {
        const changes = insertCell.run({
          id: cell.id ?? crypto.randomUUID(),
          slug: cell.slug,
          target: cell.target,
          status: cell.status ?? "embryo",
          maturityScore: cell.maturityScore ?? 0,
          usageCount: cell.usageCount ?? 0,
          positiveRating: cell.positiveRating ?? 0,
          lastEvaluated: cell.lastEvaluated ?? null,
        });
        if (changes.changes > 0) {
          migratedCells++;
        }
      } catch (err) {
        errors.push(`cell '${cell.slug}' 寫入失敗：${String(err)}`);
      }
    }
  });

  // immediate = BEGIN IMMEDIATE（比 DEFERRED 更積極鎖定，防止並發衝突）
  runMigration.immediate();

  // ── 5. 若 patterns 表仍然空 → 載入 seed-patterns.jsonl ────────────────
  let seededPatterns = 0;
  const { cnt } = db.prepare("SELECT COUNT(*) as cnt FROM patterns").get() as { cnt: number };

  if (cnt === 0) {
    const seedContent = await safeReadFile(resolveSeedPath("seed-patterns.jsonl"));
    if (seedContent) {
      const seeds = parseJsonlLines<RawPattern>(seedContent);
      const runSeed = db.transaction(() => {
        for (const p of seeds) {
          try {
            const changes = insertPattern.run(buildPatternRow(p, "global"));
            if (changes.changes > 0) {
              seededPatterns++;
            }
          } catch (err) {
            errors.push(`seed '${p.slug}' 寫入失敗：${String(err)}`);
          }
        }
      });
      runSeed.immediate();
    }
  }

  // ── 6. 若 personas 表仍然空 → 載入 seed-personas.jsonl ───────────────
  let seededPersonas = 0;
  const { pCnt } = db.prepare("SELECT COUNT(*) as pCnt FROM personas").get() as { pCnt: number };

  if (pCnt === 0) {
    const personaSeedContent = await safeReadFile(resolveSeedPath("seed-personas.jsonl"));
    if (personaSeedContent) {
      const insertPersona = db.prepare(`
        INSERT OR IGNORE INTO personas (
          id, slug, name, description, style, focus,
          base_pattern_slug, agent_type, fitness_score, created_at, updated_at
        ) VALUES (
          @id, @slug, @name, @description, @style, @focus,
          @basePatternSlug, @agentType, @fitnessScore, @createdAt, @updatedAt
        )
      `);
      const seeds = parseJsonlLines<RawPersona>(personaSeedContent);
      const runPersonaSeed = db.transaction(() => {
        for (const p of seeds) {
          try {
            const changes = insertPersona.run({
              id: p.id ?? crypto.randomUUID(),
              slug: p.slug,
              name: p.name,
              description: p.description,
              style: p.style ?? null,
              focus: p.focus ?? null,
              basePatternSlug: p.basePatternSlug ?? null,
              agentType: p.agentType ?? "claude",
              fitnessScore: p.fitnessScore ?? 0.5,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            if (changes.changes > 0) {
              seededPersonas++;
            }
          } catch (err) {
            errors.push(`persona seed '${p.slug}' 寫入失敗：${String(err)}`);
          }
        }
      });
      runPersonaSeed.immediate();
    }
  }

  // ── 7. 若 constitution_principles 表仍然空 → 載入 seed-constitution.jsonl ──
  let seededConstitution = 0;
  const { cCnt } = db.prepare("SELECT COUNT(*) as cCnt FROM constitution_principles").get() as {
    cCnt: number;
  };

  if (cCnt === 0) {
    const constitutionSeedContent = await safeReadFile(resolveSeedPath("seed-constitution.jsonl"));
    if (constitutionSeedContent) {
      const insertPrinciple = db.prepare(`
        INSERT OR IGNORE INTO constitution_principles (
          id, task_type, principle, weight, win_count, created_at, updated_at
        ) VALUES (
          @id, @taskType, @principle, @weight, @winCount, @createdAt, @updatedAt
        )
      `);
      const seeds = parseJsonlLines<RawConstitutionPrinciple>(constitutionSeedContent);
      const runConstitutionSeed = db.transaction(() => {
        for (const c of seeds) {
          try {
            const changes = insertPrinciple.run({
              id: c.id ?? crypto.randomUUID(),
              taskType: c.taskType,
              principle: c.principle,
              weight: c.weight ?? 1.0,
              winCount: c.winCount ?? 0,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            });
            if (changes.changes > 0) {
              seededConstitution++;
            }
          } catch (err) {
            errors.push(
              `constitution seed '${c.taskType}/${c.principle}' 寫入失敗：${String(err)}`,
            );
          }
        }
      });
      runConstitutionSeed.immediate();
    }
  }

  // ── 8. 寫入 migration-done.json 標記（防止下次重複執行）────────────────
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    doneFlag,
    JSON.stringify(
      {
        migratedAt: new Date().toISOString(),
        patterns: migratedPatterns,
        cells: migratedCells,
        seeded: seededPatterns,
        seededPersonas,
        seededConstitution,
        errorCount: errors.length,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return {
    skipped: false,
    patterns: migratedPatterns,
    cells: migratedCells,
    seeded: seededPatterns,
    seededPersonas,
    seededConstitution,
    errors,
  };
}
