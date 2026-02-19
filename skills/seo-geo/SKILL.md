---
name: seo-geo
description: "SEO and GEO (Generative Engine Optimization) tools for content optimization. Generate cross-links, track rankings in AI search engines, and get optimization suggestions."
metadata:
  {
    "openclaw":
      {
        "emoji": "🔍",
        "requires": { "config": { "content.seoGeo.enabled": true } },
      },
  }
---

# SEO/GEO Skill

Optimize content for traditional search engines (SEO) and AI search engines (GEO - Generative Engine Optimization). Generate cross-links, track rankings, and get optimization suggestions.

## When to Use

✅ **USE this skill when:**

- Building content websites
- Optimizing articles for search engines
- Tracking rankings in ChatGPT, Grok, etc.
- Generating cross-links between articles
- Getting SEO optimization suggestions

❌ **DON'T use this skill when:**

- One-off article optimization (manual editing is fine)
- Non-web content (designed for web articles)
- Real-time ranking tracking (has inherent delay)

## Configuration

Enable in `~/.openclaw/openclaw.json`:

```json5
{
  content: {
    seoGeo: {
      enabled: true,
      trackRankings: true,
      crosslinkEnabled: true,
      geoEngines: ["chatgpt", "grok", "claude", "perplexity"],
      checkInterval: 1440, // minutes (daily)
    },
  },
}
```

## Cross-Linking

Generate cross-links between related articles for better SEO:

```typescript
// Generate cross-links for all articles
const crossLinks = await seo_crosslink({
  articles: rankedArticles,
  maxLinksPerArticle: 5,
  minRelevanceScore: 0.3,
});

// Format as HTML
const htmlLinks = CrossLinker.formatAsHTML(crossLinks[0].links, "https://example.com");

// Format as Markdown
const markdownLinks = CrossLinker.formatAsMarkdown(
  crossLinks[0].links,
  articleUrlMap,
);
```

## GEO Ranking Tracking

Track how articles rank in AI search engines:

```typescript
// Check rankings for articles
const rankings = await geo_check_ranking({
  articles: topArticles,
  queries: ["AI news", "latest AI developments"],
  engines: ["chatgpt", "grok"],
});

// Generate queries automatically
const autoQueries = GEOTracker.generateQueries(article);

// Format rankings report
const report = GEOTracker.formatRankings(rankings);
```

## Optimization Suggestions

Get SEO/GEO optimization suggestions:

```typescript
// Analyze articles and get suggestions
const suggestions = await seo_optimize({
  articles: allArticles,
});

// Generate full report
const report = SEOOptimizer.generateReport(allArticles);
```

## Suggestion Types

- **crosslink**: Add cross-links to related articles
- **title**: Optimize title length (50-60 chars recommended)
- **description**: Optimize description length (120-160 chars recommended)
- **keywords**: Add categories/keywords
- **structure**: Improve article structure

## Best Practices

1. **Cross-Links**: Link to 3-5 related articles per article
2. **Title Length**: Keep titles between 50-60 characters
3. **Description**: Write compelling 120-160 character descriptions
4. **Keywords**: Use relevant categories and tags
5. **Ranking Checks**: Don't check too frequently (daily is sufficient)

## Integration

- **Content Ranking**: Use ranked articles for cross-linking
- **News Aggregator**: Optimize aggregated articles
- **Autonomous Enterprise**: Automate SEO optimization workflows

## Limitations

- Ranking checks require API access or web scraping
- Cross-link relevance is keyword-based (embeddings recommended)
- GEO tracking may be rate-limited by search engines

## See Also

- Content ranking skill
- News aggregator skill
- Autonomous enterprise skill
