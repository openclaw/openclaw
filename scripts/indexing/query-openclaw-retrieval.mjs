#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import path from "node:path";

const DEFAULT_DB = ".openclaw-index/retrieval.sqlite";

function usage() {
  console.log(`Query OpenClaw retrieval DB\n\nUsage:\n  node scripts/indexing/query-openclaw-retrieval.mjs --q "your query" [options]\n\nOptions:\n  --db <path>               SQLite DB path (default: ${DEFAULT_DB})\n  --q <text>                Query text (required)\n  --kinds <csv>             Filter by kind(s): doc,code,runtime,config-doc\n  --locale <csv>            Filter locales (example: en,zh-CN)\n  --source-prefix <csv>     Filter source prefixes (example: docs/,src/)\n  --match <mode>            FTS match mode: all|any (default: all)\n  --limit <n>               Max results (default: 8)\n  --json                    JSON output\n  --snippet-chars <n>       Snippet chars in text output (default: 280)\n  --help                    Show this help\n`);
}

function parseArgs(argv) {
  const options = {
    dbPath: DEFAULT_DB,
    query: "",
    kinds: [],
    locales: [],
    sourcePrefixes: [],
    matchMode: "all",
    limit: 8,
    json: false,
    snippetChars: 280,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--db") {
      options.dbPath = argv[++i];
      continue;
    }
    if (arg === "--q") {
      options.query = argv[++i] ?? "";
      continue;
    }
    if (arg === "--kinds") {
      options.kinds = (argv[++i] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--locale") {
      options.locales = (argv[++i] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--source-prefix") {
      options.sourcePrefixes = (argv[++i] ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (arg === "--match") {
      const value = (argv[++i] ?? "").trim().toLowerCase();
      if (value !== "all" && value !== "any") {
        throw new Error(`Invalid --match value: ${value}. Use all|any`);
      }
      options.matchMode = value;
      continue;
    }
    if (arg === "--limit") {
      options.limit = Math.max(1, Number.parseInt(argv[++i], 10) || 8);
      continue;
    }
    if (arg === "--snippet-chars") {
      options.snippetChars = Math.max(80, Number.parseInt(argv[++i], 10) || 280);
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function buildFtsQuery(raw) {
  const tokens =
    raw
      .match(/[\p{L}\p{N}_-]+/gu)
      ?.map((token) => token.trim())
      .filter(Boolean) ?? [];

  if (tokens.length === 0) {
    return { all: null, any: null, tokenCount: 0 };
  }

  const escaped = tokens.map((token) => `"${token.replaceAll('"', "")}"`);
  return {
    all: escaped.join(" AND "),
    any: escaped.join(" OR "),
    tokenCount: escaped.length,
  };
}

function bm25RankToScore(rank) {
  const normalized = Number.isFinite(rank) ? Math.abs(rank) : 999;
  return 1 / (1 + normalized);
}

function clip(text, maxChars) {
  if (!text) {
    return "";
  }
  const normalized = String(text).replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 1)}…`;
}

function buildSql(options) {
  const clauses = ["documents_fts MATCH ?"];
  const params = [];

  if (options.kinds.length > 0) {
    clauses.push(`d.kind IN (${options.kinds.map(() => "?").join(", ")})`);
    params.push(...options.kinds);
  }

  if (options.locales.length > 0) {
    clauses.push(`d.locale IN (${options.locales.map(() => "?").join(", ")})`);
    params.push(...options.locales);
  }

  if (options.sourcePrefixes.length > 0) {
    const group = options.sourcePrefixes.map(() => "d.source LIKE ?").join(" OR ");
    clauses.push(`(${group})`);
    params.push(...options.sourcePrefixes.map((prefix) => `${prefix}%`));
  }

  const whereSql = clauses.join(" AND ");

  const sql = `
    SELECT
      d.id,
      d.kind,
      d.source,
      d.locale,
      d.title,
      d.start_line,
      d.end_line,
      d.metadata_json,
      bm25(documents_fts) AS rank,
      snippet(documents_fts, 5, '[', ']', ' … ', 18) AS snippet,
      d.content
    FROM documents_fts
    JOIN documents d ON d.id = documents_fts.id
    WHERE ${whereSql}
    ORDER BY rank ASC
    LIMIT ?
  `;

  return { sql, params };
}

function renderText(rows, options) {
  if (rows.length === 0) {
    console.log("No results");
    return;
  }

  rows.forEach((row, index) => {
    const score = bm25RankToScore(row.rank);
    const title = row.title || "(untitled)";
    const locale = row.locale || "-";
    const lineRange = row.start_line && row.end_line ? `${row.start_line}-${row.end_line}` : "-";
    const snippet = clip(row.snippet || row.content || "", options.snippetChars);

    console.log(`${index + 1}. ${title}`);
    console.log(`   score=${score.toFixed(4)} kind=${row.kind} locale=${locale}`);
    console.log(`   source=${row.source} lines=${lineRange}`);
    console.log(`   ${snippet}`);
  });
}

function renderJson(rows) {
  const payload = rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    source: row.source,
    locale: row.locale,
    title: row.title,
    startLine: row.start_line,
    endLine: row.end_line,
    rank: row.rank,
    score: bm25RankToScore(row.rank),
    snippet: row.snippet || row.content,
    metadata: (() => {
      try {
        return JSON.parse(row.metadata_json || "{}");
      } catch {
        return {};
      }
    })(),
  }));

  console.log(JSON.stringify(payload, null, 2));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    return;
  }

  if (!options.query.trim()) {
    throw new Error("Missing required --q query text");
  }

  const ftsQueries = buildFtsQuery(options.query);
  if (!ftsQueries.all || !ftsQueries.any) {
    throw new Error("Query must contain at least one searchable token");
  }

  const dbPath = path.resolve(process.cwd(), options.dbPath);
  const db = new DatabaseSync(dbPath, { open: true, readOnly: true });

  try {
    const { sql, params } = buildSql(options);
    const primaryQuery = options.matchMode === "any" ? ftsQueries.any : ftsQueries.all;
    let rows = db.prepare(sql).all(primaryQuery, ...params, options.limit);

    // Auto-broaden if strict all-token search returns nothing.
    if (rows.length === 0 && options.matchMode === "all" && ftsQueries.tokenCount > 1) {
      rows = db.prepare(sql).all(ftsQueries.any, ...params, options.limit);
    }

    if (options.json) {
      renderJson(rows);
    } else {
      renderText(rows, options);
    }
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  console.error(`[retrieval-query] fatal: ${error.stack ?? error}`);
  process.exit(1);
}
