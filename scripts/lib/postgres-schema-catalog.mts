import type { DatabaseSync, SQLOutputValue } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";

export const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
export const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
const identifier = (token: string) =>
  /^["`[]/.test(token) ? token.slice(1, -1).replaceAll(token[0]!.repeat(2), token[0]!) : token;
const keyword = (token: string | undefined, word: string) => token?.toUpperCase() === word;
const mappedTypes: Record<string, string> = {
  INTEGER: "bigint",
  INT: "bigint",
  REAL: "double precision",
  TEXT: "text",
  BLOB: "bytea",
};

function tokens(sql: string): string[] {
  const result: string[] = [];
  const pattern =
    /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[a-zA-Z_][a-zA-Z_0-9]*|<=|>=|<>|!=|==|[^\s]/gy;
  for (const match of sql.matchAll(pattern)) {
    if (!/^\s|^--|^\/\*/.test(match[0])) {
      result.push(match[0]);
    }
  }
  return result;
}

function group(input: string[], start: number): { body: string[]; end: number } {
  if (input[start] !== "(") {
    throw new Error("Expected parenthesized SQL");
  }
  let depth = 1;
  for (let end = start + 1; end < input.length; end++) {
    if (input[end] === "(") {
      depth++;
    }
    if (input[end] === ")" && --depth === 0) {
      return { body: input.slice(start + 1, end), end };
    }
  }
  throw new Error("Unbalanced SQL");
}

function parts(input: string[]): string[][] {
  const result: string[][] = [[]];
  let depth = 0;
  for (const token of input) {
    if (token === "(") {
      depth++;
    }
    if (token === ")") {
      depth--;
    }
    if (token === "," && depth === 0) {
      result.push([]);
    } else {
      result.at(-1)!.push(token);
    }
  }
  return result;
}

type Expression = { sql: string; type: string };
function globRegex(pattern: string): string {
  let result = "\\A";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === "*") {
      result += ".*";
    } else if (ch === "?") {
      result += ".";
    } else if (ch === "[") {
      const end = pattern.indexOf("]", i + 1);
      const body = pattern.slice(i + 1, end);
      if (
        end < 0 ||
        !["A-Za-z0-9", "A-Za-z0-9_-", "A-Za-z0-9._-", "0-9a-f"].includes(body.replace(/^\^/, ""))
      ) {
        throw new Error("Unsupported GLOB class");
      }
      result += `[${body}]`;
      i = end;
    } else {
      if (ch.charCodeAt(0) > 127 || ch === "\0") {
        throw new Error("Unsupported GLOB character");
      }
      result += ch.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
    }
  }
  return `${result}\\Z`;
}

function expression(source: string, columns: Map<string, string>): Expression {
  const input = tokens(source);
  let pos = 0;
  const take = (word: string) => (keyword(input[pos], word) ? (pos++, true) : false);
  const requireToken = (word: string) => {
    if (!take(word)) {
      throw new Error(`Expected ${word}`);
    }
  };
  const compatible = (left: Expression, right: Expression) => {
    if (
      left.type !== right.type &&
      left.type !== "null" &&
      right.type !== "null" &&
      ![left.type, right.type].every((type) => ["bigint", "double precision"].includes(type))
    ) {
      throw new Error("Mixed-type comparison");
    }
  };
  const boolean = (value: Expression) => {
    if (value.type !== "boolean") {
      throw new Error("SQLite numeric truthiness is unsupported");
    }
    return value.sql;
  };
  function atom(): Expression {
    if (take("(")) {
      const value = or();
      requireToken(")");
      return { ...value, sql: `(${value.sql})` };
    }
    const token = input[pos++];
    if (!token) {
      throw new Error("Missing expression");
    }
    if (token === "-" || token === "+") {
      const value = atom();
      if (!["bigint", "double precision"].includes(value.type)) {
        throw new Error("Non-numeric unary operator");
      }
      return { ...value, sql: `${token}${/^[+-]/.test(value.sql) ? `(${value.sql})` : value.sql}` };
    }
    if (token.startsWith("'")) {
      return { sql: token, type: "text" };
    }
    if (/^\d/.test(token)) {
      return { sql: token, type: /[.eE]/.test(token) ? "double precision" : "bigint" };
    }
    if (keyword(token, "NULL")) {
      return { sql: "NULL", type: "null" };
    }
    if (take("(")) {
      if (!/^(length|json_valid)$/i.test(token)) {
        throw new Error(`Unsupported function ${token}`);
      }
      const value = or();
      requireToken(")");
      if (value.type !== "text" && !(keyword(token, "LENGTH") && value.type === "bytea")) {
        throw new Error(`${token} requires text (or bytea for length)`);
      }
      return keyword(token, "LENGTH")
        ? { sql: `length(${value.sql})`, type: "bigint" }
        : { sql: `(${value.sql} IS JSON)`, type: "boolean" };
    }
    const name = identifier(token);
    const type = columns.get(name);
    if (!type) {
      throw new Error(`Unsupported token ${token}`);
    }
    return { sql: quote(name), type };
  }
  function predicate(): Expression {
    const left = atom();
    if (take("IS")) {
      const negate = take("NOT");
      requireToken("NULL");
      return { sql: `${left.sql} IS ${negate ? "NOT " : ""}NULL`, type: "boolean" };
    }
    const negate = take("NOT");
    let sql: string;
    if (take("IN")) {
      requireToken("(");
      const values: Expression[] = [atom()];
      while (take(",")) {
        values.push(atom());
      }
      requireToken(")");
      values.forEach((value) => compatible(left, value));
      sql = `${left.sql} ${negate ? "NOT " : ""}IN (${values.map((value) => value.sql).join(", ")})`;
    } else if (take("BETWEEN")) {
      const low = atom();
      requireToken("AND");
      const high = atom();
      compatible(left, low);
      compatible(left, high);
      sql = `${left.sql} ${negate ? "NOT " : ""}BETWEEN ${low.sql} AND ${high.sql}`;
    } else if (take("GLOB")) {
      const pattern = input[pos++];
      if (left.type !== "text" || !pattern?.startsWith("'")) {
        throw new Error("GLOB requires text and a literal pattern");
      }
      sql = `${left.sql} COLLATE "C" ${negate ? "!~" : "~"} ${literal(globRegex(pattern.slice(1, -1).replaceAll("''", "'")))}`;
    } else {
      if (negate) {
        throw new Error("Unsupported NOT predicate");
      }
      const op = input[pos];
      if (!op || !["=", "==", "!=", "<>", "<", ">", "<=", ">="].includes(op)) {
        return left;
      }
      pos++;
      const right = atom();
      compatible(left, right);
      sql = `${left.sql} ${op === "==" ? "=" : op} ${right.sql}`;
    }
    return { sql: `(${sql})`, type: "boolean" };
  }
  function not(): Expression {
    if (take("NOT")) {
      return { sql: `NOT (${boolean(not())})`, type: "boolean" };
    }
    return predicate();
  }
  function and(): Expression {
    let value = not();
    while (take("AND")) {
      value = { sql: `${boolean(value)} AND ${boolean(not())}`, type: "boolean" };
    }
    return value;
  }
  function or(): Expression {
    let value = and();
    while (take("OR")) {
      value = { sql: `${boolean(value)} OR ${boolean(and())}`, type: "boolean" };
    }
    return value;
  }
  const result = or();
  if (pos !== input.length) {
    throw new Error(`Unsupported token ${input[pos]}`);
  }
  return result;
}

type Item = {
  kind: string;
  table: string;
  name: string;
  source: string;
  sql: string | null;
  reason?: string;
  category?: string;
  design?: string;
};
type Column = { name: string; type: string; nullable: boolean; identity: boolean };
type ForeignKey = {
  columns: string[];
  target: string;
  targetColumns: string[];
  onUpdate: string;
  onDelete: string;
  deferred: boolean;
  deferrable: boolean;
};
type Table = {
  name: string;
  columns: Column[];
  pk: string[];
  unique: string[][];
  foreignKeys: ForeignKey[];
  indexes: number;
};
export type Catalog = { schema: string; tables: Table[]; objects: Item[]; notes: string[] };

function indexExpressions(indexSource: string, cols: Map<string, string>): string {
  const ts = tokens(indexSource);
  const on = ts.findIndex((token) => keyword(token, "ON"));
  const keys = group(ts, ts.indexOf("(", on));
  const terms = parts(keys.body).map((term) => {
    const order = /^(ASC|DESC)$/i.test(term.at(-1)!) ? term.pop()!.toUpperCase() : "ASC";
    return `(${expression(term.join(" "), cols).sql}) ${order} NULLS ${order === "DESC" ? "LAST" : "FIRST"}`;
  });
  const where = ts.slice(keys.end + 1);
  if (where.length && !keyword(where.shift(), "WHERE")) {
    throw new Error("Unsupported index suffix");
  }
  const predicate = where.length ? expression(where.join(" "), cols) : undefined;
  if (predicate && predicate.type !== "boolean") {
    throw new Error("Non-boolean index predicate");
  }
  return `(${terms.join(", ")})${predicate ? ` WHERE ${predicate.sql}` : ""}`;
}

type Row = Record<string, SQLOutputValue>;
function createContext(db: DatabaseSync, schema: string) {
  const result: Catalog = { schema, tables: [], objects: [], notes: [] };
  const pendingForeignKeys: { item: Item; table: Table; fk: ForeignKey }[] = [];
  return {
    db,
    result,
    pendingForeignKeys,
    rows: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all(),
    tableKinds: new Map(
      db
        .prepare("PRAGMA table_list")
        .all()
        .map((row) => [String(row.name), String(row.type)]),
    ),
    referenceKeys: new Map<string, string[][]>(),
    record(
      kind: string,
      table: string,
      name: string,
      source: string,
      sql: string | null,
      reason?: string,
    ): Item {
      const item = { kind, table, name, source, sql, ...(reason ? { reason } : {}) };
      this.result.objects.push(item);
      return item;
    },
  };
}
type Context = ReturnType<typeof createContext>;
const qualified = (ctx: Context, name: string) =>
  ctx.result.schema ? `${quote(ctx.result.schema)}.${quote(name)}` : quote(name);

type TableMapping = {
  name: string;
  source: string;
  definitions: string[][];
  cols: Map<string, string>;
  table: Table;
  fields: string[];
  omitted: "Parent table omitted" | undefined;
};
function translateObject(
  ctx: Context,
  mapping: TableMapping,
  kind: "default" | "check",
  name: string,
  source: string,
  expectedType: string,
): Item {
  if (mapping.omitted) {
    const reason = `Dropped ${kind}: parent table omitted`;
    return ctx.record(kind, mapping.name, name, source, null, reason);
  }
  try {
    const value = expression(source, kind === "default" ? new Map() : mapping.cols);
    if (
      value.type !== expectedType &&
      !(expectedType !== "boolean" && value.type === "null") &&
      !(expectedType === "double precision" && value.type === "bigint")
    ) {
      throw new Error(`Expression type ${value.type} cannot be used as ${expectedType}`);
    }
    return ctx.record(kind, mapping.name, name, source, value.sql);
  } catch (error) {
    const reason = `Dropped ${kind}: ${error instanceof Error ? error.message : String(error)}`;
    return ctx.record(kind, mapping.name, name, source, null, reason);
  }
}

function reportExcludedTable(ctx: Context, name: string, source: string, virtual: boolean): void {
  const objectKind = virtual ? "virtualTable" : "internalTable";
  const reason = virtual ? "FTS5 is not translated" : "SQLite-owned storage is not translated";
  const item = ctx.record(objectKind, name, name, source, null, reason);
  if (virtual) {
    item.category = "FTS sync";
    item.design = "tsvector + GIN; preserve tokenizer/ranking semantics separately";
  }
}

function reportConflictPolicies(ctx: Context, { name, definitions }: TableMapping): void {
  for (const definition of definitions) {
    for (let i = 0; i < definition.length - 2; i++) {
      if (keyword(definition[i], "ON") && keyword(definition[i + 1], "CONFLICT")) {
        const objectName = `${definitions.indexOf(definition)}:${i}`;
        const source = definition.join(" ");
        const reason = `Dropped ON CONFLICT ${definition[i + 2]}; PostgreSQL constraint violations raise errors`;
        ctx.record("conflictPolicy", name, objectName, source, null, reason);
      }
    }
  }
}

function mapColumns(ctx: Context, mapping: TableMapping, columns: Row[], rowidColumn?: Row): void {
  const { name, source, definitions, cols, table, fields, omitted } = mapping;
  for (const col of columns) {
    const colName = String(col.name);
    const type = cols.get(colName)!;
    const identity = col === rowidColumn;
    const nullable = Number(col.notnull) === 0 && !identity;
    let definition = `${quote(colName)} ${type}${type === "text" ? ' COLLATE "C"' : ""}${identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${!nullable ? " NOT NULL" : ""}`;
    if (col.dflt_value !== null) {
      const value = translateObject(ctx, mapping, "default", colName, String(col.dflt_value), type);
      if (value.sql && !identity) {
        definition += ` DEFAULT ${value.sql}`;
      }
      if (identity && value.sql) {
        value.sql = null;
        value.reason = "Dropped default: identity owns allocation";
      }
    }
    const sql = omitted ? null : definition;
    ctx.record("column", name, colName, String(col.type), sql, omitted);
    if (!omitted) {
      fields.push(definition);
      table.columns.push({ name: colName, type, nullable, identity });
    }
    if (identity && !omitted) {
      ctx.result.notes.push(
        `${name}.${colName}: rowid alias becomes identity; ${/AUTOINCREMENT/i.test(source) ? "AUTOINCREMENT/sqlite_sequence never-reuse" : "rowid reuse"} semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.`,
      );
    }
    const definitionTokens = definitions.find((entry) => identifier(entry[0]!) === colName);
    if (definitionTokens?.some((token) => keyword(token, "COLLATE"))) {
      const collation = definitionTokens.join(" ");
      const reason = "Dropped SQLite collation; text uses PostgreSQL C collation";
      ctx.record("collation", name, colName, collation, null, reason);
    }
  }
}

function mapPrimaryKey(ctx: Context, { name, table, fields, omitted }: TableMapping): void {
  if (table.pk.length) {
    const pk = `PRIMARY KEY (${table.pk.map(quote).join(", ")})`;
    const source = table.pk.join(", ");
    const sql = omitted ? null : pk;
    ctx.record("primaryKey", name, "pk", source, sql, omitted);
    if (!omitted) {
      fields.push(pk);
      table.indexes++;
    }
  }
}

function mapChecks(ctx: Context, mapping: TableMapping, sqlTokens: string[]): void {
  const { name, cols, fields } = mapping;
  let id = 0;
  for (let i = 0; i < sqlTokens.length; i++) {
    if (!keyword(sqlTokens[i], "CHECK") || sqlTokens[i + 1] !== "(") {
      continue;
    }
    const { body: check, end } = group(sqlTokens, i + 1);
    i = end;
    const item = translateObject(ctx, mapping, "check", String(id++), check.join(" "), "boolean");
    if (item.sql) {
      fields.push(`CHECK (${item.sql})`);
    }
    if (
      check.length === 7 &&
      keyword(check[1], "IN") &&
      check.slice(2).join(" ") === "( 0 , 1 )" &&
      cols.get(identifier(check[0]!)) === "bigint"
    ) {
      ctx.result.notes.push(
        `${name}.${identifier(check[0]!)}: 0/1 boolean candidate retained as bigint.`,
      );
    }
  }
}

function mapIndexes(ctx: Context, mapping: TableMapping, indexes: Row[]): void {
  const { name, cols, table, fields, omitted } = mapping;
  for (const index of indexes) {
    const indexName = String(index.name);
    const info = ctx.db
      .prepare("SELECT * FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno")
      .all(indexName);
    const original = ctx.rows.find((entry) => entry.name === indexName)?.sql;
    const source =
      original == null ? info.map((entry) => String(entry.name)).join(", ") : String(original);
    let sql: string | null = null;
    let reason: string | undefined;
    if (omitted) {
      reason = omitted;
    } else if (Buffer.byteLength(indexName) > 63) {
      reason = "Index omitted: identifier exceeds 63 bytes";
    } else if (info.some((entry) => entry.coll !== "BINARY")) {
      reason = "Index omitted: unsupported collation";
    } else if (index.origin === "pk") {
      sql = "PRIMARY KEY";
    } else if (index.origin === "u") {
      const names = info.map((entry) => String(entry.name));
      table.unique.push(names);
      sql = `UNIQUE (${names.map(quote).join(", ")})`;
      fields.push(sql);
      table.indexes++;
    } else {
      try {
        sql = `CREATE ${Number(index.unique) ? "UNIQUE " : ""}INDEX ${quote(indexName)} ON ${qualified(ctx, name)} ${indexExpressions(source, cols)};`;
        table.indexes++;
      } catch (error) {
        reason = `Index omitted: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    ctx.record("index", name, indexName, source, sql, reason);
    if (
      sql &&
      Number(index.unique) &&
      !Number(index.partial) &&
      info.every((entry) => Number(entry.cid) >= 0)
    ) {
      ctx.referenceKeys.get(name)!.push(info.map((entry) => String(entry.name)));
    }
  }
}

function collectForeignKeys(ctx: Context, mapping: TableMapping): void {
  const { name, definitions, table, omitted } = mapping;
  const rows = ctx.db
    .prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq")
    .all(name);
  for (const id of new Set(rows.map((row) => Number(row.id)))) {
    const keys = rows.filter((row) => Number(row.id) === id);
    const first = keys[0]!;
    const from = keys.map((key) => String(key.from));
    const target = String(first.table);
    let targetColumns = keys.map((key) => (key.to == null ? "" : String(key.to)));
    if (targetColumns.some((column) => !column)) {
      targetColumns = ctx.db
        .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk")
        .all(target)
        .map((row) => String(row.name));
    }
    const clauses = definitions.filter((entry) => {
      const ref = entry.findIndex((token) => keyword(token, "REFERENCES"));
      if (ref < 0 || identifier(entry[ref + 1]!) !== target) {
        return false;
      }
      const fk = entry.findIndex((token) => keyword(token, "FOREIGN"));
      const names =
        fk < 0
          ? [identifier(entry[0]!)]
          : parts(group(entry, fk + 2).body).map((part) => identifier(part[0]!));
      return isDeepStrictEqual(names, from);
    });
    const clause = clauses[0]?.join(" ") ?? "";
    const deferrable = /\bDEFERRABLE\b/i.test(clause) && !/\bNOT DEFERRABLE\b/i.test(clause);
    const deferred = deferrable && /\bINITIALLY DEFERRED\b/i.test(clause);
    const fk: ForeignKey = {
      columns: from,
      target,
      targetColumns,
      onUpdate: String(first.on_update),
      onDelete: String(first.on_delete),
      deferrable,
      deferred,
    };
    const sql = `ALTER TABLE ${qualified(ctx, name)} ADD FOREIGN KEY (${from.map(quote).join(", ")}) REFERENCES ${qualified(ctx, target)} (${targetColumns.map(quote).join(", ")}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}${deferrable ? ` DEFERRABLE INITIALLY ${deferred ? "DEFERRED" : "IMMEDIATE"}` : " NOT DEFERRABLE"};`;
    const reason =
      omitted || (clauses.length !== 1 ? "Ambiguous foreign key deferrability" : undefined);
    const source = clause || JSON.stringify(keys);
    const item = ctx.record("foreignKey", name, String(id), source, reason ? null : sql, reason);
    if (!reason) {
      ctx.pendingForeignKeys.push({ item, table, fk });
    }
  }
}

function resolveForeignKeys(ctx: Context): void {
  for (const { item, table, fk } of ctx.pendingForeignKeys) {
    const target = ctx.result.tables.find((entry) => entry.name === fk.target);
    const key = ctx.referenceKeys
      .get(fk.target)
      ?.some((columns) => isDeepStrictEqual(columns.toSorted(), fk.targetColumns.toSorted()));
    const sameTypes = fk.columns.every(
      (column, i) =>
        table.columns.find((entry) => entry.name === column)?.type ===
        target?.columns.find((entry) => entry.name === fk.targetColumns[i])?.type,
    );
    if (!target || !key || !sameTypes) {
      item.sql = null;
      item.reason = !target
        ? "Referenced table omitted"
        : !key
          ? "Referenced unique key omitted"
          : "Mapped foreign-key column types differ; SQLite affinity is not translated";
    } else {
      table.foreignKeys.push(fk);
    }
  }
}

function reportNonTableObjects(ctx: Context): void {
  for (const row of ctx.rows.filter((item) => !["table", "index"].includes(String(item.type)))) {
    const source = String(row.sql);
    const kind = String(row.type);
    const table = String(row.tbl_name);
    const name = String(row.name);
    const reason = `${kind} is not translated`;
    const item = ctx.record(kind, table, name, source, null, reason);
    if (row.type === "trigger") {
      item.category = /\bfts\b|_fts/i.test(source)
        ? "FTS sync"
        : /RAISE\s*\(/i.test(source)
          ? "guard"
          : /revision|content_version/i.test(source)
            ? "revision counter"
            : "other";
      item.design = "plpgsql trigger; preserve atomicity and write authority";
    }
  }
}

function mapTable(ctx: Context, row: Row): void {
  const name = String(row.name);
  const source = String(row.sql);
  const kind = ctx.tableKinds.get(name);
  const excluded = kind === "virtual" || kind === "shadow" || name.startsWith("sqlite_");
  if (excluded) {
    reportExcludedTable(ctx, name, source, kind === "virtual");
  }
  const columns = ctx.db.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid").all(name);
  const indexes = ctx.db.prepare("SELECT * FROM pragma_index_list(?) ORDER BY name").all(name);
  const pk = columns
    .filter((col) => Number(col.pk) > 0)
    .toSorted((a, b) => Number(a.pk) - Number(b.pk));
  const sqlTokens = tokens(source);
  const definitions = excluded ? [] : parts(group(sqlTokens, sqlTokens.indexOf("(")).body);
  const rowidColumn =
    pk.length === 1 && pk[0]!.type === "INTEGER" && !indexes.some((index) => index.origin === "pk")
      ? pk[0]
      : undefined;
  const nullablePrimaryKey = pk.some((col) => Number(col.notnull) === 0 && col !== rowidColumn);
  const hasUnsupportedColumn = columns.some(
    (col) =>
      !mappedTypes[String(col.type).toUpperCase()] ||
      Number(col.hidden) !== 0 ||
      Buffer.byteLength(String(col.name)) > 63,
  );
  const omitted =
    excluded || hasUnsupportedColumn || nullablePrimaryKey || Buffer.byteLength(name) > 63;
  const reason = nullablePrimaryKey
    ? "Table omitted: nullable SQLite primary key is not representable"
    : omitted
      ? "Table omitted: unsupported type (including ANY), generated column, or overlong identifier"
      : undefined;
  const item = excluded ? undefined : ctx.record("table", name, name, source, null, reason);
  const table: Table = {
    name,
    columns: [],
    pk: pk.map((col) => String(col.name)),
    unique: [],
    foreignKeys: [],
    indexes: 0,
  };
  const mapping: TableMapping = {
    name,
    source,
    definitions,
    cols: new Map(
      columns.map((col) => [
        String(col.name),
        mappedTypes[String(col.type).toUpperCase()] ?? "unsupported",
      ]),
    ),
    table,
    fields: [],
    omitted: omitted ? "Parent table omitted" : undefined,
  };
  reportConflictPolicies(ctx, mapping);
  ctx.referenceKeys.set(name, table.pk.length ? [table.pk] : []);
  mapColumns(ctx, mapping, columns, rowidColumn);
  mapPrimaryKey(ctx, mapping);
  mapChecks(ctx, mapping, excluded ? [] : sqlTokens);
  mapIndexes(ctx, mapping, indexes);
  collectForeignKeys(ctx, mapping);
  if (item && !omitted) {
    item.sql = `CREATE TABLE ${qualified(ctx, name)} (\n  ${mapping.fields.join(",\n  ")}\n);`;
    ctx.result.tables.push(table);
  }
}

export function catalog(db: DatabaseSync, schema: string): Catalog {
  const ctx = createContext(db, schema);
  for (const row of ctx.rows.filter((item) => item.type === "table")) {
    mapTable(ctx, row);
  }
  reportNonTableObjects(ctx);
  resolveForeignKeys(ctx);
  return ctx.result;
}
