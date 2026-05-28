#!/usr/bin/env node
/**
 * SQLite compatibility layer — tries better-sqlite3 (native), falls back to sql.js (WASM).
 * Provides a minimal subset: open, prepare().all(), prepare().run(), close().
 */

import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let betterSqlite3Cache = null;
let sqlJsCache = null;

function tryBetterSqlite3() {
  if (betterSqlite3Cache !== null) {
    return betterSqlite3Cache;
  }
  try {
    betterSqlite3Cache = require("better-sqlite3");
    return betterSqlite3Cache;
  } catch {
    betterSqlite3Cache = false;
    return false;
  }
}

async function trySqlJs() {
  if (sqlJsCache !== null) {
    return sqlJsCache;
  }
  try {
    const initSqlJs = require("sql.js");
    sqlJsCache = await initSqlJs();
    return sqlJsCache;
  } catch {
    sqlJsCache = false;
    return false;
  }
}

class SqlJsStatement {
  constructor(db, sql, wrapper) {
    this.db = db;
    this.sql = sql;
    this.wrapper = wrapper;
  }

  all(...params) {
    try {
      const stmt = this.db.prepare(this.sql);
      const flatParams = params.flat();
      if (flatParams.length > 0) {
        stmt.bind(flatParams);
      }
      const rows = [];
      while (stmt.step()) {
        const cols = stmt.getColumnNames();
        const vals = stmt.get();
        const row = {};
        for (let i = 0; i < cols.length; i += 1) {
          row[cols[i]] = vals[i];
        }
        rows.push(row);
      }
      stmt.free();
      return rows;
    } catch {
      return [];
    }
  }

  run(...params) {
    this.db.run(this.sql, params.flat());
    this.wrapper.dirty = true;
    return { changes: this.db.getRowsModified() };
  }

  get(...params) {
    const rows = this.all(...params);
    return rows[0] ?? null;
  }
}

class SqlJsWrapper {
  constructor(sqlJsDb, filePath) {
    this.db = sqlJsDb;
    this.filePath = filePath;
    this.readonly = false;
    this.dirty = false;
  }

  pragma(str) {
    try {
      this.db.run(`PRAGMA ${str}`);
    } catch {
      /* ignore */
    }
  }

  prepare(sql) {
    return new SqlJsStatement(this.db, sql, this);
  }

  close() {
    if (this.dirty && this.filePath && !this.readonly) {
      try {
        const data = this.db.export();
        fs.writeFileSync(this.filePath, Buffer.from(data));
      } catch {
        /* best-effort persist */
      }
    }
    this.db.close();
  }

  exec(sql) {
    this.db.run(sql);
    this.dirty = true;
  }
}

/**
 * Open a SQLite database with automatic backend selection.
 * @param {string} dbPath - Path to .db file
 * @param {{ readonly?: boolean, fileMustExist?: boolean }} opts
 * @returns {Promise<object>} A database handle with .prepare(), .pragma(), .close()
 */
export async function openDb(dbPath, opts = {}) {
  const { readonly = false, fileMustExist = true } = opts;

  if (fileMustExist && !fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const BetterSqlite3 = tryBetterSqlite3();
  if (BetterSqlite3) {
    try {
      return new BetterSqlite3(dbPath, { readonly, fileMustExist });
    } catch {
      betterSqlite3Cache = false;
    }
  }

  const SQL = await trySqlJs();
  if (!SQL) {
    throw new Error(
      "No SQLite backend available (better-sqlite3 native build missing, sql.js not found)",
    );
  }

  let db;
  if (fs.existsSync(dbPath)) {
    const buf = fs.readFileSync(dbPath);
    db = new SQL.Database(buf);
  } else {
    db = new SQL.Database();
  }

  const wrapper = new SqlJsWrapper(db, dbPath);
  wrapper.readonly = readonly;
  return wrapper;
}

/**
 * Open a SQLite database synchronously (blocks on sql.js init if needed).
 * Prefer openDb() when async is acceptable.
 */
export function openDbSync(dbPath, opts = {}) {
  const { readonly = false, fileMustExist = true } = opts;

  if (fileMustExist && !fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }

  const BetterSqlite3 = tryBetterSqlite3();
  if (BetterSqlite3) {
    try {
      return new BetterSqlite3(dbPath, { readonly, fileMustExist });
    } catch {
      betterSqlite3Cache = false;
    }
  }

  throw new Error("better-sqlite3 not available; use openDb() (async) for sql.js fallback");
}
