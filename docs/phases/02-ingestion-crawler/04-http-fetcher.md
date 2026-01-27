# Phase 2, Task 04: HTTP Fetcher with Rate Limiting

**Phase:** 2 - Manual Ingestion + Web Crawler
**Task:** Implement HTTP fetching with rate limiting and retry logic
**Duration:** 1 day
**Complexity:** Low
**Depends on:** None

---

## Task Overview

Implement HTTP fetcher with:
- Rate limiting per origin
- Retry with exponential backoff
- Authentication support (Bearer, Basic, custom headers)
- JavaScript rendering (opt-in via Playwright)

## File Structure

```
src/knowledge/crawler/
└── fetcher.ts             # HTTP fetcher implementation
```

## Implementation

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
pnpm add p-retry
```

## Success Criteria

- [ ] HTTP fetching works
- [ ] Rate limiting enforces requests per second
- [ ] Retry logic handles transient failures
- [ ] Authentication (Bearer, Basic, custom) works
- [ ] Playwright JS rendering works (opt-in)
- [ ] Tests pass

## References

- Crawler Plan: `docs/plans/graphrag/ZAI-PLAN.md` Phase 2
