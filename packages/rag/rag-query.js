'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');

let _pipeline = null;
let _embedder = null;
let _configCache = null;

/**
 * Resolve the config path. Checks (in order):
 *   1. RAG_CONFIG env var
 *   2. ~/.openclaw/rag/config.json
 *   3. ./config.json (fallback for development)
 */
function resolveConfigPath() {
  if (process.env.RAG_CONFIG) return process.env.RAG_CONFIG;
  const home = process.env.HOME || process.env.USERPROFILE;
  const clawPath = path.join(home, '.openclaw', 'rag', 'config.json');
  if (fs.existsSync(clawPath)) return clawPath;
  return path.join(__dirname, 'config.json');
}

function loadConfig() {
  if (_configCache) return _configCache;
  const configPath = resolveConfigPath();
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  // Resolve relative paths against home directory
  const home = process.env.HOME || process.env.USERPROFILE;
  const defaults = {
    enabled: true,
    similarityThreshold: 0.35,
    maxInjectedTokens: 8000,
    maxResults: 5,
    embeddingModel: 'Xenova/all-MiniLM-L6-v2',
    embeddingDims: 384,
    workspaceRoot: path.join(home, '.openclaw', 'workspace'),
    dbPath: path.join(home, '.openclaw', 'rag', 'index.sqlite'),
    logPath: path.join(home, '.openclaw', 'logs', 'rag.log'),
    indexPaths: [
      'skills/*/SKILL.md',
      'skills/*/references/*.md',
      'memory/*.md',
      'MEMORY.md',
    ],
    excludePatterns: [],
  };

  _configCache = { ...defaults, ...raw };
  return _configCache;
}

/** Reset config cache (useful for tests or after config changes). */
function resetConfig() {
  _configCache = null;
}

/**
 * Lazily load the embedding pipeline.
 * First call downloads/loads the model (~4s), subsequent calls are instant.
 */
async function getEmbedder() {
  if (_embedder) return _embedder;
  if (!_pipeline) {
    const { pipeline } = require('@huggingface/transformers');
    _pipeline = pipeline;
  }
  const config = loadConfig();
  _embedder = await _pipeline('feature-extraction', config.embeddingModel, { dtype: 'fp32' });
  return _embedder;
}

/**
 * Embed a single text string. Returns Float32Array of length embeddingDims.
 */
async function embed(text) {
  const embedder = await getEmbedder();
  const result = await embedder(text, { pooling: 'mean', normalize: true });
  return new Float32Array(result.data);
}

/**
 * Embed multiple texts. Returns array of Float32Array.
 */
async function embedBatch(texts) {
  const embedder = await getEmbedder();
  const results = [];
  // Process one at a time — transformers.js doesn't reliably batch for feature-extraction
  for (const text of texts) {
    const result = await embedder(text, { pooling: 'mean', normalize: true });
    results.push(new Float32Array(result.data));
  }
  return results;
}

/**
 * Open the RAG index database (read-only by default).
 */
function openDb(readonly = true) {
  const config = loadConfig();
  if (!fs.existsSync(config.dbPath)) {
    return null;
  }
  const db = new Database(config.dbPath, { readonly });
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Open the RAG index database for writing (creates if needed).
 */
function openDbWrite() {
  const config = loadConfig();
  const dir = path.dirname(config.dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(config.dbPath);
  sqliteVec.load(db);
  db.pragma('journal_mode = WAL');
  return db;
}

/**
 * Initialize the database schema.
 */
function initSchema(db) {
  const config = loadConfig();
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      title TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);
  `);

  // Create vec0 virtual table if it doesn't exist
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[${config.embeddingDims}]
      );
    `);
  } catch (e) {
    if (e.message.includes('already exists')) {
      db.exec('DROP TABLE chunks_vec');
      db.exec(`
        CREATE VIRTUAL TABLE chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[${config.embeddingDims}]
        );
      `);
    } else {
      throw e;
    }
  }
}

/**
 * Search for chunks similar to the query text.
 * Returns array of { id, path, title, text, similarity }.
 */
async function search(queryText, opts = {}) {
  const config = loadConfig();
  const threshold = opts.threshold ?? config.similarityThreshold;
  const maxResults = opts.maxResults ?? config.maxResults;

  const db = openDb(true);
  if (!db) return [];

  try {
    const queryVec = await embed(queryText);
    const vecBuf = Buffer.from(queryVec.buffer);

    const rows = db.prepare(`
      SELECT
        cv.id,
        cv.distance,
        c.path,
        c.title,
        c.text
      FROM chunks_vec cv
      JOIN chunks c ON c.id = cv.id
      WHERE cv.embedding MATCH ?
        AND k = ?
      ORDER BY cv.distance ASC
    `).all(vecBuf, maxResults * 2);

    // vec0 returns L2 distance; convert to cosine similarity.
    // Since vectors are normalized: L2² = 2 - 2·cos(θ), so cos(θ) = 1 - L2²/2
    const results = rows.map(row => {
      const l2dist = row.distance;
      const cosineSim = 1 - (l2dist * l2dist) / 2;
      return {
        id: row.id,
        path: row.path,
        title: row.title,
        text: row.text,
        similarity: cosineSim,
      };
    }).filter(r => r.similarity >= threshold);

    return results.slice(0, maxResults);
  } finally {
    db.close();
  }
}

/**
 * Given search results, read the full source files and return deduplicated file contents.
 * Groups chunks by file path and returns full file text.
 */
function getFullFiles(results, workspaceRoot) {
  const config = loadConfig();
  workspaceRoot = workspaceRoot || config.workspaceRoot;
  const seen = new Set();
  const files = [];

  for (const result of results) {
    if (seen.has(result.path)) continue;
    seen.add(result.path);

    const fullPath = path.join(workspaceRoot, result.path);
    try {
      const content = fs.readFileSync(fullPath, 'utf8');
      files.push({
        path: result.path,
        content,
        similarity: result.similarity,
      });
    } catch (e) {
      // File may have been deleted since indexing — skip
    }
  }

  return files;
}

/**
 * Format retrieved files for injection into the system prompt.
 */
function formatForInjection(files) {
  if (!files.length) return null;

  let parts = [
    '[Automatically retrieved context — these files matched the current query]\n'
  ];

  for (const file of files) {
    parts.push(`=== ${file.path} (similarity: ${file.similarity.toFixed(3)}) ===`);
    parts.push(file.content);
    parts.push('');
  }

  return parts.join('\n');
}

module.exports = {
  loadConfig,
  resetConfig,
  getEmbedder,
  embed,
  embedBatch,
  openDb,
  openDbWrite,
  initSchema,
  search,
  getFullFiles,
  formatForInjection,
};
