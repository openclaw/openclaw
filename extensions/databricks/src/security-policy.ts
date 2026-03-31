import { DatabricksAllowlistError, DatabricksPolicyError } from "./errors.js";

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

export function stripSqlCommentsAndLiterals(sql: string): string {
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
  const normalized = stripSqlCommentsAndLiterals(sql).trim().replace(/\s+/gu, " ").toUpperCase();
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

export function assertAllowlistTarget(params: {
  allowedCatalogs: readonly string[];
  allowedSchemas: readonly string[];
  catalog?: string;
  schema?: string;
}) {
  const allowedCatalogs = params.allowedCatalogs.map((entry) => entry.toLowerCase());
  const allowedSchemas = params.allowedSchemas.map((entry) => entry.toLowerCase());
  const targetCatalog = params.catalog?.trim().toLowerCase();
  const targetSchema = params.schema?.trim().toLowerCase();

  if (allowedCatalogs.length === 0 && allowedSchemas.length === 0) {
    return;
  }

  if (allowedCatalogs.length > 0) {
    if (!targetCatalog) {
      throw new DatabricksAllowlistError(
        "Catalog allowlist is configured, but the query target catalog could not be determined safely.",
      );
    }
    if (!allowedCatalogs.includes(targetCatalog)) {
      throw new DatabricksAllowlistError(
        `Catalog "${params.catalog}" is not in the configured allowlist.`,
      );
    }
  }

  if (allowedSchemas.length > 0) {
    if (!targetSchema) {
      throw new DatabricksAllowlistError(
        "Schema allowlist is configured, but the query target schema could not be determined safely.",
      );
    }
    if (!allowedSchemas.includes(targetSchema)) {
      throw new DatabricksAllowlistError(
        `Schema "${params.schema}" is not in the configured allowlist.`,
      );
    }
  }
}
