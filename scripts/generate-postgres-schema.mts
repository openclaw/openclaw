#!/usr/bin/env node

import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;
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
type Catalog = { schema: string; tables: Table[]; objects: Item[]; notes: string[] };

function checkExpressions(input: string[]): string[][] {
  const checks: string[][] = [];
  for (let i = 0; i < input.length; i++) {
    if (keyword(input[i], "CHECK") && input[i + 1] === "(") {
      const check = group(input, i + 1);
      checks.push(check.body);
      i = check.end;
    }
  }
  return checks;
}

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

function catalog(db: DatabaseSync, schema: string): Catalog {
  const objects: Item[] = [];
  const tables: Table[] = [];
  const notes: string[] = [];
  const referenceKeys = new Map<string, string[][]>();
  const pendingForeignKeys: { item: Item; table: Table; fk: ForeignKey }[] = [];
  const rows = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
    .all();
  const tableKinds = new Map(
    db
      .prepare("PRAGMA table_list")
      .all()
      .map((row) => [String(row.name), String(row.type)]),
  );
  const qualified = (name: string) => `${quote(schema)}.${quote(name)}`;
  const add = (
    kind: string,
    table: string,
    name: string,
    source: string,
    sql: string | null,
    reason?: string,
  ): Item => {
    const item = { kind, table, name, source, sql, ...(reason ? { reason } : {}) };
    objects.push(item);
    return item;
  };
  const translate = (
    kind: string,
    table: string,
    name: string,
    source: string,
    cols: Map<string, string>,
    expectedType?: string,
  ) => {
    try {
      const value = expression(source, cols);
      if (
        expectedType &&
        value.type !== expectedType &&
        !(expectedType !== "boolean" && value.type === "null") &&
        !(expectedType === "double precision" && value.type === "bigint")
      ) {
        throw new Error(`Expression type ${value.type} cannot be used as ${expectedType}`);
      }
      return add(kind, table, name, source, value.sql);
    } catch (error) {
      return add(
        kind,
        table,
        name,
        source,
        null,
        `Dropped ${kind}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  for (const tableRow of rows.filter((row) => row.type === "table")) {
    const name = String(tableRow.name);
    const source = String(tableRow.sql);
    const kind = tableKinds.get(name);
    const excluded = kind === "virtual" || kind === "shadow" || name.startsWith("sqlite_");
    if (excluded) {
      const item = add(
        kind === "virtual" ? "virtualTable" : "internalTable",
        name,
        name,
        source,
        null,
        kind === "virtual" ? "FTS5 is not translated" : "SQLite-owned storage is not translated",
      );
      if (kind === "virtual") {
        Object.assign(item, {
          category: "FTS sync",
          design: "tsvector + GIN; preserve tokenizer/ranking semantics separately",
        });
      }
    }
    const columnRows = db.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid").all(name);
    const indexRows = db.prepare("SELECT * FROM pragma_index_list(?) ORDER BY name").all(name);
    const pkRows = columnRows
      .filter((col) => Number(col.pk) > 0)
      .toSorted((a, b) => Number(a.pk) - Number(b.pk));
    const sqlTokens = tokens(source);
    const definitions = excluded ? [] : parts(group(sqlTokens, sqlTokens.indexOf("(")).body);
    const identityName =
      pkRows.length === 1 &&
      pkRows[0]!.type === "INTEGER" &&
      !indexRows.some((index) => index.origin === "pk")
        ? String(pkRows[0]!.name)
        : undefined;
    const nullablePrimaryKey = pkRows.some(
      (col) => Number(col.notnull) === 0 && col.name !== identityName,
    );
    const hasUnsupportedColumn = columnRows.some(
      (col) =>
        !mappedTypes[String(col.type).toUpperCase()] ||
        Number(col.hidden) !== 0 ||
        Buffer.byteLength(String(col.name)) > 63,
    );
    const omitted =
      excluded || hasUnsupportedColumn || nullablePrimaryKey || Buffer.byteLength(name) > 63;
    const tableReason = nullablePrimaryKey
      ? "Table omitted: nullable SQLite primary key is not representable"
      : omitted
        ? "Table omitted: unsupported type (including ANY), generated column, or overlong identifier"
        : undefined;
    const tableItem = excluded ? undefined : add("table", name, name, source, null, tableReason);
    for (const definition of definitions) {
      for (let i = 0; i < definition.length - 2; i++) {
        if (keyword(definition[i], "ON") && keyword(definition[i + 1], "CONFLICT")) {
          add(
            "conflictPolicy",
            name,
            `${definitions.indexOf(definition)}:${i}`,
            definition.join(" "),
            null,
            `Dropped ON CONFLICT ${definition[i + 2]}; PostgreSQL constraint violations raise errors`,
          );
        }
      }
    }
    const cols = new Map(
      columnRows.map((col) => [
        String(col.name),
        mappedTypes[String(col.type).toUpperCase()] ?? "unsupported",
      ]),
    );
    const table: Table = {
      name,
      columns: [],
      pk: pkRows.map((col) => String(col.name)),
      unique: [],
      foreignKeys: [],
      indexes: 0,
    };
    referenceKeys.set(name, table.pk.length ? [table.pk] : []);
    const fields: string[] = [];
    for (const col of columnRows) {
      const colName = String(col.name);
      const type = cols.get(colName)!;
      const identity = colName === identityName;
      const nullable = Number(col.notnull) === 0 && !identity;
      let definition = `${quote(colName)} ${type}${type === "text" ? ' COLLATE "C"' : ""}${identity ? " GENERATED BY DEFAULT AS IDENTITY" : ""}${!nullable ? " NOT NULL" : ""}`;
      if (col.dflt_value !== null) {
        const value = translate("default", name, colName, String(col.dflt_value), new Map(), type);
        if (omitted) {
          value.sql = null;
          value.reason = "Dropped default: parent table omitted";
        }
        if (value.sql && !identity) {
          definition += ` DEFAULT ${value.sql}`;
        }
        if (identity && value.sql) {
          value.sql = null;
          value.reason = "Dropped default: identity owns allocation";
        }
      }
      add(
        "column",
        name,
        colName,
        String(col.type),
        omitted ? null : definition,
        omitted ? "Parent table omitted" : undefined,
      );
      if (!omitted) {
        fields.push(definition);
        table.columns.push({ name: colName, type, nullable, identity });
      }
      if (identity && !omitted) {
        notes.push(
          `${name}.${colName}: rowid alias becomes identity; ${/AUTOINCREMENT/i.test(source) ? "AUTOINCREMENT/sqlite_sequence never-reuse" : "rowid reuse"} semantics differ: PostgreSQL sequences are nontransactional and explicit values do not advance them.`,
        );
      }
      const definitionTokens = definitions.find((entry) => identifier(entry[0]!) === colName);
      if (definitionTokens?.some((token) => keyword(token, "COLLATE"))) {
        add(
          "collation",
          name,
          colName,
          definitionTokens.join(" "),
          null,
          "Dropped SQLite collation; text uses PostgreSQL C collation",
        );
      }
    }
    if (table.pk.length) {
      const pk = `PRIMARY KEY (${table.pk.map(quote).join(", ")})`;
      add(
        "primaryKey",
        name,
        "pk",
        table.pk.join(", "),
        omitted ? null : pk,
        omitted ? "Parent table omitted" : undefined,
      );
      if (!omitted) {
        fields.push(pk);
        table.indexes++;
      }
    }
    let checkId = 0;
    for (const check of checkExpressions(excluded ? [] : sqlTokens)) {
      const item = translate("check", name, String(checkId++), check.join(" "), cols, "boolean");
      if (omitted) {
        item.sql = null;
        item.reason = "Dropped check: parent table omitted";
      }
      if (item.sql) {
        fields.push(`CHECK (${item.sql})`);
      }
      if (
        check.length === 7 &&
        keyword(check[1], "IN") &&
        check.slice(2).join(" ") === "( 0 , 1 )" &&
        cols.get(identifier(check[0]!)) === "bigint"
      ) {
        notes.push(`${name}.${identifier(check[0]!)}: 0/1 boolean candidate retained as bigint.`);
      }
    }
    for (const index of indexRows) {
      const indexName = String(index.name);
      const info = db
        .prepare("SELECT * FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno")
        .all(indexName);
      const original = rows.find((entry) => entry.name === indexName)?.sql;
      const indexSource =
        original == null ? info.map((entry) => String(entry.name)).join(", ") : String(original);
      let sql: string | null = null;
      let reason: string | undefined;
      if (omitted) {
        reason = "Parent table omitted";
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
          sql = `CREATE ${Number(index.unique) ? "UNIQUE " : ""}INDEX ${quote(indexName)} ON ${qualified(name)} ${indexExpressions(indexSource, cols)};`;
          table.indexes++;
        } catch (error) {
          reason = `Index omitted: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      add("index", name, indexName, indexSource, sql, reason);
      if (
        sql &&
        Number(index.unique) &&
        !Number(index.partial) &&
        info.every((entry) => Number(entry.cid) >= 0)
      ) {
        referenceKeys.get(name)!.push(info.map((entry) => String(entry.name)));
      }
    }
    const foreignRows = db
      .prepare("SELECT * FROM pragma_foreign_key_list(?) ORDER BY id, seq")
      .all(name);
    for (const id of new Set(foreignRows.map((row) => Number(row.id)))) {
      const keys = foreignRows.filter((row) => Number(row.id) === id);
      const first = keys[0]!;
      const from = keys.map((key) => String(key.from));
      const target = String(first.table);
      const targetColumns = keys.map((key) => (key.to == null ? "" : String(key.to)));
      if (targetColumns.some((column) => !column)) {
        targetColumns.splice(
          0,
          targetColumns.length,
          ...db
            .prepare("SELECT name FROM pragma_table_xinfo(?) WHERE pk > 0 ORDER BY pk")
            .all(target)
            .map((row) => String(row.name)),
        );
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
        return JSON.stringify(names) === JSON.stringify(from);
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
      const sql = `ALTER TABLE ${qualified(name)} ADD FOREIGN KEY (${from.map(quote).join(", ")}) REFERENCES ${qualified(target)} (${targetColumns.map(quote).join(", ")}) ON UPDATE ${fk.onUpdate} ON DELETE ${fk.onDelete}${deferrable ? ` DEFERRABLE INITIALLY ${deferred ? "DEFERRED" : "IMMEDIATE"}` : " NOT DEFERRABLE"};`;
      const reason = omitted
        ? "Parent table omitted"
        : clauses.length !== 1
          ? "Ambiguous foreign key deferrability"
          : undefined;
      const item = add(
        "foreignKey",
        name,
        String(id),
        clause || JSON.stringify(keys),
        reason ? null : sql,
        reason,
      );
      if (!reason) {
        pendingForeignKeys.push({ item, table, fk });
      }
    }
    if (tableItem && !omitted) {
      tableItem.sql = `CREATE TABLE ${qualified(name)} (\n  ${fields.join(",\n  ")}\n);`;
      tables.push(table);
    }
  }
  for (const other of rows.filter((row) => !["table", "index"].includes(String(row.type)))) {
    const source = String(other.sql);
    const name = String(other.name);
    const table = String(other.tbl_name);
    const item = add(
      String(other.type),
      table,
      name,
      source,
      null,
      `${String(other.type)} is not translated`,
    );
    if (other.type === "trigger") {
      Object.assign(item, {
        category: /\bfts\b|_fts/i.test(source)
          ? "FTS sync"
          : /RAISE\s*\(/i.test(source)
            ? "guard"
            : /revision|content_version/i.test(source)
              ? "revision counter"
              : "other",
        design: "plpgsql trigger; preserve atomicity and write authority",
      });
    }
  }
  for (const { item, table, fk } of pendingForeignKeys) {
    const target = tables.find((entry) => entry.name === fk.target);
    const key = referenceKeys
      .get(fk.target)
      ?.some(
        (columns) =>
          JSON.stringify(columns.toSorted()) === JSON.stringify(fk.targetColumns.toSorted()),
      );
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
  return { schema, tables, objects, notes };
}

export async function generatePostgresSchemas(root = ROOT, prefix = "openclaw") {
  if (!prefix || Buffer.byteLength(`${prefix}_state`) > 63 || prefix.includes("\0")) {
    throw new Error("Schema prefix must fit PostgreSQL's 63-byte identifier limit");
  }
  const { DatabaseSync } = await import("node:sqlite");
  const catalogs: Record<string, Catalog> = {};
  const files: Record<string, string> = {};
  for (const name of ["state", "agent"]) {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(fs.readFileSync(path.join(root, `src/state/openclaw-${name}-schema.sql`), "utf8"));
      catalogs[name] = catalog(db, `${prefix}_${name}`);
    } finally {
      db.close();
    }
    const data = catalogs[name]!;
    const statements = [
      "-- Generated from canonical SQLite; consult portability-report.json before use.",
      "BEGIN;",
      "SET LOCAL standard_conforming_strings = on;",
      `CREATE SCHEMA ${quote(data.schema)};`,
    ];
    for (const kind of ["table", "index", "foreignKey"]) {
      statements.push(
        ...data.objects
          .filter(
            (item) =>
              item.kind === kind && item.sql && (kind !== "index" || item.sql.startsWith("CREATE")),
          )
          .map((item) => item.sql!),
      );
    }
    files[`${name}.postgres.sql`] = `${statements.join("\n\n")}\n\nCOMMIT;\n`;
  }
  const summary: Record<
    string,
    Record<string, { total: number; translated: number; reported: number }>
  > = {};
  const kinds = [
    "table",
    "column",
    "index",
    "foreignKey",
    "check",
    "trigger",
    "virtualTable",
    "internalTable",
  ];
  for (const [name, data] of Object.entries(catalogs)) {
    const counts: (typeof summary)[string] = {};
    for (const kind of kinds) {
      const items = data.objects.filter((item) => item.kind === kind);
      const translated = items.filter((item) => item.sql !== null).length;
      counts[kind] = { total: items.length, translated, reported: items.length - translated };
    }
    summary[name] = counts;
  }
  const limitations = [
    "Readiness tooling only: SQLite remains the runtime store and canonical .sql files remain authoritative. No data migration or runtime SQL/concurrency conformance is proved.",
    "Agent topology remains undecided: schema per agent versus shared tables. The agent output represents one canonical database only.",
    "Text uses C collation. PostgreSQL text rejects NUL; SQLite length(text) stops at NUL. Data validation and numeric/JSON representation differences need a separate migration contract.",
    "STRICT and WITHOUT ROWID options are removed. Identity sequences do not reproduce SQLite rowid/AUTOINCREMENT/sqlite_sequence allocation or rollback semantics; each rowid alias adds a PostgreSQL PK index absent from SQLite's index_list.",
    "Not covered: runtime-created memory FTS5 in packages/memory-host-sdk/src/host/memory-schema-fts.ts; vec0 in extensions/memory-core/src/memory/manager-sync-base.ts and src/migration/doctor-memory-sidecar-import.ts.",
    "Not covered: plugin-owned databases, including extensions/workboard/src/sqlite-store-schema.ts, extensions/logbook/src/store-schema.ts and extensions/team-reports/src/store-schema.ts.",
    "Not covered: additive/startup repair DDL in src/state/*-schema.ts and *migration*.ts, including openclaw-agent-transcript-fts-schema.ts, openclaw-agent-board-schema.ts and openclaw-agent-canonical-validation-migration.ts.",
  ];
  const report = { summary, limitations, catalogs };
  files["portability-report.json"] = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = [
    "# PostgreSQL portability report",
    "",
    ...limitations.map((line) => `- ${line}`),
    "",
    "## Counts",
    "",
    "Database | Object | Total | Translated | Reported",
    "--- | --- | ---: | ---: | ---:",
  ];
  for (const [name, counts] of Object.entries(summary)) {
    for (const [kind, count] of Object.entries(counts)) {
      markdown.push(`${name} | ${kind} | ${count.total} | ${count.translated} | ${count.reported}`);
    }
  }
  for (const [name, data] of Object.entries(catalogs)) {
    markdown.push(
      "",
      `## ${name}: omissions and semantic notes`,
      "",
      ...data.notes.map((note) => `- ${note}`),
    );
    for (const item of data.objects.filter((entry) => entry.sql === null)) {
      markdown.push(
        `- ${item.kind} \`${item.table}.${item.name}\`: ${item.reason}${item.category ? `; ${item.category}; ${item.design}` : ""}. Source: \`${item.source.replaceAll("`", "\\`").replaceAll("\n", " ")}\``,
      );
    }
  }
  files["portability-report.md"] = `${markdown.join("\n")}\n`;
  return { files, report };
}

function verifyPostgres(catalogs: Record<string, Catalog>, command: string): void {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, item: unknown) => {
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        return Object.fromEntries(
          Object.entries(item).toSorted(([a], [b]) => a.localeCompare(b, "en")),
        );
      }
      return item;
    });
  for (const data of Object.values(catalogs)) {
    const expected: unknown[] = [];
    const add = (table: string, kind: string, value: unknown) =>
      expected.push({ table, kind, value });
    for (const table of data.tables) {
      add(table.name, "table", null);
      for (const [position, column] of table.columns.entries()) {
        add(table.name, "column", { ...column, position: position + 1 });
      }
      if (table.pk.length) {
        add(table.name, "primaryKey", table.pk);
      }
      for (const unique of table.unique) {
        add(table.name, "unique", unique);
      }
      for (const fk of table.foreignKeys) {
        add(table.name, "foreignKey", fk);
      }
      add(table.name, "indexes", table.indexes);
      add(
        table.name,
        "checks",
        data.objects.filter(
          (item) => item.table === table.name && item.kind === "check" && item.sql,
        ).length,
      );
    }
    const columns = (relation: string, keys: string) =>
      `(SELECT jsonb_agg(a.attname ORDER BY k.ordinality) FROM unnest(${keys}) WITH ORDINALITY k(num, ordinality) JOIN pg_attribute a ON a.attrelid = ${relation} AND a.attnum = k.num)`;
    const action = (field: string) =>
      `CASE ${field} WHEN 'a' THEN 'NO ACTION' WHEN 'r' THEN 'RESTRICT' WHEN 'c' THEN 'CASCADE' WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' END`;
    const query = `WITH relations AS (
      SELECT c.oid, c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${literal(data.schema)} AND c.relkind IN ('r', 'p')
    ), facts AS (
      SELECT r.relname AS "table", 'table' AS kind, 'null'::jsonb AS value FROM relations r
      UNION ALL SELECT r.relname, 'column', jsonb_build_object(
        'name', a.attname, 'type', format_type(a.atttypid, a.atttypmod),
        'nullable', NOT a.attnotnull, 'identity', a.attidentity = 'd', 'position', a.attnum)
        FROM relations r JOIN pg_attribute a ON a.attrelid = r.oid WHERE a.attnum > 0 AND NOT a.attisdropped
      UNION ALL SELECT r.relname, CASE c.contype WHEN 'p' THEN 'primaryKey' ELSE 'unique' END,
        ${columns("r.oid", "c.conkey")} FROM relations r JOIN pg_constraint c ON c.conrelid = r.oid WHERE c.contype IN ('p', 'u')
      UNION ALL SELECT r.relname, 'foreignKey', jsonb_build_object(
        'columns', ${columns("r.oid", "c.conkey")}, 'target', target.relname,
        'targetColumns', ${columns("c.confrelid", "c.confkey")},
        'onUpdate', ${action("c.confupdtype")}, 'onDelete', ${action("c.confdeltype")},
        'deferrable', c.condeferrable, 'deferred', c.condeferred)
        FROM relations r JOIN pg_constraint c ON c.conrelid = r.oid
        JOIN pg_class target ON target.oid = c.confrelid WHERE c.contype = 'f'
      UNION ALL SELECT r.relname, 'indexes', to_jsonb((SELECT count(*) FROM pg_index i WHERE i.indrelid = r.oid)) FROM relations r
      UNION ALL SELECT r.relname, 'checks', to_jsonb((SELECT count(*) FROM pg_constraint c WHERE c.conrelid = r.oid AND c.contype = 'c')) FROM relations r
    ) SELECT coalesce(jsonb_agg(facts), '[]'::jsonb) FROM facts;`;
    // The operator supplies the trusted psql shell command; SQL is sent on stdin.
    const actual: unknown = JSON.parse(
      execSync(`${command} -X -qAt -v ON_ERROR_STOP=1`, {
        input: query,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      }),
    );
    assert.ok(Array.isArray(actual), "psql must return a JSON catalog array");
    assert.deepStrictEqual(
      actual.map(canonical).toSorted(),
      expected.map(canonical).toSorted(),
      `${data.schema}: unexplained PostgreSQL catalog differences`,
    );
    console.log(
      `${data.schema}: verified ${data.tables.length} tables; zero unexplained differences (columns/types/nullability/identity, PK, UNIQUE, FKs/actions/deferrability, index and CHECK counts)`,
    );
  }
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      "schema-prefix": { type: "string", default: "openclaw" },
      "verify-psql": { type: "string" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      'Usage: node scripts/generate-postgres-schema.mts --out <dir> [--schema-prefix openclaw] [--verify-psql "psql -U postgres"]\nApply both generated SQL files before verification. The psql command is trusted shell input.',
    );
  } else {
    if (!values.out) {
      throw new Error("--out <dir> is required; no files are written by default");
    }
    const result = await generatePostgresSchemas(ROOT, values["schema-prefix"]);
    fs.mkdirSync(values.out, { recursive: true });
    for (const [name, content] of Object.entries(result.files)) {
      fs.writeFileSync(path.join(values.out, name), content);
    }
    console.log(JSON.stringify(result.report.summary, null, 2));
    if (values["verify-psql"]) {
      verifyPostgres(result.report.catalogs, values["verify-psql"]);
    }
  }
}
