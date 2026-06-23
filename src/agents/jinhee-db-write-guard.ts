const WRITE_KEYWORD_PATTERN =
  /\b(?:DELETE|UPDATE|ALTER|DROP|CREATE|VACUUM|REPLACE|TRUNCATE|ATTACH|DETACH)\b/iu;
const WRITABLE_SCHEMA_PATTERN = /\bPRAGMA\s+writable_schema\b/iu;
const CANONICAL_MEMORY_INSERT_PATTERN = /\bINSERT\s+INTO\s+canonical_memories\b/iu;
const CONVERSATION_LOG_INSERT_PATTERN = /^INSERT\s+INTO\s+conversation_logs\b/iu;

function stripLeadingWhitespaceAndComments(sql: string): string {
  let index = 0;
  while (index < sql.length) {
    const rest = sql.slice(index);
    const whitespace = rest.match(/^\s+/u);
    if (whitespace) {
      index += whitespace[0].length;
      continue;
    }
    if (rest.startsWith("--")) {
      const nextLine = rest.indexOf("\n");
      if (nextLine === -1) {
        return "";
      }
      index += nextLine + 1;
      continue;
    }
    if (rest.startsWith("/*")) {
      const close = rest.indexOf("*/");
      if (close === -1) {
        return "";
      }
      index += close + 2;
      continue;
    }
    break;
  }
  return sql.slice(index).trimStart();
}

function countStatementSeparators(sql: string): number {
  let count = 0;
  let quote: "'" | '"' | "`" | undefined;
  let bracketQuoted = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    const next = sql[index + 1];
    if (quote) {
      if (char === quote) {
        if (next === quote) {
          index += 1;
        } else {
          quote = undefined;
        }
      }
      continue;
    }
    if (bracketQuoted) {
      if (char === "]") {
        bracketQuoted = false;
      }
      continue;
    }
    if (char === "-" && next === "-") {
      const nextLine = sql.indexOf("\n", index + 2);
      index = nextLine === -1 ? sql.length : nextLine;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = sql.indexOf("*/", index + 2);
      index = close === -1 ? sql.length : close + 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "[") {
      bracketQuoted = true;
      continue;
    }
    if (char === ";") {
      count += 1;
    }
  }
  return count;
}

function hasTrailingOnlySeparator(sql: string): boolean {
  const trimmed = sql.trimEnd();
  return trimmed.endsWith(";") && countStatementSeparators(trimmed) === 1;
}

export function isAllowedJinheeWrite(sql: string): boolean {
  const normalized = stripLeadingWhitespaceAndComments(sql);
  if (!normalized) {
    return false;
  }
  const separatorCount = countStatementSeparators(normalized);
  if (separatorCount > 1 || (separatorCount === 1 && !hasTrailingOnlySeparator(normalized))) {
    return false;
  }
  const statement = hasTrailingOnlySeparator(normalized)
    ? normalized.trimEnd().slice(0, -1)
    : normalized;
  if (!CONVERSATION_LOG_INSERT_PATTERN.test(statement)) {
    return false;
  }
  return !(
    WRITE_KEYWORD_PATTERN.test(statement) ||
    WRITABLE_SCHEMA_PATTERN.test(statement) ||
    CANONICAL_MEMORY_INSERT_PATTERN.test(statement)
  );
}

export function assertAllowedJinheeWrite(sql: string): void {
  if (!isAllowedJinheeWrite(sql)) {
    throw new Error("Jinhee DB write denied by guard");
  }
}
