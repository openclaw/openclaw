# Phase 2, Task 03: URL Discovery (Sitemap + BFS)

**Phase:** 2 - Manual Ingestion + Web Crawler
**Task:** Implement URL discovery via sitemap parsing and BFS crawling
**Duration:** 1 day
**Complexity:** Medium
**Depends on:** None (can be done in parallel)

---

## Task Overview

Implement URL discovery mechanisms for the web crawler:
- Sitemap.xml parsing
- Recursive BFS link extraction
- Robots.txt filtering
- Same-domain enforcement

## File Structure

```
src/knowledge/crawler/
└── discovery.ts           # URL discovery logic
```

## Implementation

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
      return [startUrl];  // Fallback to single URL
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
    if (options.allowedPatterns) {
      filtered = filtered.filter(url =>
        options.allowedPatterns!.some(pattern => pattern.test(url))
      );
    }

    // Blocked patterns
    if (options.blockedPatterns) {
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

    return Array.from(new Set(filtered));
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
      return null;
    }
  }
}
```

## Dependencies

```bash
pnpm add robotstxt
```

## Success Criteria

- [ ] Sitemap parsing extracts URLs
- [ ] BFS crawling discovers links
- [ ] Robots.txt filtering works
- [ ] Same-domain filtering works
- [ ] Pattern filtering works
- [ ] Tests pass

## References

- Crawler Plan: `docs/plans/graphrag/ZAI-PLAN.md` Phase 2
