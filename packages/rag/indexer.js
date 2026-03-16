#!/usr/bin/env node
'use strict';

/**
 * RAG Indexer for OpenClaw
 *
 * Scans workspace files matching configured glob patterns, chunks them,
 * embeds using all-MiniLM-L6-v2, and stores in a SQLite vec0 index.
 *
 * Usage: node indexer.js [--force]
 *   --force: Re-index all files regardless of modification time
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { glob } = require('./glob-simple');
const rag = require('./rag-query');

const LARGE_FILE_THRESHOLD = 8192; // bytes — chunk by section if larger

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function fileHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/**
 * Resolve all glob patterns against workspace root.
 */
function resolveFiles(workspaceRoot, patterns) {
  const allFiles = new Set();
  for (const pattern of patterns) {
    const matches = glob(pattern, workspaceRoot);
    for (const m of matches) allFiles.add(m);
  }
  return [...allFiles].sort();
}

/**
 * Chunk a markdown file. Small files → single chunk. Large files → split by H2 headings.
 */
function chunkFile(relativePath, content) {
  if (content.length <= LARGE_FILE_THRESHOLD) {
    const title = extractTitle(content) || path.basename(relativePath, '.md');
    return [{ id: relativePath, title, text: content }];
  }

  // Split by H2 headings
  const lines = content.split('\n');
  const chunks = [];
  let currentTitle = extractTitle(content) || path.basename(relativePath, '.md');
  let currentLines = [];
  let chunkIdx = 0;

  for (const line of lines) {
    if (line.match(/^## /)) {
      // Save previous chunk if non-empty
      if (currentLines.length > 0) {
        const text = currentLines.join('\n').trim();
        if (text.length > 50) {
          chunks.push({
            id: `${relativePath}#${chunkIdx}`,
            title: currentTitle,
            text,
          });
          chunkIdx++;
        }
      }
      currentTitle = line.replace(/^## /, '').trim();
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  // Don't forget the last chunk
  if (currentLines.length > 0) {
    const text = currentLines.join('\n').trim();
    if (text.length > 50) {
      chunks.push({
        id: `${relativePath}#${chunkIdx}`,
        title: currentTitle,
        text,
      });
    }
  }

  // If chunking produced nothing useful, fall back to whole file
  if (chunks.length === 0) {
    return [{ id: relativePath, title: currentTitle, text: content }];
  }

  return chunks;
}

function extractTitle(content) {
  const match = content.match(/^#\s+(.+)/m);
  return match ? match[1].trim() : null;
}

async function main() {
  const forceReindex = process.argv.includes('--force');
  const config = rag.loadConfig();

  log('Starting RAG indexer...');
  log(`Workspace: ${config.workspaceRoot}`);
  log(`DB: ${config.dbPath}`);

  // Resolve files
  const files = resolveFiles(config.workspaceRoot, config.indexPaths);
  log(`Found ${files.length} files to consider`);

  // Open DB and init schema
  const db = rag.openDbWrite();
  rag.initSchema(db);

  // Check which files need (re)indexing
  const existingFiles = new Map();
  for (const row of db.prepare('SELECT path, hash, mtime FROM files').all()) {
    existingFiles.set(row.path, row);
  }

  const toIndex = [];
  const currentPaths = new Set();

  for (const relPath of files) {
    const absPath = path.join(config.workspaceRoot, relPath);
    let stat;
    try {
      stat = fs.statSync(absPath);
    } catch {
      continue; // file disappeared
    }

    const content = fs.readFileSync(absPath, 'utf8');
    const hash = fileHash(content);
    currentPaths.add(relPath);

    const existing = existingFiles.get(relPath);
    if (!forceReindex && existing && existing.hash === hash) {
      continue; // unchanged
    }

    toIndex.push({ relPath, absPath, content, hash, stat });
  }

  // Remove files that no longer exist
  const removedPaths = [...existingFiles.keys()].filter(p => !currentPaths.has(p));
  if (removedPaths.length > 0) {
    const deleteChunks = db.prepare('DELETE FROM chunks WHERE path = ?');
    const deleteFile = db.prepare('DELETE FROM files WHERE path = ?');

    for (const p of removedPaths) {
      const chunkIds = db.prepare('SELECT id FROM chunks WHERE path = ?').all(p);
      for (const row of chunkIds) {
        db.prepare('DELETE FROM chunks_vec WHERE id = ?').run(row.id);
      }
      deleteChunks.run(p);
      deleteFile.run(p);
      log(`  Removed: ${p}`);
    }
  }

  if (toIndex.length === 0) {
    log('All files up to date. Nothing to index.');
    db.close();
    return;
  }

  log(`Indexing ${toIndex.length} files...`);

  // Load the embedding model
  log('Loading embedding model...');
  await rag.getEmbedder();
  log('Model loaded.');

  // Prepare statements
  const upsertFile = db.prepare(`
    INSERT OR REPLACE INTO files (path, hash, mtime, size)
    VALUES (?, ?, ?, ?)
  `);
  const deleteChunksByPath = db.prepare('DELETE FROM chunks WHERE path = ?');
  const insertChunk = db.prepare(`
    INSERT OR REPLACE INTO chunks (id, path, title, text, embedding, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertVec = db.prepare(`
    INSERT OR REPLACE INTO chunks_vec (id, embedding)
    VALUES (?, ?)
  `);
  const deleteVecById = db.prepare('DELETE FROM chunks_vec WHERE id = ?');

  for (const file of toIndex) {
    log(`  Indexing: ${file.relPath} (${file.content.length} bytes)`);

    // Remove old chunks for this file
    const oldChunks = db.prepare('SELECT id FROM chunks WHERE path = ?').all(file.relPath);
    for (const row of oldChunks) {
      deleteVecById.run(row.id);
    }
    deleteChunksByPath.run(file.relPath);

    // Chunk
    const chunks = chunkFile(file.relPath, file.content);

    // Embed all chunks
    const texts = chunks.map(c => c.text);
    const embeddings = await rag.embedBatch(texts);

    // Insert
    const now = Date.now();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const vecBuf = Buffer.from(embeddings[i].buffer);

      insertChunk.run(chunk.id, file.relPath, chunk.title, chunk.text, vecBuf, now);
      insertVec.run(chunk.id, vecBuf);
    }

    // Update file record
    upsertFile.run(file.relPath, file.hash, Math.floor(file.stat.mtimeMs), file.stat.size);
  }

  // Summary
  const totalChunks = db.prepare('SELECT COUNT(*) as c FROM chunks').get().c;
  const totalFiles = db.prepare('SELECT COUNT(*) as c FROM files').get().c;
  log(`Done. ${totalFiles} files, ${totalChunks} chunks indexed.`);

  db.close();
}

main().catch(err => {
  console.error('Indexer failed:', err);
  process.exit(1);
});
