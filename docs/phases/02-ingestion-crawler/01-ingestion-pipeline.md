# Phase 2, Task 01: Document Ingestion Pipeline

**Phase:** 2 - Manual Ingestion + Web Crawler
**Task:** Implement file and text ingestion pipeline
**Duration:** 2 days
**Complexity:** Medium
**Depends on:** Phase 1 complete

---

## Task Overview

Create an ingestion pipeline that:
- Accepts file uploads (PDF, DOCX, MD, TXT, HTML, JSON)
- Accepts raw text input
- Parses documents into chunks
- Triggers entity extraction
- Stores sources and results

## Architecture Decision

**Reference:** Phase 2 in `docs/plans/graphrag/ZAI-PLAN.md`

## File Structure

```
src/knowledge/ingest/
├── pipeline.ts            # Main ingestion orchestrator
├── parsers/
│   ├── pdf.ts             # PDF parser (pdfjs-dist)
│   ├── docx.ts            # DOCX parser (mammoth)
│   ├── html.ts            # HTML parser (@mozilla/readability)
│   ├── markdown.ts        # Markdown parser (native)
│   └── text.ts            # Plain text parser (native)
└── pipeline.test.ts
```

## Core Implementation

**File:** `src/knowledge/ingest/pipeline.ts`

```typescript
/**
 * Document ingestion pipeline.
 *
 * Supports:
 * - File uploads (PDF, DOCX, MD, TXT, HTML, JSON)
 * - Raw text input
 * - URL fetching (via crawler)
 * - Chunking and entity extraction
 * - Source tracking
 *
 * Reference: docs/plans/graphrag/ZAI-PLAN.md Phase 2
 */

import fs from 'fs/promises';
import path from 'path';
import { createHash } from 'crypto';
import type { RelationalDatastore } from '../datastore/interface.js';
import type { EntityExtraction } from '../graph/types.js';
import { HybridExtractor } from '../extraction/hybrid-extractor.js';
import { EntityConsolidator } from '../consolidation/consolidator.js';
import { parsePDF } from './parsers/pdf.js';
import { parseDOCX } from './parsers/docx.js';
import { parseHTML } from './parsers/html.js';
import { parseMarkdown } from './parsers/markdown.js';
import { parseText } from './parsers/text.js';

// ============================================================================
// TYPES
// ============================================================================

export type IngestionSource =
  | 'memory'      // From memory sync (automatic)
  | 'manual'      // User uploaded file
  | 'crawl'       // From web crawler
  | 'api';        // From API ingestion

export interface IngestionOptions {
  /** Source type */
  source: IngestionSource;
  /** Tags for organization */
  tags?: string[];
  /** Custom metadata */
  metadata?: Record<string, any>;
  /** Skip extraction (content only) */
  skipExtraction?: boolean;
  /** Chunk size for text splitting */
  chunkSize?: number;
  /** Chunk overlap */
  chunkOverlap?: number;
}

export interface IngestionResult {
  sourceId: string;
  status: 'success' | 'partial' | 'error';
  chunksProcessed: number;
  entitiesExtracted: number;
  relationshipsExtracted: number;
  error?: string;
  duration: number;
}

export interface FileIngestionOptions extends IngestionOptions {
  source: 'manual';
  filePath: string;
  mimeType?: string;
}

export interface TextIngestionOptions extends IngestionOptions {
  source: 'manual';
  text: string;
  title?: string;
}

export interface URLIngestionOptions extends IngestionOptions {
  source: 'crawl';
  url: string;
  crawlId?: string;
}

// ============================================================================
// INGESTION PIPELINE
// ============================================================================

export class IngestionPipeline {
  private datastore: RelationalDatastore;
  private extractor: HybridExtractor;
  private consolidator: EntityConsolidator;
  private defaultChunkSize = 1000;
  private defaultChunkOverlap = 200;

  constructor(
    datastore: RelationalDatastore,
    extractor: HybridExtractor,
    consolidator: EntityConsolidator
  ) {
    this.datastore = datastore;
    this.extractor = extractor;
    this.consolidator = consolidator;
  }

  /**
   * Ingest a file from disk.
   */
  async ingestFile(options: FileIngestionOptions): Promise<IngestionResult> {
    const startTime = Date.now();

    try {
      // Read file
      const content = await fs.readFile(options.filePath, 'utf-8');

      // Detect MIME type if not provided
      const mimeType = options.mimeType || this.detectMimeType(options.filePath);

      // Parse based on MIME type
      const parsed = await this.parseContent(content, mimeType);

      // Create source record
      const sourceId = this.generateSourceId(options.filePath, 'manual');
      await this.createSourceRecord(sourceId, {
        type: 'file',
        path: options.filePath,
        mimeType,
        tags: options.tags || [],
        metadata: options.metadata || {},
      });

      // Process content
      const result = await this.processContent(
        sourceId,
        parsed.text,
        options
      );

      return {
        sourceId,
        status: 'success',
        chunksProcessed: result.chunksProcessed,
        entitiesExtracted: result.entitiesExtracted,
        relationshipsExtracted: result.relationshipsExtracted,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        sourceId: '',
        status: 'error',
        chunksProcessed: 0,
        entitiesExtracted: 0,
        relationshipsExtracted: 0,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Ingest raw text directly.
   */
  async ingestText(options: TextIngestionOptions): Promise<IngestionResult> {
    const startTime = Date.now();

    try {
      const sourceId = this.generateSourceId(options.title || options.text.slice(0, 50), 'manual');

      await this.createSourceRecord(sourceId, {
        type: 'text',
        title: options.title || 'Untitled',
        tags: options.tags || [],
        metadata: options.metadata || {},
      });

      const result = await this.processContent(sourceId, options.text, options);

      return {
        sourceId,
        status: 'success',
        chunksProcessed: result.chunksProcessed,
        entitiesExtracted: result.entitiesExtracted,
        relationshipsExtracted: result.relationshipsExtracted,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        sourceId: '',
        status: 'error',
        chunksProcessed: 0,
        entitiesExtracted: 0,
        relationshipsExtracted: 0,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * Ingest content from a URL (via crawler).
   */
  async ingestURL(options: URLIngestionOptions, htmlContent: string): Promise<IngestionResult> {
    const startTime = Date.now();

    try {
      const sourceId = this.generateSourceId(options.url, 'crawl');

      await this.createSourceRecord(sourceId, {
        type: 'url',
        url: options.url,
        crawlId: options.crawlId,
        tags: options.tags || [],
        metadata: options.metadata || {},
      });

      // Parse HTML
      const parsed = await parseHTML(htmlContent);

      const result = await this.processContent(sourceId, parsed.text, options);

      return {
        sourceId,
        status: 'success',
        chunksProcessed: result.chunksProcessed,
        entitiesExtracted: result.entitiesExtracted,
        relationshipsExtracted: result.relationshipsExtracted,
        duration: Date.now() - startTime,
      };
    } catch (error) {
      return {
        sourceId: '',
        status: 'error',
        chunksProcessed: 0,
        entitiesExtracted: 0,
        relationshipsExtracted: 0,
        error: (error as Error).message,
        duration: Date.now() - startTime,
      };
    }
  }

  // ------------------------------------------------------------------------
  // PRIVATE
  // ------------------------------------------------------------------------

  /**
   * Process content: chunk, extract, consolidate, store.
   */
  private async processContent(
    sourceId: string,
    text: string,
    options: IngestionOptions
  ): Promise<{
    chunksProcessed: number;
    entitiesExtracted: number;
    relationshipsExtracted: number;
  }> {
    const chunkSize = options.chunkSize || this.defaultChunkSize;
    const chunkOverlap = options.chunkOverlap || this.defaultChunkOverlap;

    // Split into chunks
    const chunks = this.chunkText(text, chunkSize, chunkOverlap);

    // Extract entities from each chunk
    let totalEntities = 0;
    let totalRelationships = 0;

    for (let i = 0; i < chunks.length; i++) {
      const chunkId = `${sourceId}-chunk-${i}`;

      if (!options.skipExtraction) {
        // Extract entities and relationships
        const result = await this.extractor.extract(chunks[i]);

        if (result.success && result.data) {
          // Consolidate entities
          const consolidated = await this.consolidator.consolidate(result.data.entities);

          // Store entities and relationships
          await this.storeExtraction(
            chunkId,
            sourceId,
            result.data,
            consolidated
          );

          totalEntities += result.data.entities.length;
          totalRelationships += result.data.relationships.length;
        }

        // Update extraction progress
        await this.updateExtractionProgress(chunkId, 'done');
      }

      // Store chunk
      await this.storeChunk(chunkId, sourceId, chunks[i], i);
    }

    return {
      chunksProcessed: chunks.length,
      entitiesExtracted: totalEntities,
      relationshipsExtracted: totalRelationships,
    };
  }

  /**
   * Chunk text by size with overlap.
   */
  private chunkText(text: string, size: number, overlap: number): string[] {
    const chunks: string[] = [];
    let position = 0;

    while (position < text.length) {
      const end = Math.min(position + size, text.length);

      // Try to break at sentence boundary
      let breakPoint = end;
      if (end < text.length) {
        const lastPeriod = text.lastIndexOf('.', end);
        const lastNewline = text.lastIndexOf('\n', end);
        breakPoint = Math.max(lastPeriod, lastNewline, position + size / 2);
      }

      chunks.push(text.slice(position, breakPoint).trim());
      position = breakPoint - overlap;
    }

    return chunks;
  }

  /**
   * Parse content based on MIME type.
   */
  private async parseContent(content: string, mimeType: string): Promise<{ text: string; metadata?: any }> {
    switch (mimeType) {
      case 'application/pdf':
        return parsePDF(content);
      case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
        return parseDOCX(content);
      case 'text/html':
        return parseHTML(content);
      case 'text/markdown':
        return parseMarkdown(content);
      case 'text/plain':
      default:
        return parseText(content);
    }
  }

  /**
   * Detect MIME type from file extension.
   */
  private detectMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();

    const mimeTypes: Record<string, string> = {
      '.pdf': 'application/pdf',
      '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      '.doc': 'application/msword',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.md': 'text/markdown',
      '.markdown': 'text/markdown',
      '.txt': 'text/plain',
      '.json': 'application/json',
    };

    return mimeTypes[ext] || 'text/plain';
  }

  /**
   * Generate unique source ID.
   */
  private generateSourceId(identifier: string, source: IngestionSource): string {
    const hash = createHash('sha256')
      .update(identifier)
      .update(source)
      .digest('hex')
      .slice(0, 16);

    return `${source}-${hash}`;
  }

  /**
   * Create source record in database.
   */
  private async createSourceRecord(
    sourceId: string,
    data: {
      type: string;
      path?: string;
      url?: string;
      title?: string;
      mimeType?: string;
      crawlId?: string;
      tags: string[];
      metadata: Record<string, any>;
    }
  ): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO kg_sources (id, type, path, url, title, mime_type, crawl_id, tags, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        sourceId,
        data.type,
        data.path,
        data.url,
        data.title,
        data.mimeType,
        data.crawlId,
        JSON.stringify(data.tags),
        JSON.stringify(data.metadata),
        Date.now(),
      ]
    );
  }

  /**
   * Store chunk in database.
   */
  private async storeChunk(
    chunkId: string,
    sourceId: string,
    text: string,
    index: number
  ): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO kg_chunks (id, source_id, content, chunk_index, created_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [chunkId, sourceId, text, index, Date.now()]
    );
  }

  /**
   * Store extraction results.
   */
  private async storeExtraction(
    chunkId: string,
    sourceId: string,
    extraction: EntityExtraction,
    consolidation: Awaited<ReturnType<EntityConsolidator['consolidate']>>
  ): Promise<void> {
    // Store entities (using canonical IDs from consolidation)
    for (const entity of extraction.entities) {
      const canonicalId = consolidation.canonicalIds.get(entity.id) || entity.id;

      await this.datastore.execute(
        `INSERT INTO kg_entities (id, name, name_hash, type, description, first_seen, last_seen, source_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT(id) DO UPDATE SET
           last_seen = $7,
           source_count = source_count + 1`,
        [
          canonicalId,
          entity.name,
          this.hashName(entity.name),
          entity.type,
          entity.description,
          Date.now(),
          Date.now(),
          1,
        ]
      );

      // Link entity to source
      await this.datastore.execute(
        `INSERT INTO kg_entity_sources (entity_id, chunk_id, source_type, confidence, created_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [canonicalId, chunkId, 'manual', 1.0, Date.now()]
      );
    }

    // Store relationships (with updated entity IDs)
    for (const rel of extraction.relationships) {
      const sourceId = consolidation.canonicalIds.get(rel.sourceId) || rel.sourceId;
      const targetId = consolidation.canonicalIds.get(rel.targetId) || rel.targetId;

      await this.datastore.execute(
        `INSERT INTO kg_relationships (id, source_id, target_id, type, description, keywords, strength, first_seen, last_seen, source_count)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT(source_id, target_id, type) DO UPDATE SET
           strength = MAX(kg_relationships.strength, $7),
           last_seen = $9`,
        [
          `${sourceId}-${targetId}-${rel.type}`,
          sourceId,
          targetId,
          rel.type,
          rel.description,
          JSON.stringify(rel.keywords),
          rel.strength,
          Date.now(),
          Date.now(),
          1,
        ]
      );
    }
  }

  /**
   * Update extraction progress.
   */
  private async updateExtractionProgress(chunkId: string, status: 'pending' | 'processing' | 'done' | 'error'): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO kg_extraction_progress (chunk_id, status, attempts, last_attempt, updated_at)
       VALUES ($1, $2, 1, $3, $4)
       ON CONFLICT(chunk_id) DO UPDATE SET
         status = $2,
         attempts = attempts + 1,
         last_attempt = $3,
         updated_at = $4`,
      [chunkId, status, Date.now(), Date.now()]
    );
  }

  /**
   * Hash entity name for Tier 1 consolidation.
   */
  private hashName(name: string): string {
    const normalized = name.toLowerCase().trim().replace(/[^\w\s]/g, '');
    return createHash('md5').update(normalized).digest('hex');
  }
}

// Required source table (add to migrations)
export const KG_SOURCES_TABLE = `
CREATE TABLE IF NOT EXISTS kg_sources (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,  -- 'file' | 'text' | 'url'
  path TEXT,
  url TEXT,
  title TEXT,
  mime_type TEXT,
  crawl_id TEXT,
  tags TEXT,  -- JSON array
  metadata TEXT,  -- JSON object
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_sources_type ON kg_sources(type);
CREATE INDEX IF NOT EXISTS idx_kg_sources_crawl_id ON kg_sources(crawl_id);
`;

export const KG_CHUNKS_TABLE = `
CREATE TABLE IF NOT EXISTS kg_chunks (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES kg_sources(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_kg_chunks_source ON kg_chunks(source_id);
`;
```

## Document Parsers

**File:** `src/knowledge/ingest/parsers/pdf.ts`

```typescript
/**
 * PDF document parser using pdfjs-dist.
 *
 * Note: pdfjs-dist is already a dependency in package.json (line 194)
 */

import * as pdfjs from 'pdfjs-dist';

export async function parsePDF(content: string | Buffer): Promise<{ text: string; metadata?: any }> {
  const data = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  const loadingTask = pdfjs.getDocument({ data: Array.from(data) });
  const pdf = await loadingTask.promise;

  let fullText = '';

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += pageText + '\n';
  }

  return { text: fullText.trim() };
}
```

**File:** `src/knowledge/ingest/parsers/docx.ts`

```typescript
/**
 * DOCX document parser using mammoth.
 */

import mammoth from 'mammoth';

export async function parseDOCX(content: string | Buffer): Promise<{ text: string; metadata?: any }> {
  const buffer = typeof content === 'string' ? Buffer.from(content, 'utf-8') : content;

  const result = await mammoth.extractRawText({ buffer });

  return { text: result.value };
}
```

**File:** `src/knowledge/ingest/parsers/html.ts`

```typescript
/**
 * HTML document parser using Readability.
 *
 * Extracts main article content, stripping navigation, ads, etc.
 */

import { Readability } from '@mozilla/readability';
import { DOMParser } from 'linkedom';

export async function parseHTML(content: string): Promise<{ text: string; metadata?: any }> {
  const doc = new DOMParser().parseFromString(content, 'text/html');
  const reader = new Readability(doc as any);
  const article = reader.parse();

  if (!article) {
    return { text: '' };  // No article content found
  }

  return {
    text: article.textContent,
    metadata: {
      title: article.title,
      excerpt: article.excerpt,
      length: article.length,
    },
  };
}
```

## CLI Integration

**Add to:** `src/commands/knowledge.ts`

```typescript
import { IngestionPipeline } from '../knowledge/ingest/pipeline.js';

export const knowledgeCommands = {
  async ingest(pathOrText: string, options: any) {
    const pipeline = new IngestionPipeline(/* ... */);

    // Check if path or inline text
    if (options.text) {
      const result = await pipeline.ingestText({
        source: 'manual',
        text: pathOrText,
        title: options.title,
        tags: options.tags?.split(','),
      });
      console.log('Ingested:', result);
    } else {
      const result = await pipeline.ingestFile({
        source: 'manual',
        filePath: pathOrText,
        tags: options.tags?.split(','),
      });
      console.log('Ingested:', result);
    }
  },
};
```

## Dependencies

```bash
pnpm add mammoth
# pdfjs-dist already exists
# @mozilla/readability already exists
# linkedom already exists
```

## Success Criteria

- [ ] File ingestion works for PDF, DOCX, MD, TXT
- [ ] Text ingestion works
- [ ] URL ingestion works (with crawler)
- [ ] Chunking respects overlap
- [ ] Extraction triggered after chunking
- [ ] Source tracking works
- [ ] CLI commands functional

## References

- Phase 2 Plan: `docs/plans/graphrag/ZAI-PLAN.md`
- Parser libraries: `docs/plans/graphrag/ZAI-EVALUATION.md` Part 3

## Next Task

Proceed to `02-web-crawler.md` to implement the web crawler.
