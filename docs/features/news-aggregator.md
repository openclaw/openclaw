---
summary: "Aggregate news articles from RSS feeds with content extraction"
title: News Aggregator
read_when: "You want to build news aggregation systems or content pipelines"
status: active
---

# News Aggregator

The News Aggregator collects articles from RSS feeds, extracts full content using Readability, and manages news sources.

## Configuration

Enable in `~/.openclaw/openclaw.json`:

```json5
{
  content: {
    newsAggregator: {
      enabled: true,
      sources: [
        {
          id: "hackernews",
          name: "Hacker News",
          url: "https://news.ycombinator.com/rss",
          type: "rss",
          enabled: true,
        },
      ],
      fetchInterval: 60,
    },
  },
}
```

## See Also

- [Content Ranking documentation](/features/content-ranking)
- [SEO/GEO documentation](/features/seo-geo)
