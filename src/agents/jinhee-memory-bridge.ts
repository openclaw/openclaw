/**
 * MEMORY-BRIDGE-001: JinheeOS canonical memory read-only bridge.
 *
 * Reads canonical_memories from jinhee.db (read-only) and returns a short
 * markdown memory block for injection into the OpenClaw agent context.
 *
 * Design constraints:
 *  - SELECT only, mode=ro
 *  - No INSERT/UPDATE/DELETE/ALTER/DROP/CREATE/VACUUM
 *  - Timeout + row-limit + char-limit guards
 *  - Sensitive keyword redaction
 *  - Silent degrade on any failure (returns null)
 *
 * Uses Node.js built-in node:sqlite — no external dependencies needed.
 */

import { access } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CanonicalMemoryRow = {
  id: number;
  content: string;
  truthConfidence: number;
  sourceCount: number;
  lastConfirmed: string | null;
};

export type JinheeMemoryBridgeOptions = {
  /**
   * Full path to the JinheeOS SQLite database.
   * @default "/home/savit/ai/jinhee_data/jinhee.db"
   */
  dbPath?: string;

  /**
   * Maximum number of canonical memory rows to load.
   * @default 12
   */
  maxRows?: number;

  /**
   * Maximum characters per individual memory entry.
   * @default 240
   */
  maxCharsPerMemory?: number;

  /**
   * Maximum total characters for the entire memory block.
   * @default 2400
   */
  maxTotalChars?: number;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_JINHEE_DB_PATH = "/home/savit/ai/jinhee_data/jinhee.db";
const DEFAULT_MAX_ROWS = 12;
const DEFAULT_MAX_CHARS_PER_MEMORY = 240;
const DEFAULT_MAX_TOTAL_CHARS = 2400;

/**
 * Canonical memories with truth_confidence >= LOW_TRUST_THRESHOLD are skipped
 * (they are low-quality/test items that should not appear in agent context).
 */
const LOW_TRUST_THRESHOLD = 1000;

/**
 * Content matching any of these patterns is excluded from output.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(token|api_key|secret|password|refresh_token|authorization|bearer)\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isSensitiveContent(content: string): boolean {
  return SENSITIVE_PATTERNS.some((re) => re.test(content));
}

function truncateLine(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line;
  const truncated = line.slice(0, maxChars - 1);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > maxChars * 0.7) {
    return truncated.slice(0, lastSpace) + "…";
  }
  return truncated + "…";
}

function sanitizeContent(raw: string, maxChars: number): string {
  const cleaned = raw.trim().replace(/\r\n/g, "\n").replace(/\n+/g, " │ ");
  return truncateLine(cleaned, maxChars);
}

// ---------------------------------------------------------------------------
// Formatting (pure function — testable without I/O)
// ---------------------------------------------------------------------------

/**
 * Format a list of canonical memory rows into a markdown memory block.
 * Pure function — no I/O, no DB dependency.
 *
 * Returns {@code null} when no rows pass the filter, or when the result
 * would only contain a header.
 */
export function formatCanonicalMemoryBlock(
  rows: CanonicalMemoryRow[],
  options?: {
    maxRows?: number;
    maxCharsPerMemory?: number;
    maxTotalChars?: number;
  },
): string | null {
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCharsPerMemory = options?.maxCharsPerMemory ?? DEFAULT_MAX_CHARS_PER_MEMORY;
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  if (!rows || rows.length === 0) return null;

  const lines: string[] = ["[JinheeOS Canonical Memory]"];
  let totalChars = lines[0].length;

  for (const row of rows) {
    // Skip low-trust items (truth_confidence >= 1000)
    if (row.truthConfidence >= LOW_TRUST_THRESHOLD) continue;

    // Skip sensitive content (token, api_key, password, etc.)
    if (isSensitiveContent(row.content)) continue;

    // Skip empty/trivial content
    const raw = (row.content ?? "").trim();
    if (!raw || raw.length < 2) continue;

    // Skip JSON objects (canonical memories should be plain text)
    if (raw.startsWith("{") && raw.endsWith("}")) continue;

    const sanitized = sanitizeContent(raw, maxCharsPerMemory);
    const bullet = `- ${sanitized}`;

    if (totalChars + bullet.length + 1 > maxTotalChars) break;

    lines.push(bullet);
    totalChars += bullet.length + 1;

    if (lines.length - 1 >= maxRows) break;
  }

  if (lines.length <= 1) return null;
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// DB I/O wrapper
// ---------------------------------------------------------------------------

/**
 * Load canonical memories from jinhee.db and return a formatted markdown
 * memory block suitable for injection into agent context.
 *
 * Uses Node.js built-in `node:sqlite` — no external dependencies.
 * Opens the database with `readWrite: false` (read-only mode).
 * SELECT only. No writes of any kind.
 *
 * Returns `null` on any failure (file missing, table missing, error)
 * so the caller can silently degrade.
 */
export async function loadJinheeCanonicalMemoryBlock(
  options?: JinheeMemoryBridgeOptions,
): Promise<string | null> {
  const dbPath = options?.dbPath ?? DEFAULT_JINHEE_DB_PATH;
  const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
  const maxCharsPerMemory = options?.maxCharsPerMemory ?? DEFAULT_MAX_CHARS_PER_MEMORY;
  const maxTotalChars = options?.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS;

  // --- Early exit: DB file doesn't exist ---
  try {
    await access(dbPath);
  } catch {
    return null;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let db: any;

  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readWrite: false });
    // Set busy timeout
    db.exec("PRAGMA busy_timeout = 800");
  } catch {
    return null;
  }

  try {
    // --- Verify table exists ---
    const tableResult = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_memories'")
      .get() as { name: string } | undefined;

    if (!tableResult) {
      return null;
    }

    // --- SELECT only ---
    const rows = db
      .prepare(
        "SELECT id, content, truth_confidence, source_count, last_confirmed " +
          "FROM canonical_memories ORDER BY id DESC LIMIT ?",
      )
      .all(maxRows * 2) as Array<{
      id: number;
      content: string;
      truth_confidence: number;
      source_count: number;
      last_confirmed: string | null;
    }>;

    if (!rows || rows.length === 0) {
      return null;
    }

    // Map snake_case → camelCase for the formatter
    const mapped: CanonicalMemoryRow[] = rows.map((r) => ({
      id: r.id,
      content: r.content,
      truthConfidence: r.truth_confidence,
      sourceCount: r.source_count,
      lastConfirmed: r.last_confirmed,
    }));

    return formatCanonicalMemoryBlock(mapped, {
      maxRows,
      maxCharsPerMemory,
      maxTotalChars,
    });
  } finally {
    db.close();
  }
}
