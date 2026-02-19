---
summary: "Rank articles by importance and cluster them by semantic similarity"
title: Content Ranking
read_when: "You want to rank and organize content by importance"
status: active
---

# Content Ranking

The Content Ranking system ranks articles by importance using multiple factors and clusters related articles together.

## Configuration

Enable in `~/.openclaw/openclaw.json`:

```json5
{
  content: {
    ranking: {
      enabled: true,
      recencyWeight: 0.3,
      authorityWeight: 0.2,
      semanticWeight: 0.3,
      engagementWeight: 0.1,
    },
  },
}
```

## See Also

- [News Aggregator documentation](/features/news-aggregator)
- [SEO/GEO documentation](/features/seo-geo)
