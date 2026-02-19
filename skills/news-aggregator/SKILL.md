---
name: news-aggregator
description: "Aggregate news articles from RSS feeds, extract content, and manage news sources. Use for building news aggregation systems, content pipelines, and automated news monitoring."
metadata:
  {
    "openclaw":
      {
        "emoji": "📰",
        "requires": { "config": { "content.newsAggregator.enabled": true } },
      },
  }
---

# News Aggregator Skill

Use the news aggregator to collect articles from RSS feeds, extract full content, and manage news sources for content pipelines and automated monitoring.

## When to Use

✅ **USE this skill when:**

- Building news aggregation systems
- Monitoring multiple news sources
- Creating content pipelines
- Extracting article content from URLs
- Building automated news monitoring

❌ **DON'T use this skill when:**

- One-off article fetching (use `web_fetch` directly)
- Non-RSS content sources (use `web_search` or `web_fetch`)
- Real-time news (RSS has inherent delay)

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
          fetchInterval: 30, // minutes
        },
        {
          id: "techcrunch",
          name: "TechCrunch",
          url: "https://techcrunch.com/feed/",
          type: "rss",
          enabled: true,
        },
      ],
      fetchInterval: 60, // minutes
      storagePath: "~/.openclaw/news",
      maxArticlesPerSource: 100,
    },
  },
}
```

## Usage Examples

### Start Aggregation

```typescript
// Start fetching from all enabled sources
news_aggregate({ action: "start" });
```

### Check Status

```typescript
// Get aggregation status
const status = await news_status();
// Returns: { running, lastRun, nextRun, articlesFetched, errors }
```

### Fetch Latest Articles

```typescript
// Fetch articles from all sources
const articles = await news_fetch({ sourceId: "hackernews" });
// Returns array of NewsArticle objects
```

### Manage Sources

```typescript
// Add a new source
news_sources({
  action: "add",
  source: {
    id: "arstechnica",
    name: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    type: "rss",
    enabled: true,
  },
});

// Remove a source
news_sources({ action: "remove", sourceId: "old-source" });

// List sources
const sources = await news_sources({ action: "list" });
```

## Article Structure

Each article includes:

- `id`: Unique article ID
- `sourceId`: Source identifier
- `title`: Article title
- `url`: Article URL
- `description`: Article description/excerpt
- `content`: Full extracted content (if enhanced)
- `publishedAt`: Publication date
- `fetchedAt`: When article was fetched
- `author`: Author name (if available)
- `categories`: Article categories/tags
- `imageUrl`: Featured image URL (if available)

## Content Extraction

The aggregator uses Readability to extract main content from articles:

- Removes ads, navigation, and boilerplate
- Extracts clean article text
- Preserves article structure
- Handles various website layouts

## Integration with Other Features

- **Content Ranking**: Use `content_ranking` to rank articles by importance
- **Semantic Clustering**: Use `content_cluster` to group related articles
- **SEO/GEO**: Use `seo_crosslink` to generate cross-links between articles
- **Society of Minds**: Use `society_of_minds` to analyze articles with multiple models

## Best Practices

1. **Source Selection**: Choose reliable RSS feeds with consistent formatting
2. **Fetch Intervals**: Balance freshness with API rate limits
3. **Content Enhancement**: Extract full content for better analysis
4. **Storage**: Use `storagePath` to persist articles for analysis
5. **Error Handling**: Monitor `status.errors` for source issues

## Limitations

- RSS feeds have inherent delay (not real-time)
- Some sources may not have RSS feeds
- Content extraction quality varies by website
- Requires web_fetch tool for content extraction

## See Also

- `web_fetch` - Fetch individual URLs
- `web_search` - Search for news articles
- Content ranking and clustering skills
- SEO/GEO optimization skills
