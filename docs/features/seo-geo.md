---
summary: "SEO and GEO (Generative Engine Optimization) for content optimization"
title: SEO/GEO Optimization
read_when: "You want to optimize content for search engines and AI search engines"
status: active
---

# SEO/GEO Optimization

SEO/GEO tools optimize content for traditional search engines (SEO) and AI search engines (GEO).

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
    },
  },
}
```

## See Also

- [Content Ranking documentation](/features/content-ranking)
- [News Aggregator documentation](/features/news-aggregator)
