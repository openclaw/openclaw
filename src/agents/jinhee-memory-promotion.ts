/**
 * jinhee-memory-promotion.ts — MEMORY-PROMOTION-004
 *
 * Append-only canonical memory promotion from MEMORY-CANDIDATE-003 candidates.
 * SQLite access via CLI (sqlite3) to avoid native module dependency.
 * INSERT only into canonical_memories. All other write operations denied.
 */

import { execSync } from "child_process";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

export type ApprovedMemoryPromotion = {
  sourceCandidateId: string;
  kind: string;
  canonicalText: string;
  confidence: number;
  importance: number;
  sourceLogIds: number[];
  reason: string;
};

export type PromoteResult =
  | {
      ok: true;
      dryRun: boolean;
      insertedIds: number[];
      skipped: Array<{ sourceCandidateId: string; reason: string }>;
      beforeCount: number;
      afterCount: number;
      rollbackSql: string;
    }
  | {
      ok: false;
      reason: string;
    };

/** Sensitive keywords that must not appear in candidate text */
const SENSITIVE_PATTERN = /(?:token|api_key|secret|password|refresh_token|authorization|bearer|client_secret|access_token|oauth)/iu;

/** SQL patterns: what we allow vs deny */
const ALLOWED_INSERT = /\bINSERT\s+INTO\s+canonical_memories\b/iu;
const DENY_WRITE = /\b(?:DELETE|UPDATE|ALTER|DROP|CREATE|VACUUM|REPLACE|TRUNCATE|ATTACH|DETACH)\b/iu;
const DENY_OTHER_INSERT = /\bINSERT\s+INTO\s+(?!canonical_memories\b)/iu;

export function isAllowedPromotionSql(sql: string): boolean {
  // Strip comments
  const stripped = sql.replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (!stripped) return false;

  // Count semicolons OUTSIDE single-quoted strings only
  const outsideQuotes = stripped.replace(/'[^']*'/g, "''");
  const semiCount = (outsideQuotes.match(/;/g) || []).length;
  if (semiCount > 1) return false;
  if (semiCount === 1 && !outsideQuotes.trimEnd().endsWith(";")) return false;

  // Compare against the SQL without string contents for deny checks
  const clean = semiCount === 1 ? outsideQuotes.trimEnd().slice(0, -1).trim() : outsideQuotes;
  if (DENY_WRITE.test(clean)) return false;
  if (DENY_OTHER_INSERT.test(clean)) return false;
  if (!ALLOWED_INSERT.test(clean)) return false;
  return true;
}

export function assertAllowedPromotionSql(sql: string): void {
  if (!isAllowedPromotionSql(sql)) {
    throw new Error(`Promotion DB write denied: ${sql.slice(0, 80)}`);
  }
}

/** Check if a candidate text contains sensitive data */
export function hasSensitiveContent(text: string): boolean {
  return SENSITIVE_PATTERN.test(text);
}

/** Validate a single ApprovedMemoryPromotion item */
export function isValidPromotionItem(
  item: ApprovedMemoryPromotion,
  _index: number,
): string | null {
  if (!item.canonicalText || item.canonicalText.trim().length === 0) {
    return "empty canonicalText";
  }
  if (hasSensitiveContent(item.canonicalText)) {
    return "sensitive content in canonicalText";
  }
  if (!item.kind || typeof item.kind !== "string") {
    return "missing or invalid kind";
  }
  if (typeof item.confidence !== "number" || item.confidence < 0 || item.confidence > 1) {
    return "invalid confidence";
  }
  if (typeof item.importance !== "number" || item.importance < 0 || item.importance > 1) {
    return "invalid importance";
  }
  return null;
}

function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/** Run SQL via temp file to avoid shell escaping issues */
function runSqlViaTemp(dbPath: string, sql: string): string {
  const tmpFile = join(tmpdir(), `jinhee-sql-${Date.now()}-${Math.random().toString(36).slice(2)}.sql`);
  try {
    writeFileSync(tmpFile, sql, "utf-8");
    return execSync(`sqlite3 "${dbPath}" < "${tmpFile}"`, {
      encoding: "utf-8",
      timeout: 10000,
    }).trim();
  } finally {
    try { unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

function readCount(dbPath: string): number {
  const out = runSqlViaTemp(`file:${dbPath}?mode=ro`, "SELECT COUNT(*) FROM canonical_memories;");
  return parseInt(out);
}

/**
 * Promote approved candidates into canonical_memories.
 *
 * @param items - Approved promotion items
 * @param options
 *   - dbPath: path to jinhee.db (default: /home/savit/ai/jinhee_data/jinhee.db)
 *   - dryRun: if true, only simulate (default: true)
 *   - maxBatch: max items to process (default: 20)
 */
export async function promoteApprovedCanonicalMemories(
  items: ApprovedMemoryPromotion[],
  options?: {
    dbPath?: string;
    dryRun?: boolean;
    maxBatch?: number;
  },
): Promise<PromoteResult> {
  const dbPath = options?.dbPath ?? "/home/savit/ai/jinhee_data/jinhee.db";
  const dryRun = options?.dryRun !== false;
  const maxBatch = options?.maxBatch ?? 20;

  if (!items || items.length === 0) {
    return { ok: false, reason: "empty promotion batch" };
  }

  const batch = items.slice(0, maxBatch);
  const skipped: Array<{ sourceCandidateId: string; reason: string }> = [];
  const valid: ApprovedMemoryPromotion[] = [];

  for (const item of batch) {
    const err = isValidPromotionItem(item, valid.length + skipped.length);
    if (err) {
      skipped.push({ sourceCandidateId: item.sourceCandidateId, reason: err });
      continue;
    }
    valid.push(item);
  }

  if (valid.length === 0) {
    const allSkipped = skipped.map((s) => `${s.sourceCandidateId}: ${s.reason}`).join("; ");
    return { ok: false, reason: `all ${batch.length} items skipped: ${allSkipped}` };
  }

  try {
    const beforeCount = readCount(dbPath);
    if (isNaN(beforeCount)) {
      return { ok: false, reason: "cannot read canonical_memories count" };
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        insertedIds: [],
        skipped,
        beforeCount,
        afterCount: beforeCount,
        rollbackSql: `-- DRY RUN -- no rollback needed\n-- Would insert ${valid.length} rows\n`,
      };
    }

    // Build single-line insert statements
    const now = new Date().toISOString();
    const insertStatements: string[] = [];

    const beforeCheck = readCount(dbPath);
    if (isNaN(beforeCheck)) {
      return { ok: false, reason: "cannot read canonical_memories count" };
    }

    for (const item of valid) {
      const metadata = JSON.stringify({
        sourceCandidateId: item.sourceCandidateId,
        kind: item.kind,
        sourceLogIds: item.sourceLogIds,
        importance: item.importance,
        reason: item.reason,
        source: 'memory_candidate_003',
      });

      const sql = `INSERT INTO canonical_memories (content, memory_type, truth_confidence, source_count, last_confirmed) VALUES (` +
        `'${escapeSql(item.canonicalText)}', ` +
        `'${escapeSql(metadata)}', ` +
        `${Math.round(item.confidence * 100) * 10}, ` +
        `${item.sourceLogIds.length}, ` +
        `'${now}'` +
        `);`;

      assertAllowedPromotionSql(sql);
      insertStatements.push(sql);
    }

    // Build full transaction SQL
    const fullSql = `BEGIN TRANSACTION;\n${insertStatements.join("\n")}\nCOMMIT;`;

    // Execute via temp file
    runSqlViaTemp(dbPath, fullSql);

    // Get after count
    const afterCount = readCount(dbPath);
    if (isNaN(afterCount)) {
      return { ok: false, reason: "cannot read after count" };
    }

    // Get inserted IDs — match by last_confirmed timestamp (our batch)
    const idOut = runSqlViaTemp(
      `file:${dbPath}?mode=ro`,
      `SELECT id FROM canonical_memories WHERE last_confirmed = '${now}' ORDER BY id;`,
    );
    const insertedIds: number[] = idOut
      .split("\n")
      .map((s) => parseInt(s.trim()))
      .filter((n) => !isNaN(n));

    // Generate rollback SQL (string only, DO NOT EXECUTE)
    const rollbackSql =
      insertedIds.length > 0
        ? `-- Rollback SQL -- DO NOT RUN WITHOUT APPROVAL\nDELETE FROM canonical_memories WHERE id IN (${insertedIds.join(", ")});\n`
        : "-- No rows inserted\n";

    return {
      ok: true,
      dryRun: false,
      insertedIds,
      skipped,
      beforeCount,
      afterCount,
      rollbackSql,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, reason: `promotion failed: ${message}` };
  }
}

/**
 * Parse a batch markdown file into ApprovedMemoryPromotion items.
 */
export function parseBatchFile(text: string): ApprovedMemoryPromotion[] {
  const items: ApprovedMemoryPromotion[] = [];
  // Split on ### PROMOTE-XXX headers (also handle ### CAND-XXX from report format)
  const sections = text.split(/\n### (?:PROMOTE-\d+|CAND-[A-Z]+-\d+)\n/);

  for (const section of sections) {
    const sid = section.match(/sourceCandidateId:\s*(\S+)/);
    const kind = section.match(/kind:\s*(\S+)/);
    const ct = section.match(/canonicalText:\s*(.+?)(?:\n(?=- )|$)/s);
    const conf = section.match(/confidence:\s*([\d.]+)/);
    const imp = section.match(/importance:\s*([\d.]+)/);
    const src = section.match(/sourceLogIds:\s*\[([^\]]*)\]/);
    const reason = section.match(/reason:\s*(.+?)(?:\n(?=- )|$)/s);

    if (!sid || !kind || !ct || !conf || !imp) continue;

    const sourceLogIds: number[] = src
      ? src[1]
          .split(",")
          .map((s: string) => parseInt(s.trim()))
          .filter((n: number) => !isNaN(n))
      : [];

    items.push({
      sourceCandidateId: sid[1].trim(),
      kind: kind[1].trim(),
      canonicalText: ct[1].trim(),
      confidence: parseFloat(conf[1]),
      importance: parseFloat(imp[1]),
      sourceLogIds,
      reason: reason ? reason[1].trim() : "",
    });
  }

  // Try alternative: items might be in numbered lists (from report format)
  if (items.length === 0) {
    // Fallback: try matching inline format
    const lines = text.split("\n");
    let current: Partial<ApprovedMemoryPromotion> | null = null;
    for (const line of lines) {
      const sid = line.match(/^\*\*sourceCandidateId:\*\*\s*(\S+)/);
      const kind = line.match(/^\*\*kind:\*\*\s*`?(\w+)`?/);
      const ct = line.match(/^\*\*text:\*\*\s*(.+)/);
      const conf = line.match(/^\*\*confidence:\*\*\s*([\d.]+)/);
      const imp = line.match(/^\*\*importance:\*\*\s*([\d.]+)/);
      const src = line.match(/^\*\*sourceLogIds:\*\*\s*`?\[([^\]]*)\]`?/);
      const reason = line.match(/^\*\*reason:\*\*\s*(.+)/);

      if (line.startsWith("### CAND-") || line.startsWith("### PROMOTE-")) {
        if (current && current.sourceCandidateId && current.kind && current.canonicalText) {
          items.push({
            sourceCandidateId: current.sourceCandidateId,
            kind: current.kind,
            canonicalText: current.canonicalText,
            confidence: current.confidence ?? 0.5,
            importance: current.importance ?? 0.5,
            sourceLogIds: current.sourceLogIds ?? [],
            reason: current.reason ?? "",
          });
        }
        current = {};
      } else if (current) {
        if (sid) current.sourceCandidateId = sid[1];
        if (kind) current.kind = kind[1];
        if (ct) current.canonicalText = ct[1];
        if (conf) current.confidence = parseFloat(conf[1]);
        if (imp) current.importance = parseFloat(imp[1]);
        if (src) current.sourceLogIds = src[1].split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n));
        if (reason) current.reason = reason[1];
      }
    }
    // Push last
    if (current && current.sourceCandidateId && current.kind && current.canonicalText) {
      items.push({
        sourceCandidateId: current.sourceCandidateId,
        kind: current.kind,
        canonicalText: current.canonicalText,
        confidence: current.confidence ?? 0.5,
        importance: current.importance ?? 0.5,
        sourceLogIds: current.sourceLogIds ?? [],
        reason: current.reason ?? "",
      });
    }
  }

  return items;
}
