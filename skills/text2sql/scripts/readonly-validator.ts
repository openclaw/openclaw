/**
 * Validates that a SQL string is a read-only SELECT (or SELECT via CTE).
 * Used by the text2sql script to reject DML/DDL.
 */

// Single-token dangerous keywords; COMMENT/DO/LOCK use multi-word patterns to avoid false positives on column names.
const FORBIDDEN =
  /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE|EXECUTE|CALL|COPY|EXPLAIN|PREPARE|DEALLOCATE|SET|RESET|LISTEN|NOTIFY|VACUUM|REINDEX|CLUSTER)\b|\bDO\s+\$|\bCOMMENT\s+ON\b|\bLOCK\s+TABLE\b/i;

export function isReadOnlySelect(sql: string): boolean {
  // Strip comments naively; does not account for -- or /* */ inside string literals (known limitation).
  const trimmed = sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/--[^\n]*/g, "")
    .trim();
  if (FORBIDDEN.test(trimmed)) return false;
  const upper = trimmed.toUpperCase();
  return upper.startsWith("SELECT") || upper.startsWith("WITH");
}
