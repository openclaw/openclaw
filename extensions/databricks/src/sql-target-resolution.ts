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

type ParseQualifiedResult = {
  nextIndex: number;
  malformed: boolean;
  target?: ResolvedSqlTarget;
};

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
      if (upper === "FROM" || upper === "JOIN" || upper === "WITH" || upper === "AS") {
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

function parseQualifiedReference(tokens: SqlToken[], startIndex: number): ParseQualifiedResult {
  const first = tokens[startIndex];
  if (!first || first.kind !== "identifier") {
    return { nextIndex: startIndex, malformed: false };
  }

  const parts = [first.value];
  let cursor = startIndex + 1;

  while (true) {
    const dot = tokens[cursor];
    if (!dot || dot.kind !== "symbol" || dot.value !== ".") {
      break;
    }
    const next = tokens[cursor + 1];
    if (!next || next.kind !== "identifier") {
      return { nextIndex: cursor + 1, malformed: true };
    }
    parts.push(next.value);
    cursor += 2;
    if (parts.length > 3) {
      return { nextIndex: cursor, malformed: true };
    }
  }

  const target = buildResolvedTarget(parts);
  if (!target && parts.length >= 2) {
    return { nextIndex: cursor, malformed: true };
  }
  return {
    nextIndex: cursor,
    malformed: false,
    ...(target ? { target } : {}),
  };
}

function parseLeadingWithClause(tokens: SqlToken[]): boolean {
  if (tokens.length === 0) {
    return true;
  }
  if (tokens[0]?.kind !== "keyword" || tokens[0].value !== "WITH") {
    return true;
  }

  let cursor = 1;
  while (cursor < tokens.length) {
    const cteName = tokens[cursor];
    if (!cteName || cteName.kind !== "identifier") {
      return false;
    }
    cursor += 1;

    if (tokens[cursor]?.kind === "symbol" && tokens[cursor]?.value === "(") {
      let depth = 1;
      cursor += 1;
      while (cursor < tokens.length && depth > 0) {
        const token = tokens[cursor];
        if (token?.kind === "symbol" && token.value === "(") {
          depth += 1;
        } else if (token?.kind === "symbol" && token.value === ")") {
          depth -= 1;
        }
        cursor += 1;
      }
      if (depth !== 0) {
        return false;
      }
    }

    const asToken = tokens[cursor];
    if (!asToken || asToken.kind !== "keyword" || asToken.value !== "AS") {
      return false;
    }
    cursor += 1;

    if (tokens[cursor]?.kind !== "symbol" || tokens[cursor]?.value !== "(") {
      return false;
    }
    let subqueryDepth = 1;
    cursor += 1;
    while (cursor < tokens.length && subqueryDepth > 0) {
      const token = tokens[cursor];
      if (token?.kind === "symbol" && token.value === "(") {
        subqueryDepth += 1;
      } else if (token?.kind === "symbol" && token.value === ")") {
        subqueryDepth -= 1;
      }
      cursor += 1;
    }
    if (subqueryDepth !== 0) {
      return false;
    }

    if (tokens[cursor]?.kind === "symbol" && tokens[cursor].value === ",") {
      cursor += 1;
      continue;
    }
    break;
  }

  return true;
}

export function resolveSqlTargets(rawSql: string): ResolvedSqlTarget[] {
  const sanitized = stripSqlCommentsAndStringLiterals(rawSql);
  const { tokens, malformed } = tokenizeSql(sanitized);
  if (malformed) {
    return [];
  }
  if (!validateBalancedParentheses(tokens)) {
    return [];
  }
  if (!parseLeadingWithClause(tokens)) {
    return [];
  }
  if (tokens.some((token) => token.kind === "symbol" && token.value === ";")) {
    return [];
  }

  const references = new Set<string>();
  const targets: ResolvedSqlTarget[] = [];

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token || token.kind !== "keyword") {
      continue;
    }
    if (token.value !== "FROM" && token.value !== "JOIN") {
      continue;
    }

    const next = tokens[index + 1];
    if (!next) {
      continue;
    }
    if (next.kind === "symbol" && next.value === "(") {
      continue;
    }
    if (next.kind !== "identifier") {
      continue;
    }

    const parsed = parseQualifiedReference(tokens, index + 1);
    if (parsed.malformed) {
      return [];
    }
    if (!parsed.target) {
      continue;
    }
    index = parsed.nextIndex - 1;

    const key = `${parsed.target.catalog ?? ""}|${parsed.target.schema ?? ""}|${parsed.target.table}`;
    if (references.has(key)) {
      continue;
    }
    references.add(key);
    targets.push(parsed.target);
  }

  return targets;
}
