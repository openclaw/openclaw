/**
 * Codebase Indexer - Semantic search via embeddings
 * Uses SQLite + sqlite-vec for vector storage
 * OpenAI text-embedding-3-small for embeddings
 */

const Database = require('better-sqlite3');
const sqliteVec = require('sqlite-vec');
const OpenAI = require('openai').default;
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// Config
const EMBEDDING_MODEL = 'text-embedding-3-small';
const EMBEDDING_DIMS = 1536;
const CHUNK_SIZE = 500; // tokens (roughly 2000 chars)
const CHUNK_OVERLAP = 50; // tokens overlap between chunks

class CodebaseIndexer {
  constructor(workspacePath, dbPath) {
    this.workspacePath = workspacePath;
    this.dbPath = dbPath || path.join(workspacePath, '.clawd-index.db');
    this.db = null;
    this.openai = null;
    this.stats = {
      filesIndexed: 0,
      chunksIndexed: 0,
      lastIndexed: null,
      indexing: false
    };
  }

  /**
   * Initialize database and OpenAI client
   */
  async init() {
    // Init SQLite with sqlite-vec
    this.db = new Database(this.dbPath);
    sqliteVec.load(this.db);

    // Create tables
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id INTEGER PRIMARY KEY,
        path TEXT UNIQUE NOT NULL,
        hash TEXT NOT NULL,
        indexed_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chunks (
        id INTEGER PRIMARY KEY,
        file_id INTEGER NOT NULL,
        chunk_index INTEGER NOT NULL,
        content TEXT NOT NULL,
        start_line INTEGER,
        end_line INTEGER,
        FOREIGN KEY (file_id) REFERENCES files(id) ON DELETE CASCADE
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS vec_chunks USING vec0(
        id INTEGER PRIMARY KEY,
        embedding FLOAT[${EMBEDDING_DIMS}]
      );

      CREATE INDEX IF NOT EXISTS idx_files_path ON files(path);
      CREATE INDEX IF NOT EXISTS idx_chunks_file ON chunks(file_id);
    `);

    // Init OpenAI client - check multiple sources
    let apiKey = process.env.OPENAI_API_KEY;
    
    // Try to read from DNA config if not in env
    if (!apiKey) {
      try {
        const configPath = path.join(os.homedir(), '.dna', 'dna.json');
        if (fs.existsSync(configPath)) {
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          // Check for OpenAI key in providers
          if (config.providers?.openai?.apiKey) {
            apiKey = config.providers.openai.apiKey;
          }
          // Check in env section
          if (!apiKey && config.env?.OPENAI_API_KEY) {
            apiKey = config.env.OPENAI_API_KEY;
          }
        }
      } catch (e) {
        // Ignore config read errors
      }
    }
    
    if (apiKey) {
      this.openai = new OpenAI({ apiKey });
      console.log('[Indexer] OpenAI client initialized');
    } else {
      console.warn('[Indexer] No OPENAI_API_KEY found - semantic search disabled');
      console.warn('[Indexer] Set OPENAI_API_KEY env var or add to dna.json providers.openai.apiKey');
    }

    // Load stats
    this.loadStats();
    console.log(`[Indexer] Initialized. ${this.stats.filesIndexed} files indexed.`);
  }

  /**
   * Load stats from database
   */
  loadStats() {
    const fileCount = this.db.prepare('SELECT COUNT(*) as count FROM files').get();
    const chunkCount = this.db.prepare('SELECT COUNT(*) as count FROM chunks').get();
    const lastFile = this.db.prepare('SELECT MAX(indexed_at) as ts FROM files').get();
    
    this.stats.filesIndexed = fileCount?.count || 0;
    this.stats.chunksIndexed = chunkCount?.count || 0;
    this.stats.lastIndexed = lastFile?.ts ? new Date(lastFile.ts).toISOString() : null;
  }

  /**
   * Get current stats
   */
  getStats() {
    this.loadStats();
    return { ...this.stats };
  }

  /**
   * Check if file needs reindexing
   */
  needsReindex(filePath, content) {
    const hash = crypto.createHash('md5').update(content).digest('hex');
    const existing = this.db.prepare('SELECT hash FROM files WHERE path = ?').get(filePath);
    return !existing || existing.hash !== hash;
  }

  /**
   * Split code into chunks
   */
  chunkCode(content, filePath) {
    const chunks = [];
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();
    
    // For JS/TS, try to split by functions/classes
    if (['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
      return this.chunkByFunctions(content, lines);
    }
    
    // For other files, chunk by line count
    return this.chunkByLines(lines, 50); // ~50 lines per chunk
  }

  /**
   * Chunk by function/class boundaries (JS/TS)
   */
  chunkByFunctions(content, lines) {
    const chunks = [];
    const functionPattern = /^(?:export\s+)?(?:async\s+)?(?:function|const|let|var|class)\s+\w+|^\s*\w+\s*[=:]\s*(?:async\s+)?(?:function|\(.*\)\s*=>)/;
    
    let currentChunk = [];
    let chunkStart = 0;
    let braceDepth = 0;
    let inFunction = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      currentChunk.push(line);

      // Track brace depth
      braceDepth += (line.match(/{/g) || []).length;
      braceDepth -= (line.match(/}/g) || []).length;

      // Detect function start
      if (functionPattern.test(line)) {
        inFunction = true;
      }

      // End chunk at function boundary or size limit
      const chunkText = currentChunk.join('\n');
      if ((inFunction && braceDepth === 0 && currentChunk.length > 5) || 
          chunkText.length > CHUNK_SIZE * 4) {
        chunks.push({
          content: chunkText,
          startLine: chunkStart + 1,
          endLine: i + 1
        });
        currentChunk = [];
        chunkStart = i + 1;
        inFunction = false;
      }
    }

    // Don't forget the last chunk
    if (currentChunk.length > 0) {
      chunks.push({
        content: currentChunk.join('\n'),
        startLine: chunkStart + 1,
        endLine: lines.length
      });
    }

    return chunks;
  }

  /**
   * Simple line-based chunking
   */
  chunkByLines(lines, linesPerChunk) {
    const chunks = [];
    for (let i = 0; i < lines.length; i += linesPerChunk - 10) {
      const chunk = lines.slice(i, i + linesPerChunk);
      chunks.push({
        content: chunk.join('\n'),
        startLine: i + 1,
        endLine: Math.min(i + linesPerChunk, lines.length)
      });
    }
    return chunks;
  }

  /**
   * Get embeddings from OpenAI
   */
  async getEmbeddings(texts) {
    if (!this.openai) {
      throw new Error('OpenAI client not initialized');
    }

    const response = await this.openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts
    });

    return response.data.map(d => d.embedding);
  }

  /**
   * Index a single file
   */
  async indexFile(filePath) {
    const fullPath = path.join(this.workspacePath, filePath);
    
    if (!fs.existsSync(fullPath)) {
      console.log(`[Indexer] File not found: ${filePath}`);
      return false;
    }

    const content = fs.readFileSync(fullPath, 'utf8');
    
    // Skip if unchanged
    if (!this.needsReindex(filePath, content)) {
      return false;
    }

    const hash = crypto.createHash('md5').update(content).digest('hex');
    const chunks = this.chunkCode(content, filePath);

    if (chunks.length === 0) {
      return false;
    }

    // Get embeddings for all chunks
    let embeddings = [];
    if (this.openai) {
      try {
        embeddings = await this.getEmbeddings(chunks.map(c => c.content));
      } catch (err) {
        console.error(`[Indexer] Embedding error for ${filePath}:`, err.message);
        return false;
      }
    }

    // Transaction for atomicity
    const transaction = this.db.transaction(() => {
      // Delete old data for this file
      const existingFile = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath);
      if (existingFile) {
        this.db.prepare('DELETE FROM vec_chunks WHERE id IN (SELECT id FROM chunks WHERE file_id = ?)').run(existingFile.id);
        this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(existingFile.id);
        this.db.prepare('DELETE FROM files WHERE id = ?').run(existingFile.id);
      }

      // Insert file
      const fileResult = this.db.prepare(
        'INSERT INTO files (path, hash, indexed_at) VALUES (?, ?, ?)'
      ).run(filePath, hash, Date.now());
      const fileId = fileResult.lastInsertRowid;

      // Insert chunks and embeddings
      const insertChunk = this.db.prepare(
        'INSERT INTO chunks (file_id, chunk_index, content, start_line, end_line) VALUES (?, ?, ?, ?, ?)'
      );
      const insertVec = this.db.prepare(
        'INSERT INTO vec_chunks (id, embedding) VALUES (?, ?)'
      );

      for (let i = 0; i < chunks.length; i++) {
        const chunkResult = insertChunk.run(
          fileId,
          i,
          chunks[i].content,
          chunks[i].startLine,
          chunks[i].endLine
        );

        if (embeddings[i]) {
          insertVec.run(chunkResult.lastInsertRowid, JSON.stringify(embeddings[i]));
        }
      }
    });

    transaction();
    console.log(`[Indexer] Indexed ${filePath} (${chunks.length} chunks)`);
    return true;
  }

  /**
   * Index entire workspace
   */
  async indexWorkspace(options = {}) {
    if (this.stats.indexing) {
      return { error: 'Indexing already in progress' };
    }

    this.stats.indexing = true;
    const startTime = Date.now();
    let indexed = 0;
    let skipped = 0;
    let errors = [];

    const ignoreDirs = ['node_modules', '.git', 'dist', 'build', '.next', 'coverage', '.clawd-index.db'];
    const allowedExts = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.h', '.css', '.scss', '.html', '.json', '.md', '.yaml', '.yml'];

    const walkDir = async (dir) => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        if (ignoreDirs.includes(entry.name)) continue;

        const fullPath = path.join(dir, entry.name);
        const relativePath = path.relative(this.workspacePath, fullPath);

        if (entry.isDirectory()) {
          await walkDir(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!allowedExts.includes(ext)) continue;

          try {
            const wasIndexed = await this.indexFile(relativePath);
            if (wasIndexed) indexed++;
            else skipped++;
          } catch (err) {
            errors.push({ file: relativePath, error: err.message });
          }
        }
      }
    };

    try {
      await walkDir(this.workspacePath);
    } finally {
      this.stats.indexing = false;
    }

    this.loadStats();
    const duration = ((Date.now() - startTime) / 1000).toFixed(1);

    return {
      indexed,
      skipped,
      errors: errors.length,
      errorDetails: errors.slice(0, 10),
      duration: `${duration}s`,
      stats: this.getStats()
    };
  }

  /**
   * Semantic search
   */
  async search(query, limit = 10) {
    if (!this.openai) {
      return { error: 'Embeddings not available (no API key)', results: [] };
    }

    // Get query embedding
    const [queryEmbedding] = await this.getEmbeddings([query]);

    // Vector similarity search
    const results = this.db.prepare(`
      SELECT 
        c.id,
        c.content,
        c.start_line,
        c.end_line,
        f.path,
        v.distance
      FROM vec_chunks v
      JOIN chunks c ON c.id = v.id
      JOIN files f ON f.id = c.file_id
      WHERE v.embedding MATCH ?
      ORDER BY v.distance
      LIMIT ?
    `).all(JSON.stringify(queryEmbedding), limit);

    return {
      query,
      results: results.map(r => ({
        file: r.path,
        content: r.content,
        startLine: r.start_line,
        endLine: r.end_line,
        score: 1 - r.distance // Convert distance to similarity score
      }))
    };
  }

  /**
   * Delete file from index
   */
  deleteFile(filePath) {
    const file = this.db.prepare('SELECT id FROM files WHERE path = ?').get(filePath);
    if (file) {
      this.db.prepare('DELETE FROM vec_chunks WHERE id IN (SELECT id FROM chunks WHERE file_id = ?)').run(file.id);
      this.db.prepare('DELETE FROM chunks WHERE file_id = ?').run(file.id);
      this.db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
      console.log(`[Indexer] Removed ${filePath} from index`);
    }
  }

  /**
   * Clear entire index
   */
  clearIndex() {
    this.db.exec('DELETE FROM vec_chunks');
    this.db.exec('DELETE FROM chunks');
    this.db.exec('DELETE FROM files');
    this.loadStats();
    console.log('[Indexer] Index cleared');
  }
}

module.exports = CodebaseIndexer;
