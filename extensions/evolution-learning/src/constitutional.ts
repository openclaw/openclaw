/**
 * 憲法辯論層 — Constitutional AI Critique
 *
 * 從 constitution_principles 表讀取原則，組裝批評 prompt，
 * 並透過 causal_edges 學習有效原則（constitution_win 關係）。
 *
 * 注意：此模組不直接呼叫 LLM，只組裝 promptText 供 mcp/server.ts 使用。
 */

import Database from "better-sqlite3";

// ── 公開型別 ────────────────────────────────────────────────────────────────

export interface ConstitutionalPrinciple {
  id: string;
  task_type: string;
  principle: string;
  weight: number;
  win_count: number;
}

export interface ConstitutionalCritique {
  personaSlug: string;
  principle: string; // 引用的原則
  score: number; // 0-1 符合度
  suggestion: string; // 修正建議
  promptText: string; // 組裝好的 prompt（供 MCP server 呼叫 Claude）
}

// ── 預設原則（雙保險 fallback，seed-constitution.jsonl 應已在 migrate 時載入）─

const DEFAULT_PRINCIPLES: Record<string, string[]> = {
  architecture: [
    "最小化系統複雜度",
    "優先可維護性而非過早優化",
    "明確的責任邊界，避免模組間隱性耦合",
  ],
  security: [
    "最小權限原則：每個元件只擁有完成任務所需的最小權限",
    "深度防禦：不依賴單一安全控制",
    "永不信任輸入：所有外部資料都需驗證",
  ],
  cost_optimization: [
    "使用最便宜能完成任務的模型（優先 Haiku，而非 Sonnet）",
    "本地計算優先於 API 呼叫",
    "快取優先：重複計算的結果必須快取",
  ],
  code_quality: [
    "程式碼是寫給人讀的，順帶讓機器執行",
    "每個函數只做一件事",
    "錯誤處理必須明確，不得靜默吞掉例外",
  ],
  agent_design: [
    "代理決策必須可解釋、可稽核",
    "費用有上限：任何代理呼叫前必須預估費用",
    "失敗必須優雅退化，而非整體崩潰",
  ],
};

// ── 內部工具 ────────────────────────────────────────────────────────────────

/** 插入預設原則（雙保險，表空時才呼叫）*/
export function seedDefaultConstitution(taskType: string, db: Database.Database): void {
  const principles = DEFAULT_PRINCIPLES[taskType] ?? DEFAULT_PRINCIPLES["code_quality"];

  const insert = db.prepare(`
    INSERT OR IGNORE INTO constitution_principles
      (id, task_type, principle, weight, win_count, created_at, updated_at)
    VALUES
      (@id, @taskType, @principle, @weight, @winCount, @createdAt, @updatedAt)
  `);

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    for (const principle of principles) {
      insert.run({
        id: crypto.randomUUID(),
        taskType: taskType,
        principle,
        weight: 1.0,
        winCount: 0,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
  run();
}

// ── 主要導出函數 ──────────────────────────────────────────────────────────────

/**
 * 從 constitution_principles 表讀取指定 taskType 的原則（依 weight 降序）。
 * 表空時自動呼叫 seedDefaultConstitution 作為雙保險。
 */
export function getConstitution(
  taskType: string,
  db: Database.Database,
): ConstitutionalPrinciple[] {
  const rows = db
    .prepare(`
    SELECT id, task_type, principle, weight, win_count
    FROM constitution_principles
    WHERE task_type = ?
    ORDER BY weight DESC
  `)
    .all(taskType) as ConstitutionalPrinciple[];

  if (rows.length === 0) {
    seedDefaultConstitution(taskType, db);
    return db
      .prepare(`
      SELECT id, task_type, principle, weight, win_count
      FROM constitution_principles
      WHERE task_type = ?
      ORDER BY weight DESC
    `)
      .all(taskType) as ConstitutionalPrinciple[];
  }

  return rows;
}

/**
 * 組裝憲法批評 prompt（不呼叫 LLM，供 mcp/server.ts 注入 Claude）。
 * score 與 suggestion 在此為佔位值，由 Claude 回傳後填入。
 */
export function constitutionalCritique(
  proposal: string,
  principles: ConstitutionalPrinciple[],
  personaSlug: string,
): ConstitutionalCritique[] {
  return principles.map((p) => {
    const promptText = [
      `你是角色「${personaSlug}」，正在從憲法原則角度審查以下提案。`,
      ``,
      `憲法原則（weight=${p.weight.toFixed(2)}）：`,
      `"${p.principle}"`,
      ``,
      `提案內容：`,
      proposal,
      ``,
      `請回答（JSON 格式）：`,
      `{`,
      `  "score": <0.0-1.0，此提案符合原則的程度>,`,
      `  "suggestion": "<具體修正建議，若完全符合則填 '無需修正'>"`,
      `}`,
    ].join("\n");

    return {
      personaSlug,
      principle: p.principle,
      score: 0, // 待 LLM 填入
      suggestion: "", // 待 LLM 填入
      promptText,
    };
  });
}

/**
 * 從 causal_edges 同步 constitution_win 關係的 weight 回 constitution_principles。
 * Hermes 學習後呼叫此函數更新原則有效性權重。
 */
export function hermesUpdateConstitution(taskType: string, db: Database.Database): void {
  // 計算每條原則的平均 weight（from causal_edges where relation = 'constitution_win'）
  const edges = db
    .prepare(`
    SELECT to_slug AS principle, AVG(weight) AS avg_weight
    FROM causal_edges
    WHERE relation = 'constitution_win'
    GROUP BY to_slug
  `)
    .all() as { principle: string; avg_weight: number }[];

  if (edges.length === 0) {
    return;
  }

  const update = db.prepare(`
    UPDATE constitution_principles
    SET weight = @weight, updated_at = @updatedAt
    WHERE task_type = @taskType AND principle = @principle
  `);

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    for (const edge of edges) {
      // weight 限制在 0.1-2.0 之間，避免極端值
      const clampedWeight = Math.max(0.1, Math.min(2.0, edge.avg_weight));
      update.run({
        weight: clampedWeight,
        updatedAt: now,
        taskType,
        principle: edge.principle,
      });
    }
  });
  run();
}

/**
 * 記錄原則是否有效，寫入 causal_edges 並更新 win_count。
 *
 * @param taskType      任務類型（對應 constitution_principles.task_type）
 * @param principle     原則內容（作為 to_slug）
 * @param wasEffective  true → weight 1.0（有效），false → weight -0.5（無效）
 * @param db            SQLite 實例
 */
export function learnEffectivePrinciple(
  taskType: string,
  principle: string,
  wasEffective: boolean,
  db: Database.Database,
): void {
  const weight = wasEffective ? 1.0 : -0.5;
  const now = new Date().toISOString();

  db.transaction(() => {
    // 寫入因果邊（relation = 'constitution_win'）
    db.prepare(`
      INSERT INTO causal_edges
        (id, from_slug, to_slug, relation, weight, valid_from, recorded_at)
      VALUES
        (@id, @fromSlug, @toSlug, 'constitution_win', @weight, @validFrom, @recordedAt)
    `).run({
      id: crypto.randomUUID(),
      fromSlug: taskType,
      toSlug: principle,
      weight,
      validFrom: now,
      recordedAt: now,
    });

    // 有效時更新 win_count
    if (wasEffective) {
      db.prepare(`
        UPDATE constitution_principles
        SET win_count = win_count + 1, updated_at = @updatedAt
        WHERE task_type = @taskType AND principle = @principle
      `).run({ updatedAt: now, taskType, principle });
    }
  })();
}
