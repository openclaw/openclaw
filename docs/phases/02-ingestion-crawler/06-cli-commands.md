# Phase 2, Task 06: Knowledge CLI Commands

**Phase:** 2 - Manual Ingestion + Web Crawler
**Task:** Implement CLI commands for knowledge ingestion and crawling
**Duration:** 1 day
**Complexity:** Low
**Depends on:** Task 01 (Ingestion Pipeline), Task 02 (Web Crawler)

---

## Task Overview

Implement CLI commands for knowledge graph operations:
- `clawdbot knowledge ingest` - Ingest files or text
- `clawdbot knowledge crawl` - Crawl URLs
- `clawdbot knowledge reindex` - Backfill existing data
- `clawdbot knowledge list` - List sources
- `clawdbot knowledge remove` - Remove sources

## File Structure

```
src/commands/
└── knowledge.ts           # CLI command definitions
```

## Implementation

```typescript
/**
 * Knowledge graph CLI commands.
 */

import { Command } from 'cliffy/command';
import { Flags } from 'cliffy/command';
import { Table } from 'cliffy/table';
import { IngestionPipeline } from '../knowledge/ingest/pipeline.js';
import { WebCrawler } from '../knowledge/crawler/crawler.js';

export const knowledgeCommand = new Command()
  .description('Knowledge graph operations')
  .action(() => knowledgeCommand.showHelp());

// Ingest command
export const ingestCommand = new Command()
  .description('Ingest files or text into knowledge graph')
  .arguments('<path-or-text:string>')
  .option('-t, --text', 'Treat input as inline text instead of path')
  .option('--tags <tags:string>', 'Comma-separated tags', default: '')
  .option('--agent <agentId:string>', 'Target agent ID')
  .option('--skip-extraction', 'Skip entity extraction (content only)')
  .action(async (options, pathOrText) => {
    const pipeline = new IngestionPipeline(/* deps */);

    let result;
    if (options.text) {
      result = await pipeline.ingestText({
        source: 'manual',
        text: pathOrText,
        tags: options.tags ? options.tags.split(',') : [],
        skipExtraction: options.skipExtraction,
      });
    } else {
      result = await pipeline.ingestFile({
        source: 'manual',
        filePath: pathOrText,
        tags: options.tags ? options.tags.split(',') : [],
        skipExtraction: options.skipExtraction,
      });
    }

    if (result.status === 'success') {
      console.log(`✅ Ingested ${result.chunksProcessed} chunks`);
      console.log(`   Entities: ${result.entitiesExtracted}`);
      console.log(`   Relationships: ${result.relationshipsExtracted}`);
      console.log(`   Duration: ${result.duration}ms`);
    } else {
      console.error(`❌ Ingestion failed: ${result.error}`);
      Deno.exit(1);
    }
  });

// Crawl command
export const crawlCommand = new Command()
  .description('Crawl a URL or documentation site')
  .arguments('<url:string>')
  .option('-m, --mode <mode:string>', 'Crawl mode: single, sitemap, recursive', default: 'single')
  .option('--max-pages <number:number>', 'Maximum pages to crawl', default: 100)
  .option('--max-depth <number:number>', 'Maximum crawl depth (recursive mode)', default: 2)
  .option('--auth <auth:string>', 'Authentication: bearer:TOKEN or basic:USER:PASS')
  .option('--js-render', 'Enable JavaScript rendering (Playwright)')
  .option('--tags <tags:string>', 'Comma-separated tags')
  .action(async (options, url) => {
    const crawler = new WebCrawler(/* deps */);

    // Parse auth
    let auth;
    if (options.auth) {
      const [type, ...credentials] = options.auth.split(':');
      if (type === 'bearer') {
        auth = { type: 'bearer', token: credentials.join(':') };
      } else if (type === 'basic') {
        const [username, ...passwordParts] = credentials;
        auth = { type: 'basic', username, password: passwordParts.join(':') };
      }
    }

    const result = await crawler.crawl({
      url,
      mode: options.mode,
      maxPages: options.maxPages,
      maxDepth: options.maxDepth,
      auth,
      jsRender: options.jsRender,
      sameDomain: true,
      tags: options.tags ? options.tags.split(',') : [],
    });

    console.log(`✅ Crawl ${result.crawlId} completed`);
    console.log(`   Pages: ${result.successfulPages}/${result.totalPages}`);
    console.log(`   Failed: ${result.failedPages}`);
    console.log(`   Duration: ${result.duration}ms`);

    if (result.errors.length > 0) {
      console.log('\n⚠️  Errors:');
      for (const error of result.errors.slice(0, 5)) {
        console.log(`   - ${error}`);
      }
    }
  });

// Reindex command
export const reindexCommand = new Command()
  .description('Re-index existing memory chunks into knowledge graph')
  .option('--full', 'Re-index all chunks (not just pending)')
  .option('--agent <agentId:string>', 'Target agent ID (default: current)')
  .action(async (options) => {
    const pipeline = new IngestionPipeline(/* deps */);

    console.log('Starting re-index...');

    // Get all chunks from memory
    const chunks = await datastore.query(
      'SELECT id, content FROM chunks ORDER BY id'
    );

    let processed = 0;
    for (const chunk of chunks) {
      const result = await pipeline.ingestText({
        source: 'memory',
        text: chunk.content,
        skipExtraction: false,
      });

      if (result.status === 'success') {
        processed++;
      }

      // Update progress
      await datastore.execute(
        'UPDATE kg_extraction_progress SET status = $1, updated_at = $2 WHERE chunk_id = $3',
        ['done', Date.now(), chunk.id]
      );

      // Progress bar
      if (processed % 10 === 0) {
        console.log(`Progress: ${processed}/${chunks.length}`);
      }
    }

    console.log(`✅ Re-index complete: ${processed} chunks processed`);
  });

// List command
export const listCommand = new Command()
  .description('List knowledge sources')
  .option('--source <source:string>', 'Filter by source type: memory, manual, crawl')
  .option('--limit <number:number>', 'Limit results', default: 50)
  .action(async (options) => {
    const sources = await datastore.query(
      `SELECT * FROM kg_sources
       ${options.source ? 'WHERE type = $1' : ''}
       ORDER BY created_at DESC
       LIMIT $2`,
      options.source ? [options.source, options.limit] : [options.limit]
    );

    const table = new Table()
      .head(['ID', 'Type', 'Title/URL', 'Tags', 'Created']);

    for (const source of sources) {
      const title = source.title || source.url || source.path || '-';
      const tags = source.tags ? JSON.parse(source.tags).join(', ') : '';
      const created = new Date(source.created_at * 1000).toLocaleString();

      table.push([source.id.slice(0, 8), source.type, title.slice(0, 40), tags, created]);
    }

    console.log(table.toString());
  });

// Remove command
export const removeCommand = new Command()
  .description('Remove a knowledge source and all associated data')
  .arguments('<sourceId:string>')
  .option('--confirm', 'Skip confirmation prompt')
  .action(async (options, sourceId) => {
    if (!options.confirm) {
      const confirm = prompt(`Remove source ${sourceId} and all associated data? [y/N]`);
      if (confirm?.toLowerCase() !== 'y') {
        console.log('Aborted');
        return;
      }
    }

    // Delete source (cascade will handle chunks, entity_sources, etc.)
    await datastore.execute('DELETE FROM kg_sources WHERE id = $1', [sourceId]);

    console.log(`✅ Removed source ${sourceId}`);
  });

// Register subcommands
knowledgeCommand
  .command('ingest', ingestCommand)
  .command('crawl', crawlCommand)
  .command('reindex', reindexCommand)
  .command('list', listCommand)
  .command('remove', removeCommand);

export default knowledgeCommand;
```

## Usage Examples

```bash
# Ingest a file
clawdbot knowledge ingest docs/design.pdf --tags architecture,important

# Ingest inline text
clawdbot knowledge ingest "The Auth Service handles JWT authentication" --text --tags auth

# Crawl single page
clawdbot knowledge crawl https://example.com/api/docs --mode single

# Crawl sitemap
clawdbot knowledge crawl https://example.com --mode sitemap --max-pages 100

# Crawl recursively
clawdbot knowledge crawl https://example.com/docs --mode recursive --max-depth 2

# Crawl with auth
clawdbot knowledge crawl https://api.example.com --auth bearer:TOKEN

# Re-index all memory
clawdbot knowledge reindex --full

# List sources
clawdbot knowledge list --source manual

# Remove source
clawdbot knowledge remove abc123 --confirm
```

## Dependencies

```bash
pnpm add @cliffy/command @cliffy/table
```

## Success Criteria

- [ ] All commands work end-to-end
- [ ] Error messages are clear
- [ ] Progress indicators show for long operations
- [ ] Confirmation prompts work
- [ ] Help text is complete

## References

- CLI Pattern: `src/commands/*.ts`
- Crawler Plan: `docs/plans/graphrag/ZAI-PLAN.md` Phase 2
