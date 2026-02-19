---
name: content-ranking
description: "Rank articles by importance and cluster them by semantic similarity. Use for content curation, news prioritization, and organizing related articles."
metadata:
  {
    "openclaw":
      {
        "emoji": "📊",
        "requires": { "config": { "content.ranking.enabled": true } },
      },
  }
---

# Content Ranking Skill

Rank articles by importance using multiple factors (recency, authority, semantic relevance) and cluster related articles together.

## When to Use

✅ **USE this skill when:**

- Ranking news articles by importance
- Curating content for newsletters
- Prioritizing articles for analysis
- Grouping related articles together
- Building content recommendation systems

❌ **DON'T use this skill when:**

- Simple chronological sorting (just sort by date)
- Single-source content (no need for cross-reference scoring)
- Non-article content (designed for news articles)

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

## Ranking Factors

Articles are scored using multiple factors:

1. **Recency** (default weight: 0.3)
   - Newer articles score higher
   - Exponential decay over time
   - Configurable max age

2. **Authority** (default weight: 0.2)
   - Source reputation scoring
   - Known sources have higher authority
   - Customizable per source

3. **Semantic Relevance** (default weight: 0.3)
   - Relevance to AI/tech domain
   - Keyword matching
   - Can use embeddings for better accuracy

4. **Engagement** (default weight: 0.1)
   - Placeholder for engagement metrics
   - Would use actual views/clicks in production

5. **Cross-References** (default weight: 0.1)
   - How many other articles reference this
   - Indicates importance/trending

## Usage Examples

### Rank Articles

```typescript
// Rank articles by importance
const ranked = await content_rank({
  articles: articlesArray,
  limit: 10, // Top 10 articles
});

// Returns RankedArticle[] with scores and ranking factors
```

### Cluster Articles

```typescript
// Cluster related articles together
const clusters = await content_cluster({
  articles: rankedArticles,
  minClusterSize: 2, // Minimum articles per cluster
});

// Returns Cluster[] with grouped articles
```

### Get Top Articles

```typescript
// Get top N articles with ranking details
const topArticles = await content_top({
  articles: allArticles,
  limit: 20,
  sourceAuthorityMap: {
    hackernews: 0.9,
    techcrunch: 0.8,
  },
});
```

## Ranking Results

Each ranked article includes:

- `score`: Overall importance score (0-1)
- `rankingFactors`: Breakdown of scoring factors
  - `recency`: Recency score
  - `authority`: Authority score
  - `semantic`: Semantic relevance score
  - `engagement`: Engagement score
  - `crossReferences`: Cross-reference score

## Clustering Results

Each cluster includes:

- `id`: Unique cluster ID
- `label`: Cluster label (from top article)
- `articles`: Articles in cluster (sorted by score)
- `keywords`: Extracted keywords
- `centroid`: Embedding vector (if using embeddings)

## Best Practices

1. **Adjust Weights**: Tune weights based on your use case
2. **Source Authority**: Set authority scores for your sources
3. **Semantic Embeddings**: Use embeddings for better semantic scoring
4. **Cluster Size**: Adjust `minClusterSize` based on article volume
5. **Refresh Regularly**: Re-rank as new articles arrive

## Integration

- **News Aggregator**: Rank articles from news aggregator
- **SEO/GEO**: Use rankings for SEO optimization
- **Society of Minds**: Analyze top-ranked articles with multiple models
- **Autonomous Enterprise**: Use rankings for automated content decisions

## Limitations

- Keyword-based clustering (embeddings recommended for production)
- Engagement scoring is placeholder (needs real metrics)
- Cross-reference detection is basic (could use better NLP)

## See Also

- News aggregator skill
- SEO/GEO optimization skills
- Memory/embedding system for semantic search
