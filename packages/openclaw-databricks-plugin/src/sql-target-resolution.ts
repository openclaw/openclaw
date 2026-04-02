export type ResolvedSqlTarget = {
  catalog?: string;
  schema?: string;
  table: string;
  raw: string;
};

type SqlToken = {
  kind: "identifier" | "symbol" | "keyword";
  value: string;
};

type ParseQualifiedResult =
  | { kind: "target"; nextIndex: number; target: ResolvedSqlTarget }
  | { kind: "cte"; nextIndex: number }
  | { kind: "ambiguous"; nextIndex: number }
  | { kind: "malformed"; nextIndex: number };

export type SqlTargetResolution = {
  targets: ResolvedSqlTarget[];
  ambiguous: boolean;
};

const CLAUSE_BOUNDARY_KEYWORDS = new Set([
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "QUALIFY",
  "WINDOW",
  "ON",
  "USING",
]);

const PARSER_KEYWORDS = new Set([
  "WITH",
  "AS",
  "FROM",
  "JOIN",
  "LEFT",
  "RIGHT",
  "FULL",
  "INNER",
  "CROSS",
  "ON",
  "USING",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "LIMIT",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "QUALIFY",
  "WINDOW",
]);

function normalizeIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

function stripSqlCommentsAndStringLiterals(sql: string): string {
  let result = "";
  for (let index = 0; index < sql.length; ) {
    const current = sql[index];
    const next = sql[index + 1];
    if (!current) {
      break;
    }

    if (current === "'" || current === '"') {
      const quote = current;
      result += " ";
      index += 1;
      while (index < sql.length) {
        const char = sql[index];
        const peek = sql[index + 1];
        if (char === quote) {
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

function buildResolvedTarget(parts: string[]): ResolvedSqlTarget | null {
  if (parts.length === 2) {
    const [schema, table] = parts;
    if (!schema || !table) {
      return null;
    }
    return { schema, table, raw: `${schema}.${table}` };
  }
  if (parts.length === 3) {
    const [catalog, schema, table] = parts;
    if (!catalog || !schema || !table) {
      return null;
    }
    return { catalog, schema, table, raw: `${catalog}.${schema}.${table}` };
  }
  return null;
}

function isIdentifierStart(char: string): boolean {
  return /[A-Za-z_]/u.test(char);
}

function isIdentifierPart(char: string): boolean {
  return /[A-Za-z0-9_$]/u.test(char);
}

function tokenizeSql(sql: string): { tokens: SqlToken[]; malformed: boolean } {
  const tokens: SqlToken[] = [];
  for (let index = 0; index < sql.length; ) {
    const char = sql[index];
    if (!char) {
      break;
    }

    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }

    if (char === "`") {
      let cursor = index + 1;
      let value = "";
      let closed = false;
      while (cursor < sql.length) {
        const current = sql[cursor];
        if (current === "`") {
          if (sql[cursor + 1] === "`") {
            value += "`";
            cursor += 2;
            continue;
          }
          closed = true;
          break;
        }
        value += current;
        cursor += 1;
      }
      if (!closed) {
        return { tokens: [], malformed: true };
      }
      const normalized = normalizeIdentifier(value);
      if (!normalized) {
        return { tokens: [], malformed: true };
      }
      tokens.push({ kind: "identifier", value: normalized });
      index = cursor + 1;
      continue;
    }

    if (isIdentifierStart(char)) {
      let cursor = index + 1;
      while (cursor < sql.length && isIdentifierPart(sql[cursor] ?? "")) {
        cursor += 1;
      }
      const value = sql.slice(index, cursor);
      const upper = value.toUpperCase();
      if (PARSER_KEYWORDS.has(upper)) {
        tokens.push({ kind: "keyword", value: upper });
      } else {
        tokens.push({ kind: "identifier", value: normalizeIdentifier(value) });
      }
      index = cursor;
      continue;
    }

    if (char === "." || char === "(" || char === ")" || char === "," || char === ";") {
      tokens.push({ kind: "symbol", value: char });
      index += 1;
      continue;
    }

    index += 1;
    continue;
  }

  return { tokens, malformed: false };
}

function validateBalancedParentheses(tokens: SqlToken[]): boolean {
  let depth = 0;
  for (const token of tokens) {
    if (token.kind !== "symbol") {
      continue;
    }
    if (token.value === "(") {
      depth += 1;
    } else if (token.value === ")") {
      depth -= 1;
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

function parseLeadingWithClause(tokens: SqlToken[]): { ok: boolean; cteNames: Set<string> } {
  const cteNames = new Set<string>();
  if (tokens.length === 0 || tokens[0]?.value !== "WITH") {
    return { ok: true, cteNames };
  }

  let cursor = 1;
  while (cursor < tokens.length) {
    const cteName = tokens[cursor];
    if (!cteName || cteName.kind !== "identifier") {
      return { ok: false, cteNames: new Set() };
    }
    cteNames.add(cteName.value);
    cursor += 1;

    if (tokens[cursor]?.value === "(") {
      let depth = 1;
      cursor += 1;
      while (cursor < tokens.length && depth > 0) {
        const token = tokens[cursor];
        if (token?.value === "(") {
          depth += 1;
        } else if (token?.value === ")") {
          depth -= 1;
        }
        cursor += 1;
      }
      if (depth !== 0) {
        return { ok: false, cteNames: new Set() };
      }
    }

    if (tokens[cursor]?.value !== "AS") {
      return { ok: false, cteNames: new Set() };
    }
    cursor += 1;

    if (tokens[cursor]?.value !== "(") {
      return { ok: false, cteNames: new Set() };
    }
    let subqueryDepth = 1;
    cursor += 1;
    while (cursor < tokens.length && subqueryDepth > 0) {
      const token = tokens[cursor];
      if (token?.value === "(") {
        subqueryDepth += 1;
      } else if (token?.value === ")") {
        subqueryDepth -= 1;
      }
      cursor += 1;
    }
    if (subqueryDepth !== 0) {
      return { ok: false, cteNames: new Set() };
    }

    if (tokens[cursor]?.value === ",") {
      cursor += 1;
      continue;
    }
    break;
  }

  return { ok: true, cteNames };
}

function parseQualifiedReference(
  tokens: SqlToken[],
  startIndex: number,
  cteNames: ReadonlySet<string>,
): ParseQualifiedResult {
  const first = tokens[startIndex];
  if (!first || first.kind !== "identifier") {
    return { kind: "malformed", nextIndex: startIndex };
  }

  const parts = [first.value];
  let cursor = startIndex + 1;

  while (tokens[cursor]?.value === ".") {
    const next = tokens[cursor + 1];
    if (!next || next.kind !== "identifier") {
      return { kind: "malformed", nextIndex: cursor + 1 };
    }
    parts.push(next.value);
    cursor += 2;
    if (parts.length > 3) {
      return { kind: "malformed", nextIndex: cursor };
    }
  }

  if (parts.length === 1) {
    if (cteNames.has(parts[0])) {
      return { kind: "cte", nextIndex: cursor };
    }
    return { kind: "ambiguous", nextIndex: cursor };
  }

  const target = buildResolvedTarget(parts);
  if (!target) {
    return { kind: "malformed", nextIndex: cursor };
  }
  return { kind: "target", target, nextIndex: cursor };
}

function isKeyword(token: SqlToken | undefined, keyword: string): boolean {
  return Boolean(token && token.kind === "keyword" && token.value === keyword);
}

function skipAlias(tokens: SqlToken[], index: number): number {
  let cursor = index;
  if (isKeyword(tokens[cursor], "AS")) {
    cursor += 1;
  }
  if (tokens[cursor]?.kind === "identifier") {
    cursor += 1;
  }
  return cursor;
}

function addTarget(
  targets: ResolvedSqlTarget[],
  seen: Set<string>,
  target: ResolvedSqlTarget,
): void {
  const key = `${target.catalog ?? ""}|${target.schema ?? ""}|${target.table}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  targets.push(target);
}

function skipParenthesized(tokens: SqlToken[], index: number): number | null {
  if (tokens[index]?.value !== "(") {
    return null;
  }
  let depth = 1;
  let cursor = index + 1;
  while (cursor < tokens.length && depth > 0) {
    const token = tokens[cursor];
    if (token?.value === "(") {
      depth += 1;
    } else if (token?.value === ")") {
      depth -= 1;
    }
    cursor += 1;
  }
  if (depth !== 0) {
    return null;
  }
  return cursor;
}

function parseSourceList(
  tokens: SqlToken[],
  startIndex: number,
  cteNames: ReadonlySet<string>,
  targets: ResolvedSqlTarget[],
  seen: Set<string>,
): { nextIndex: number; ambiguous: boolean } {
  let cursor = startIndex;
  while (cursor < tokens.length) {
    const token = tokens[cursor];
    if (!token) {
      return { nextIndex: cursor, ambiguous: true };
    }

    if (token.value === "(") {
      const end = skipParenthesized(tokens, cursor);
      if (end === null) {
        return { nextIndex: cursor, ambiguous: true };
      }
      cursor = skipAlias(tokens, end);
    } else if (token.kind === "identifier") {
      const parsed = parseQualifiedReference(tokens, cursor, cteNames);
      if (parsed.kind === "malformed" || parsed.kind === "ambiguous") {
        return { nextIndex: parsed.nextIndex, ambiguous: true };
      }
      if (parsed.kind === "target") {
        addTarget(targets, seen, parsed.target);
      }
      cursor = skipAlias(tokens, parsed.nextIndex);
    } else {
      return { nextIndex: cursor, ambiguous: true };
    }

    const next = tokens[cursor];
    if (!next) {
      return { nextIndex: cursor, ambiguous: false };
    }
    if (next.value === ",") {
      cursor += 1;
      continue;
    }
    if (isKeyword(next, "JOIN")) {
      cursor += 1;
      continue;
    }
    if (
      isKeyword(next, "LEFT") ||
      isKeyword(next, "RIGHT") ||
      isKeyword(next, "FULL") ||
      isKeyword(next, "INNER") ||
      isKeyword(next, "CROSS")
    ) {
      cursor += 1;
      if (!isKeyword(tokens[cursor], "JOIN")) {
        return { nextIndex: cursor, ambiguous: true };
      }
      cursor += 1;
      continue;
    }
    if (next.kind === "keyword" && CLAUSE_BOUNDARY_KEYWORDS.has(next.value)) {
      return { nextIndex: cursor, ambiguous: false };
    }
    if (next.value === ")") {
      return { nextIndex: cursor, ambiguous: false };
    }
    return { nextIndex: cursor, ambiguous: true };
  }

  return { nextIndex: cursor, ambiguous: false };
}

export function resolveSqlTargets(rawSql: string): SqlTargetResolution {
  const sanitized = stripSqlCommentsAndStringLiterals(rawSql);
  const { tokens, malformed } = tokenizeSql(sanitized);
  if (malformed) {
    return { targets: [], ambiguous: true };
  }
  if (!validateBalancedParentheses(tokens)) {
    return { targets: [], ambiguous: true };
  }
  if (tokens.some((token) => token.kind === "symbol" && token.value === ";")) {
    return { targets: [], ambiguous: true };
  }

  const withParsed = parseLeadingWithClause(tokens);
  if (!withParsed.ok) {
    return { targets: [], ambiguous: true };
  }

  const seen = new Set<string>();
  const targets: ResolvedSqlTarget[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (!isKeyword(tokens[index], "FROM")) {
      continue;
    }
    const parsed = parseSourceList(tokens, index + 1, withParsed.cteNames, targets, seen);
    if (parsed.ambiguous) {
      return { targets: [], ambiguous: true };
    }
    index = Math.max(index, parsed.nextIndex - 1);
  }

  return { targets, ambiguous: false };
}
