#!/usr/bin/env node

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_INPUT = ".openclaw-index/documents.jsonl";
const DEFAULT_OUTPUT = ".openclaw-index/retrieval.sqlite";

function usage() {
  console.log(`Build OpenClaw retrieval SQLite DB (FTS5)\n\nUsage:\n  node scripts/indexing/build-openclaw-retrieval-db.mjs [options]\n\nOptions:\n  --in <path>            Input JSONL (default: ${DEFAULT_INPUT})\n  --out <path>           Output sqlite DB (default: ${DEFAULT_OUTPUT})\n  --batch-size <n>       Insert batch size (default: 500)\n  --help                 Show this help\n`);
}

function parseArgs(argv) {
  const options = {
    inputPath: DEFAULT_INPUT,
    outputPath: DEFAULT_OUTPUT,
    batchSize: 500,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      return options;
    }
    if (arg === "--in") {
      options.inputPath = argv[++i];
      continue;
    }
    if (arg === "--out") {
      options.outputPath = argv[++i];
      continue;
    }
    if (arg === "--batch-size") {
      options.batchSize = Math.max(1, Number.parseInt(argv[++i], 10) || 500);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function normalizeText(value) {
  if (typeof value !== "string") {
    return "";
  }
  return value.replace(/\u0000/g, " ");
}

function normalizeNullableText(value) {
  const next = normalizeText(value);
  return next.length > 0 ? next : null;
}

function coerceInt(value, fallback = null) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function getChunkPart(record, key, fallback = null) {
  if (!record || typeof record !== "object") {
    return fallback;
  }
  const chunk = record.chunk;
  if (!chunk || typeof chunk !== "object") {
    return fallback;
  }
  return chunk[key] ?? fallback;
}

function createSchema(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA temp_store = MEMORY;

    DROP TABLE IF EXISTS documents;
    DROP TABLE IF EXISTS documents_fts;

    CREATE TABLE documents (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      locale TEXT,
      title TEXT,
      hash TEXT,
      chunk_index INTEGER,
      chunk_total INTEGER,
      start_line INTEGER,
      end_line INTEGER,
      metadata_json TEXT,
      content TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE documents_fts USING fts5(
      id UNINDEXED,
      kind,
      source,
      locale,
      title,
      content
    );

    CREATE INDEX idx_documents_kind ON documents(kind);
    CREATE INDEX idx_documents_source ON documents(source);
    CREATE INDEX idx_documents_locale ON documents(locale);
  `);
}

async function readJsonlInBatches(filePath, batchSize, onBatch) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let batch = [];
  let lineNo = 0;

  for await (const line of rl) {
    lineNo += 1;
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    batch.push({ lineNo, line: trimmed });
    if (batch.length >= batchSize) {
      await onBatch(batch);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await onBatch(batch);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }

  const inputPath = path.resolve(process.cwd(), args.inputPath);
  const outputPath = path.resolve(process.cwd(), args.outputPath);

  if (!fs.existsSync(inputPath)) {
    throw new Error(`Input JSONL not found: ${inputPath}`);
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) {
    fs.rmSync(outputPath);
  }

  console.log(`[retrieval-db] building ${outputPath}`);
  const db = new DatabaseSync(outputPath);

  try {
    createSchema(db);

    const insertDoc = db.prepare(`
      INSERT INTO documents (
        id, kind, source, locale, title, hash,
        chunk_index, chunk_total, start_line, end_line,
        metadata_json, content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertFts = db.prepare(`
      INSERT INTO documents_fts (id, kind, source, locale, title, content)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    let totalLines = 0;
    let inserted = 0;
    let parseErrors = 0;

    const insertBatch = (rows) => {
      db.exec("BEGIN");
      try {
        for (const item of rows) {
          totalLines += 1;

          let record;
          try {
            record = JSON.parse(item.line);
          } catch {
            parseErrors += 1;
            continue;
          }

          const id = normalizeText(record.id);
          const kind = normalizeText(record.kind);
          const source = normalizeText(record.source);
          const locale = normalizeNullableText(record.locale);
          const title = normalizeNullableText(record.title);
          const hash = normalizeNullableText(record.hash);
          const content = normalizeText(record.content);
          const metadataJson = JSON.stringify(record.metadata ?? {});

          if (!id || !kind || !source || !content) {
            parseErrors += 1;
            continue;
          }

          const chunkIndex = coerceInt(getChunkPart(record, "index"));
          const chunkTotal = coerceInt(getChunkPart(record, "total"));
          const startLine = coerceInt(getChunkPart(record, "startLine"));
          const endLine = coerceInt(getChunkPart(record, "endLine"));

          insertDoc.run(
            id,
            kind,
            source,
            locale,
            title,
            hash,
            chunkIndex,
            chunkTotal,
            startLine,
            endLine,
            metadataJson,
            content,
          );

          insertFts.run(id, kind, source, locale, title, content);
          inserted += 1;
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    };

    await readJsonlInBatches(inputPath, args.batchSize, async (batch) => {
      insertBatch(batch);
    });

    db.exec("ANALYZE;");
    db.exec("PRAGMA optimize;");

    const byKindRows = db
      .prepare("SELECT kind, COUNT(*) as count FROM documents GROUP BY kind ORDER BY count DESC")
      .all();

    console.log(`[retrieval-db] inserted rows: ${inserted}`);
    console.log(`[retrieval-db] parse/validation errors: ${parseErrors}`);
    console.log(`[retrieval-db] source lines read: ${totalLines}`);
    for (const row of byKindRows) {
      console.log(`[retrieval-db] kind=${row.kind} count=${row.count}`);
    }
    console.log(`[retrieval-db] done`);
  } finally {
    db.close();
  }
}

main().catch((error) => {
  console.error(`[retrieval-db] fatal: ${error.stack ?? error}`);
  process.exit(1);
});
