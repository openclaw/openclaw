# Phase 2, Task 02: Web Crawler

**Phase:** 2 - Manual Ingestion + Web Crawler
**Task:** Implement multi-mode web crawler with auth support
**Duration:** 2 days
**Complexity:** High
**Depends on:** Task 01 (Ingestion Pipeline)

---

## Task Overview

Implement a web crawler that supports:
- Single page fetching
- Sitemap-based discovery
- Recursive BFS crawling
- Authentication (Bearer tokens, basic auth)
- JavaScript rendering (opt-in via Playwright)
- Robots.txt respect

## Architecture Decision

**Reference:** Phase 2 in `docs/plans/graphrag/ZAI-PLAN.md`

## File Structure

```
src/knowledge/crawler/
├── crawler.ts             # Main crawler orchestrator
├── discovery.ts           # URL discovery (sitemap, BFS)
├── fetcher.ts             # HTTP fetching with rate limiting
├── auth.ts                # Authentication handlers
└── crawler.test.ts
```

## Core Types

```typescript
/**
 * Web crawler types.
 */

export type CrawlMode = 'single' | 'sitemap' | 'recursive';

export type CrawlAuth =
  | { type: 'bearer'; token: string }
  | { type: 'basic'; username: string; password: string }
  | { type: 'custom'; headers: Record<string, string> };

export interface CrawlTarget {
  url: string;
  mode: CrawlMode;
  auth?: CrawlAuth;
  jsRender?: boolean;  // Opt-in Playwright rendering
  maxPages?: number;
  maxDepth?: number;
  sameDomain?: boolean;  // Only crawl same domain
  allowedPatterns?: RegExp[];  // URL patterns to allow
  blockedPatterns?: RegExp[];  // URL patterns to block
}

export interface CrawlResult {
  crawlId: string;
  status: 'completed' | 'partial' | 'failed';
  totalPages: number;
  successfulPages: number;
  failedPages: number;
  duration: number;
  errors: string[];
}

export interface CrawlConfig {
  requestsPerSecond: number;
  timeout: number;
  userAgent: string;
  respectRobotsTxt: boolean;
  maxRetries: number;
  retryBackoffMs: number;
}
```

## Main Crawler

**File:** `src/knowledge/crawler/crawler.ts`

```typescript
/**
 * Web crawler with multi-mode support.
 *
 * Modes:
 * - single: Fetch a single page
 * - sitemap: Discover URLs from sitemap.xml
 * - recursive: BFS crawl with depth limit
 *
 * Features:
 * - Authentication (Bearer, Basic, custom headers)
 * - JavaScript rendering (opt-in via Playwright)
 * - Robots.txt respect
 * - Rate limiting
 *
 * Reference: docs/plans/graphrag/ZAI-PLAN.md Phase 2
 */

import pLimit from 'p-limit';
import { CrawlURLDiscovery } from './discovery.js';
import { CrawlFetcher } from './fetcher.js';
import type { RelationalDatastore } from '../datastore/interface.js';
import type { IngestionPipeline } from '../ingest/pipeline.js';
import type { CrawlTarget, CrawlResult, CrawlConfig, CrawlMode } from './types.js';

export class WebCrawler {
  private datastore: RelationalDatastore;
  private ingestion: IngestionPipeline;
  private config: CrawlConfig;
  private discovery: CrawlURLDiscovery;
  private fetcher: CrawlFetcher;
  private concurrencyLimit: pLimit.Limit;

  constructor(
    datastore: RelationalDatastore,
    ingestion: IngestionPipeline,
    config: Partial<CrawlConfig> = {}
  ) {
    this.datastore = datastore;
    this.ingestion = ingestion;
    this.config = {
      requestsPerSecond: 2,
      timeout: 30000,
      userAgent: 'Clawdbot-Knowledge-Crawler/1.0',
      respectRobotsTxt: true,
      maxRetries: 3,
      retryBackoffMs: 1000,
      ...config,
    };

    this.discovery = new CrawlURLDiscovery(this.config);
    this.fetcher = new CrawlFetcher(this.config);
    this.concurrencyLimit = pLimit(5);  // Max 5 concurrent requests
  }

  /**
   * Start a crawl job.
   */
  async crawl(target: CrawlTarget): Promise<CrawlResult> {
    const crawlId = this.generateCrawlId(target.url);
    const startTime = Date.now();

    // Initialize crawl record
    await this.initializeCrawl(crawlId, target);

    try {
      // Discover URLs based on mode
      const urls = await this.discoverURLs(target);

      // Limit URLs
      const limitedUrls = urls.slice(0, target.maxPages || 100);

      // Crawl URLs with concurrency limit
      const results = await Promise.allSettled(
        limitedUrls.map(url =>
          this.concurrencyLimit(() => this.crawlPage(url, target, crawlId))
        )
      );

      // Count results
      let successful = 0;
      let failed = 0;
      const errors: string[] = [];

      for (const result of results) {
        if (result.status === 'fulfilled') {
          if (result.value.success) successful++;
          else {
            failed++;
            if (result.value.error) errors.push(result.value.error);
          }
        } else {
          failed++;
          errors.push(result.reason?.message || 'Unknown error');
        }
      }

      // Update crawl record
      await this.completeCrawl(crawlId, {
        totalPages: limitedUrls.length,
        successfulPages: successful,
        failedPages: failed,
        status: failed === 0 ? 'completed' : 'partial',
      });

      return {
        crawlId,
        status: failed === 0 ? 'completed' : 'partial',
        totalPages: limitedUrls.length,
        successfulPages: successful,
        failedPages: failed,
        duration: Date.now() - startTime,
        errors,
      };
    } catch (error) {
      await this.completeCrawl(crawlId, {
        totalPages: 0,
        successfulPages: 0,
        failedPages: 0,
        status: 'failed',
      });

      return {
        crawlId,
        status: 'failed',
        totalPages: 0,
        successfulPages: 0,
        failedPages: 0,
        duration: Date.now() - startTime,
        errors: [(error as Error).message],
      };
    }
  }

  /**
   * Get crawl status.
   */
  async getCrawlStatus(crawlId: string): Promise<CrawlResult | null> {
    const result = await this.datastore.queryOne<any>(
      `SELECT * FROM kg_crawls WHERE id = $1`,
      [crawlId]
    );

    if (!result) return null;

    return {
      crawlId: result.id,
      status: result.status,
      totalPages: result.total_pages,
      successfulPages: result.successful_pages,
      failedPages: result.failed_pages,
      duration: result.duration || 0,
      errors: result.errors ? JSON.parse(result.errors) : [],
    };
  }

  // ------------------------------------------------------------------------
  // PRIVATE
  // ------------------------------------------------------------------------

  /**
   * Discover URLs based on crawl mode.
   */
  private async discoverURLs(target: CrawlTarget): Promise<string[]> {
    switch (target.mode) {
      case 'single':
        return [target.url];

      case 'sitemap':
        return this.discovery.fromSitemap(target.url, {
          auth: target.auth,
          sameDomain: target.sameDomain,
        });

      case 'recursive':
        return this.discovery.fromBFS(target.url, {
          auth: target.auth,
          maxDepth: target.maxDepth || 2,
          sameDomain: target.sameDomain ?? true,
          allowedPatterns: target.allowedPatterns,
          blockedPatterns: target.blockedPatterns,
        });

      default:
        return [target.url];
    }
  }

  /**
   * Crawl a single page.
   */
  private async crawlPage(
    url: string,
    target: CrawlTarget,
    crawlId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Fetch page content
      const content = await this.fetcher.fetch(url, {
        auth: target.auth,
        jsRender: target.jsRender,
      });

      // Ingest content
      await this.ingestion.ingestURL(
        {
          source: 'crawl',
          url,
          crawlId,
          skipExtraction: false,
        },
        content
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: `${url}: ${(error as Error).message}`,
      };
    }
  }

  /**
   * Generate unique crawl ID.
   */
  private generateCrawlId(url: string): string {
    const hash = createHash('sha256')
      .update(url)
      .update(Date.now().toString())
      .digest('hex')
      .slice(0, 16);

    return `crawl-${hash}`;
  }

  /**
   * Initialize crawl record in database.
   */
  private async initializeCrawl(crawlId: string, target: CrawlTarget): Promise<void> {
    await this.datastore.execute(
      `INSERT INTO kg_crawls (id, url, mode, config, status, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        crawlId,
        target.url,
        target.mode,
        JSON.stringify(target),
        'running',
        Date.now(),
      ]
    );
  }

  /**
   * Mark crawl as complete.
   */
  private async completeCrawl(
    crawlId: string,
    results: {
      totalPages: number;
      successfulPages: number;
      failedPages: number;
      status: 'completed' | 'partial' | 'failed';
    }
  ): Promise<void> {
    await this.datastore.execute(
      `UPDATE kg_crawls
       SET total_pages = $2,
           successful_pages = $3,
           failed_pages = $4,
           status = $5,
           duration = $6 - created_at,
           completed_at = $6
       WHERE id = $1`,
      [
        crawlId,
        results.totalPages,
        results.successfulPages,
        results.failedPages,
        results.status,
        Date.now(),
      ]
    );
  }
}

// Required crawl table
export const KG_CRAWLS_TABLE = `
CREATE TABLE IF NOT EXISTS kg_crawls (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  mode TEXT NOT NULL,
  config TEXT,  -- JSON: CrawlTarget
  status TEXT NOT NULL,  -- 'running' | 'completed' | 'partial' | 'failed'
  total_pages INTEGER DEFAULT 0,
  successful_pages INTEGER DEFAULT 0,
  failed_pages INTEGER DEFAULT 0,
  errors TEXT,  -- JSON array
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  completed_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_kg_crawls_status ON kg_crawls(status);
CREATE INDEX IF NOT EXISTS idx_kg_crawls_created_at ON kg_crawls(created_at);
`;
```

## URL Discovery

**File:** `src/knowledge/crawler/discovery.ts`

```typescript
/**
 * URL discovery for web crawler.
 *
 * Supports:
 * - Sitemap parsing
 * - BFS link discovery
 * - Robots.txt filtering
 */

import { URL } from 'url';
import robotstxt from 'robotstxt';
import type { CrawlConfig, CrawlAuth, CrawlMode } from './types.js';

export interface DiscoveryOptions {
  auth?: CrawlAuth;
  maxDepth?: number;
  sameDomain?: boolean;
  allowedPatterns?: RegExp[];
  blockedPatterns?: RegExp[];
}

export class CrawlURLDiscovery {
  private robotsCache = new Map<string, any>();

  constructor(private config: CrawlConfig) {}

  /**
   * Discover URLs from sitemap.xml.
   */
  async fromSitemap(startUrl: string, options: DiscoveryOptions = {}): Promise<string[]> {
    const baseUrl = new URL(startUrl);
    const sitemapUrl = `${baseUrl.origin}/sitemap.xml`;

    try {
      const response = await this.fetch(sitemapUrl, options.auth);
      const sitemap = response.text();

      // Parse sitemap XML
      const urls: string[] = [];
      const urlMatch = /<loc>(.*?)<\/loc>/g;
      let match;

      while ((match = urlMatch.exec(sitemap)) !== null) {
        urls.push(match[1]);
      }

      return this.filterUrls(urls, baseUrl, options);
    } catch {
      // No sitemap found, return single URL
      return [startUrl];
    }
  }

  /**
   * Discover URLs via BFS crawling.
   */
  async fromBFS(startUrl: string, options: DiscoveryOptions = {}): Promise<string[]> {
    const maxDepth = options.maxDepth || 2;
    const baseUrl = new URL(startUrl);
    const visited = new Set<string>();
    const queue: Array<{ url: string; depth: number }> = [
      { url: startUrl, depth: 0 },
    ];
    const urls: string[] = [];

    while (queue.length > 0) {
      const { url, depth } = queue.shift()!;

      if (depth > maxDepth) continue;
      if (visited.has(url)) continue;

      visited.add(url);
      urls.push(url);

      // Fetch page and extract links
      try {
        const response = await this.fetch(url, options.auth);
        const links = this.extractLinks(response.text(), url);

        for (const link of links) {
          if (!visited.has(link)) {
            queue.push({ url: link, depth: depth + 1 });
          }
        }
      } catch {
        // Skip pages that fail to load
      }
    }

    return this.filterUrls(urls, baseUrl, options);
  }

  /**
   * Extract links from HTML content.
   */
  private extractLinks(html: string, baseUrl: string): string[] {
    const links: string[] = [];
    const base = new URL(baseUrl);
    const hrefMatch = /href=["']([^"']+)["']/gi;
    let match;

    while ((match = hrefMatch.exec(html)) !== null) {
      try {
        const href = match[1];
        const url = new URL(href, base);
        links.push(url.href);
      } catch {
        // Skip invalid URLs
      }
    }

    return links;
  }

  /**
   * Filter URLs based on options and robots.txt.
   */
  private async filterUrls(
    urls: string[],
    baseUrl: URL,
    options: DiscoveryOptions
  ): Promise<string[]> {
    let filtered = urls;

    // Same domain filter
    if (options.sameDomain) {
      filtered = filtered.filter(url => {
        const u = new URL(url);
        return u.origin === baseUrl.origin;
      });
    }

    // Allowed patterns
    if (options.allowedPatterns && options.allowedPatterns.length > 0) {
      filtered = filtered.filter(url =>
        options.allowedPatterns!.some(pattern => pattern.test(url))
      );
    }

    // Blocked patterns
    if (options.blockedPatterns && options.blockedPatterns.length > 0) {
      filtered = filtered.filter(url =>
        !options.blockedPatterns!.some(pattern => pattern.test(url))
      );
    }

    // Robots.txt filtering
    if (this.config.respectRobotsTxt) {
      const robots = await this.getRobotsTxt(baseUrl.origin);
      if (robots) {
        filtered = filtered.filter(url => robots.isAllowed(url));
      }
    }

    return Array.from(new Set(filtered));  // Deduplicate
  }

  /**
   * Get robots.txt for origin.
   */
  private async getRobotsTxt(origin: string): Promise<any> {
    if (this.robotsCache.has(origin)) {
      return this.robotsCache.get(origin);
    }

    try {
      const robotsUrl = `${origin}/robots.txt`;
      const response = await fetch(robotsUrl, {
        headers: { 'User-Agent': this.config.userAgent },
      });
      const robotsTxt = await response.text();

      const robots = robotstxt.parse(robotsUrl, robotsTxt);
      this.robotsCache.set(origin, robots);
      return robots;
    } catch {
      // No robots.txt, allow all
      return null;
    }
  }

  /**
   * Fetch URL with optional auth.
   */
  private async fetch(url: string, auth?: CrawlAuth): Promise<{ text: () => string }> {
    const headers: Record<string, string> = {
      'User-Agent': this.config.userAgent,
    };

    if (auth) {
      switch (auth.type) {
        case 'bearer':
          headers['Authorization'] = `Bearer ${auth.token}`;
          break;
        case 'basic':
          headers['Authorization'] = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
          break;
        case 'custom':
          Object.assign(headers, auth.headers);
          break;
      }
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return {
      text: () => response.text(),
    };
  }
}
```

## HTTP Fetcher

**File:** `src/knowledge/crawler/fetcher.ts`

```typescript
/**
 * HTTP fetcher with rate limiting and retry logic.
 */

import pRetry from 'p-retry';
import type { CrawlConfig, CrawlAuth } from './types.js';

export interface FetchOptions {
  auth?: CrawlAuth;
  jsRender?: boolean;
}

export class CrawlFetcher {
  private rateLimiter: Map<string, number[]> = new Map();

  constructor(private config: CrawlConfig) {}

  /**
   * Fetch URL with rate limiting and retry.
   */
  async fetch(url: string, options: FetchOptions = {}): Promise<string> {
    // Rate limiting
    await this.rateLimit(url);

    // Retry logic
    return pRetry(
      async () => {
        if (options.jsRender) {
          return this.fetchWithPlaywright(url, options);
        } else {
          return this.fetchHTTP(url, options);
        }
      },
      {
        retries: this.config.maxRetries,
        onFailedAttempt: error => {
          console.log(`Fetch attempt ${error.attemptNumber} failed for ${url}`);
        },
      }
    );
  }

  /**
   * Standard HTTP fetch.
   */
  private async fetchHTTP(url: string, options: FetchOptions): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': this.config.userAgent,
    };

    if (options.auth) {
      switch (options.auth.type) {
        case 'bearer':
          headers['Authorization'] = `Bearer ${options.auth.token}`;
          break;
        case 'basic':
          headers['Authorization'] = `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`;
          break;
        case 'custom':
          Object.assign(headers, options.auth.headers);
          break;
      }
    }

    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(this.config.timeout),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    return response.text();
  }

  /**
   * Fetch with JavaScript rendering (Playwright).
   */
  private async fetchWithPlaywright(url: string, options: FetchOptions): Promise<string> {
    const { chromium } = await import('playwright');

    const browser = await chromium.launch();
    const page = await browser.newPage();

    // Set auth headers
    if (options.auth) {
      switch (options.auth.type) {
        case 'bearer':
          await page.setExtraHTTPHeaders({
            'Authorization': `Bearer ${options.auth.token}`,
          });
          break;
        case 'basic':
          await page.setExtraHTTPHeaders({
            'Authorization': `Basic ${Buffer.from(`${options.auth.username}:${options.auth.password}`).toString('base64')}`,
          });
          break;
        case 'custom':
          await page.setExtraHTTPHeaders(options.auth.headers);
          break;
      }
    }

    await page.goto(url, {
      waitUntil: 'networkidle',
      timeout: this.config.timeout,
    });

    const content = await page.content();
    await browser.close();

    return content;
  }

  /**
   * Rate limiting per origin.
   */
  private async rateLimit(url: string): Promise<void> {
    const origin = new URL(url).origin;
    const now = Date.now();
    const requests = this.rateLimiter.get(origin) || [];

    // Remove old requests (outside 1-second window)
    const recent = requests.filter(t => now - t < 1000);

    // Check if we've exceeded the rate limit
    if (recent.length >= this.config.requestsPerSecond) {
      const oldestRequest = recent[0];
      const waitTime = 1000 - (now - oldestRequest);
      if (waitTime > 0) {
        await new Promise(resolve => setTimeout(resolve, waitTime));
      }
    }

    // Record this request
    recent.push(now);
    this.rateLimiter.set(origin, recent);
  }
}
```

## Dependencies

```bash
pnpm add p-retry p-limit robotstxt
# Playwright already exists as dev dependency
```

## CLI Commands

```bash
# Single page
clawdbot knowledge crawl https://example.com --mode single

# Sitemap
clawdbot knowledge crawl https://example.com --mode sitemap --max-pages 100

# Recursive
clawdbot knowledge crawl https://example.com/docs --mode recursive --max-depth 2

# With auth
clawdbot knowledge crawl https://api.example.com --auth bearer:TOKEN

# With JS rendering
clawdbot knowledge crawl https://example.com --js-render
```

## Success Criteria

- [ ] Single page mode works
- [ ] Sitemap discovery works
- [ ] Recursive BFS crawling works
- [ ] Authentication (Bearer, Basic) works
- [ ] JS rendering (Playwright) works
- [ ] Robots.txt respected
- [ ] Rate limiting works
- [ ] CLI commands functional

## References

- Crawler Design: `docs/plans/graphrag/ZAI-PLAN.md` Phase 2
- Auth Support: `docs/plans/graphrag/ZAI-EVALUATION.md` Issue 2

## Next Tasks

Proceed to Phase 3: `docs/phases/03-retrieval-tools/01-graph-retrieval.md`
