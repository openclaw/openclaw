/**
 * SQL security validator for LLM-generated SQL queries.
 *
 * Ported from Python app.py:4418-4484 (_validate_llm_sql).
 * All checks are pure functions with no external dependencies.
 */

/** Tables allowed in LLM-generated SQL */
const ALLOWED_TABLES = new Set(["feed_monitor_item", "feed_monitor_item_data"]);

/** Dangerous SQL keywords that must never appear */
const DANGEROUS_KEYWORDS = [
  /\bINSERT\b/,
  /\bUPDATE\b/,
  /\bDELETE\b/,
  /\bDROP\b/,
  /\bALTER\b/,
  /\bCREATE\b/,
  /\bTRUNCATE\b/,
  /\bUNION\b/,
  /\bGRANT\b/,
  /\bREVOKE\b/,
  /\bEXEC\b/,
  /\bEXECUTE\b/,
];

/** Dangerous SQL functions that must never appear */
const DANGEROUS_FUNCTIONS = [
  /\bLOAD_FILE\b/,
  /\bINTO\s+OUTFILE\b/,
  /\bINTO\s+DUMPFILE\b/,
  /\bBENCHMARK\b/,
  /\bSLEEP\b/,
  /\bWAITFOR\s+DELAY\b/,
];

/**
 * Validate that an LLM-generated SQL query is safe to execute.
 *
 * Checks:
 * 1. Must start with SELECT
 * 2. Referenced tables must be in the whitelist
 * 3. Must include topicId/slaveTopicId filter (cannot be bypassed with OR)
 * 4. Must include skip=0 condition
 * 5. No dangerous keywords
 * 6. No dangerous functions
 */
export function validateLlmSql(
  sql: string,
  topicId: number,
  useSlaveTopic: boolean,
): { valid: true } | { valid: false; reason: string } {
  const sqlUpper = sql.trim().toUpperCase();

  // 1. Must start with SELECT
  if (!sqlUpper.startsWith("SELECT")) {
    return { valid: false, reason: "not SELECT" };
  }

  // 2. Table whitelist check
  const fromTables = [...sql.matchAll(/\bFROM\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  const joinTables = [...sql.matchAll(/\bJOIN\s+(\w+)/gi)].map((m) => m[1].toLowerCase());
  const allTables = new Set([...fromTables, ...joinTables]);

  if (allTables.size === 0 || ![...allTables].every((t) => ALLOWED_TABLES.has(t))) {
    return { valid: false, reason: `tables ${[...allTables].join(", ")} not in whitelist` };
  }

  // 3. Must include topicId/slaveTopicId filter
  const topicField = useSlaveTopic ? "slaveTopicId" : "topicId";
  const topicPattern = new RegExp(`\\b${topicField}\\s*=\\s*${topicId}\\b`);
  if (!topicPattern.test(sql)) {
    return { valid: false, reason: `missing ${topicField}=${topicId}` };
  }

  // 3.5. Check for OR bypass after topicId condition
  const bypassPattern = new RegExp(`${topicField}\\s*=\\s*${topicId}\\b\\s+OR\\b`, "i");
  if (bypassPattern.test(sql)) {
    return { valid: false, reason: `OR bypass detected on ${topicField}` };
  }

  // 3.6. Must include skip=0
  if (!/\bskip\s*=\s*0\b/i.test(sql)) {
    return { valid: false, reason: "missing skip=0" };
  }

  // 4. No dangerous keywords
  for (const pattern of DANGEROUS_KEYWORDS) {
    if (pattern.test(sqlUpper)) {
      return { valid: false, reason: `dangerous keyword ${pattern.source}` };
    }
  }

  // 5. No dangerous functions
  for (const pattern of DANGEROUS_FUNCTIONS) {
    if (pattern.test(sqlUpper)) {
      return { valid: false, reason: `dangerous function ${pattern.source}` };
    }
  }

  return { valid: true };
}
