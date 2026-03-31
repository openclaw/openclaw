import { DatabricksPolicyError } from "./errors.js";

const MUTATING_KEYWORDS = [
  "INSERT",
  "UPDATE",
  "DELETE",
  "MERGE",
  "ALTER",
  "DROP",
  "TRUNCATE",
  "CREATE",
  "GRANT",
  "REVOKE",
  "CALL",
  "COPY",
  "REPLACE",
] as const;

function stripSqlCommentsAndLiterals(sql: string): string {
  let result = "";
  let index = 0;

  while (index < sql.length) {
    const current = sql[index];
    const next = sql[index + 1];

    if (current === "'" || current === '"' || current === "`") {
      const quote = current;
      result += " ";
      index += 1;
      while (index < sql.length) {
        const ch = sql[index];
        const peek = sql[index + 1];
        if (ch === quote) {
          if (quote === "'" && peek === "'") {
            index += 2;
            continue;
          }
          index += 1;
          break;
        }
        index += 1;
      }
      continue;
    }

    if (current === "-" && next === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") {
        index += 1;
      }
      result += " ";
      continue;
    }

    if (current === "/" && next === "*") {
      index += 2;
      while (index < sql.length) {
        if (sql[index] === "*" && sql[index + 1] === "/") {
          index += 2;
          break;
        }
        index += 1;
      }
      result += " ";
      continue;
    }

    result += current;
    index += 1;
  }

  return result;
}

function assertSingleStatement(sql: string) {
  const withoutComments = stripSqlCommentsAndLiterals(sql);
  const trimmed = withoutComments.trim().replace(/;+\s*$/u, "");
  if (trimmed.includes(";")) {
    throw new DatabricksPolicyError("Only a single SQL statement is allowed in read-only mode.");
  }
}

function assertAllowedStartingClause(sql: string) {
  const normalized = sql.trim().replace(/\s+/gu, " ").toUpperCase();
  if (normalized.startsWith("SELECT ")) {
    return;
  }
  if (normalized.startsWith("WITH ") && /\bSELECT\b/u.test(normalized)) {
    return;
  }
  throw new DatabricksPolicyError(
    "Read-only SQL must start with SELECT or WITH ... SELECT in this Databricks runtime iteration.",
  );
}

function assertNoMutatingKeyword(sql: string) {
  const normalized = stripSqlCommentsAndLiterals(sql).toUpperCase();
  for (const keyword of MUTATING_KEYWORDS) {
    const pattern = new RegExp(`\\b${keyword}\\b`, "u");
    if (pattern.test(normalized)) {
      throw new DatabricksPolicyError(
        `Read-only SQL policy rejected statement because it contains disallowed keyword: ${keyword}.`,
      );
    }
  }
}

export function assertReadOnlySqlStatement(rawSql: string): string {
  const sql = rawSql.trim();
  if (!sql) {
    throw new DatabricksPolicyError("SQL statement is required.");
  }
  assertSingleStatement(sql);
  assertAllowedStartingClause(sql);
  assertNoMutatingKeyword(sql);
  return sql.replace(/;+\s*$/u, "");
}
