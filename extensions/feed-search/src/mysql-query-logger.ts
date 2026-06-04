import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginLogger } from "../api.js";

const require_ = createRequire(import.meta.url);

/** Detect a prior injection so we never append the snippet twice. */
const MARKER = "OpenClaw SQL query logger (auto-injected)";

/**
 * Where the broad mysql2 query audit log is written (shared feed-search logs dir).
 * Honors `OPENCLAW_SQL_LOG_PATH` so operators can redirect it; the on-disk hook
 * reads the same env var so gateway and subprocesses agree.
 */
export function sqlQueryLogPath(): string {
  return (
    process.env.OPENCLAW_SQL_LOG_PATH ??
    path.join(homedir(), ".openclaw", "logs", "mysql-queries.jsonl")
  );
}

/** Stable absolute path for the standalone hook required by every patched install. */
function hookPath(): string {
  return path.join(homedir(), ".openclaw", "mysql-sql-log-hook.cjs");
}

/**
 * Source of the standalone CJS hook. It is `require()`d by both the gateway
 * (in-process) and every agent-spawned `node` subprocess (via an injected line
 * in mysql2's `connection.js`). Given a mysql2 connection class it wraps
 * `query`/`execute` on the prototype — which the `mysql2/promise` API delegates
 * to — so every SQL statement is appended to the JSONL log regardless of which
 * API or process issued it. Written verbatim to disk; keep it dependency-free.
 */
export const HOOK_SOURCE = `'use strict';
// ${MARKER} — wraps a mysql2 connection prototype so every query/execute
// (callback + promise API) is appended to ~/.openclaw/logs/mysql-queries.jsonl.
// Safe to delete: OpenClaw re-creates and re-applies it on the next gateway start.
const fs = require('fs');
const os = require('os');
const path = require('path');
const LOG_PATH = process.env.OPENCLAW_SQL_LOG_PATH || path.join(os.homedir(), '.openclaw', 'logs', 'mysql-queries.jsonl');
let dirReady = false;
function ensureDir() {
  if (dirReady) return;
  try { fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true }); dirReady = true; } catch (e) {}
}
function extractSql(args) {
  const a0 = args[0];
  let sql; let params;
  if (a0 && typeof a0 === 'object') { sql = a0.sql; params = a0.values; } else { sql = a0; }
  if (params === undefined && args.length > 1 && typeof args[1] !== 'function') params = args[1];
  return {
    sql: typeof sql === 'string' ? sql : (sql == null ? '' : String(sql)),
    params: params === undefined ? null : params,
  };
}
function append(method, args) {
  try {
    ensureDir();
    const info = extractSql(args);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      method: method,
      sql: info.sql,
      params: info.params,
    });
    fs.appendFileSync(LOG_PATH, line + '\\n');
  } catch (e) { /* never break a query because logging failed */ }
}
module.exports = function patch(ConnectionClass) {
  try {
    const proto = ConnectionClass && ConnectionClass.prototype;
    if (!proto || proto.__openclawSqlLogPatched) return;
    Object.defineProperty(proto, '__openclawSqlLogPatched', { value: true, enumerable: false });
    for (const method of ['query', 'execute']) {
      const orig = proto[method];
      if (typeof orig !== 'function') continue;
      proto[method] = function () { append(method, arguments); return orig.apply(this, arguments); };
    }
  } catch (e) { /* swallow — logging must never affect query behaviour */ }
};
`;

/** Write (or refresh) the hook file. Returns its absolute path. */
function writeHook(): string {
  const p = hookPath();
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, HOOK_SOURCE, "utf8");
  return p;
}

/**
 * For a mysql2 install dir, pick the file that defines the connection class whose
 * prototype carries `query`/`execute`. Newer mysql2 (>=3.13) splits this into
 * `lib/base/connection.js` (exports `BaseConnection`); older versions keep it in
 * `lib/connection.js`. Prefer base/ so we patch exactly one prototype per install.
 */
function connectionFileForInstall(installDir: string): string | null {
  const base = path.join(installDir, "lib", "base", "connection.js");
  if (existsSync(base)) {
    return base;
  }
  const legacy = path.join(installDir, "lib", "connection.js");
  if (existsSync(legacy)) {
    return legacy;
  }
  return null;
}

/**
 * mysql2 install dirs to cover: the in-process one (gateway) and the home-dir one
 * the agent's workspace scripts resolve (the workspace has no node_modules, so
 * Node walks up to ~/node_modules), plus a best-effort global location.
 */
function discoverInstallDirs(): string[] {
  const dirs: string[] = [];
  try {
    dirs.push(path.dirname(require_.resolve("mysql2/package.json")));
  } catch {
    // mysql2 not resolvable in-process; on-disk candidates below still apply.
  }
  dirs.push(path.join(homedir(), "node_modules", "mysql2"));
  const appData = process.env.APPDATA;
  if (appData) {
    dirs.push(path.join(appData, "npm", "node_modules", "mysql2"));
  }
  return dirs;
}

/** Append the guarded hook require to a connection.js if not already present. */
function injectOnDisk(connectionFile: string, hook: string, logger: PluginLogger): void {
  try {
    const src = readFileSync(connectionFile, "utf8");
    if (src.includes(MARKER)) {
      return;
    }
    const snippet =
      `\n\n// === ${MARKER}: log every query/execute to ~/.openclaw/logs/mysql-queries.jsonl ===\n` +
      `try { require(${JSON.stringify(hook)})(module.exports); } catch (e) {}\n`;
    writeFileSync(connectionFile, src + snippet, "utf8");
    logger.info(`[FEED_SEARCH] Injected SQL query logger into ${connectionFile}`);
  } catch (err) {
    logger.warn(`[FEED_SEARCH] Failed to inject SQL logger into ${connectionFile}: ${String(err)}`);
  }
}

/**
 * Patch the already-loaded in-process mysql2 prototype directly. The on-disk
 * injection only takes effect on the next `require()`, so the gateway's own
 * connection module (likely loaded before this runs) needs an explicit patch.
 */
function patchInProcess(hook: string, logger: PluginLogger): void {
  try {
    const installDir = path.dirname(require_.resolve("mysql2/package.json"));
    const connectionFile = connectionFileForInstall(installDir);
    if (!connectionFile) {
      return;
    }
    const patch = require_(hook) as (connectionClass: unknown) => void;
    // Absolute require bypasses mysql2's `exports` map and reuses the cached
    // module instance the live connections share, so the patch takes effect.
    const ConnectionClass = require_(connectionFile);
    patch(ConnectionClass);
    logger.info("[FEED_SEARCH] SQL query logger applied to in-process mysql2");
  } catch (err) {
    logger.warn(`[FEED_SEARCH] In-process SQL logger patch failed: ${String(err)}`);
  }
}

/**
 * Install JSONL logging of every mysql2 query/execute across the gateway and any
 * agent-spawned subprocess. Idempotent and fully defensive: any failure is logged
 * and swallowed so it can never block gateway startup or break a query.
 */
export function installSqlQueryLogging(logger: PluginLogger): void {
  try {
    const hook = writeHook();

    const seen = new Set<string>();
    for (const installDir of discoverInstallDirs()) {
      const connectionFile = connectionFileForInstall(installDir);
      if (!connectionFile) {
        continue;
      }
      let real = connectionFile;
      try {
        real = realpathSync(connectionFile);
      } catch {
        // fall back to the non-resolved path for dedupe
      }
      if (seen.has(real)) {
        continue;
      }
      seen.add(real);
      injectOnDisk(connectionFile, hook, logger);
    }

    patchInProcess(hook, logger);
    logger.info(`[FEED_SEARCH] SQL query logging active → ${sqlQueryLogPath()}`);
  } catch (err) {
    logger.warn(`[FEED_SEARCH] installSqlQueryLogging failed: ${String(err)}`);
  }
}
