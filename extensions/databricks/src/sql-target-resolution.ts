import { stripSqlCommentsAndLiterals } from "./security-policy.js";

export type ResolvedSqlTarget = {
  catalog?: string;
  schema?: string;
  table: string;
  raw: string;
};

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function parseQualifiedReference(value: string): ResolvedSqlTarget | null {
  const compact = value.replace(/\s*\.\s*/gu, ".");
  const parts = compact.split(".").map((part) => normalizeIdentifier(part));
  if (parts.length === 2) {
    const [schema, table] = parts;
    if (!schema || !table) {
      return null;
    }
    return { schema, table, raw: compact };
  }
  if (parts.length === 3) {
    const [catalog, schema, table] = parts;
    if (!catalog || !schema || !table) {
      return null;
    }
    return { catalog, schema, table, raw: compact };
  }
  return null;
}

export function resolveSqlTargets(rawSql: string): ResolvedSqlTarget[] {
  const sanitized = stripSqlCommentsAndLiterals(rawSql);
  const references = new Set<string>();
  const targets: ResolvedSqlTarget[] = [];
  const pattern = /\b(?:from|join)\s+((?:[A-Za-z_][\w$]*)(?:\s*\.\s*[A-Za-z_][\w$]*){1,2})\b/giu;

  for (const match of sanitized.matchAll(pattern)) {
    const rawReference = match[1];
    if (!rawReference) {
      continue;
    }
    const target = parseQualifiedReference(rawReference);
    if (!target) {
      continue;
    }
    const key = `${target.catalog ?? ""}|${target.schema ?? ""}|${target.table}`;
    if (references.has(key)) {
      continue;
    }
    references.add(key);
    targets.push(target);
  }

  return targets;
}
