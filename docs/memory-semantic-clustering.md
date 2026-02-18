# Semantic Clustering for Memory Search

## Overview

OpenClaw's memory search now supports **semantic clustering** to improve search result quality by grouping similar memories before diversity re-ranking.

This feature combines two powerful techniques:
1. **DBSCAN Clustering** - Groups semantically similar results using embedding vectors
2. **Enhanced MMR** - Uses cosine similarity on embeddings for better semantic diversity

## Why This Matters

### Before
- MMR used Jaccard similarity (bag-of-words matching)
- Couldn't detect semantic duplicates with different wording
- Example: "dog" and "canine" were treated as completely different

### After
- MMR can use cosine similarity on embeddings
- Detects semantic similarity regardless of wording
- Clustering pre-groups near-duplicates
- Better diversity in final results

## Configuration

### Global Config

Add to your `openclaw.json`:

```json
{
  "memory": {
    "clustering": {
      "enabled": true,
      "epsilon": 0.15,
      "minPoints": 2
    },
    "mmr": {
      "enabled": true,
      "lambda": 0.7,
      "useEmbeddingSimilarity": true
    }
  }
}
```

### Per-Agent Config

```json
{
  "agents": {
    "list": [
      {
        "id": "research-agent",
        "memory": {
          "clustering": {
            "enabled": true,
            "epsilon": 0.1
          },
          "mmr": {
            "enabled": true,
            "useEmbeddingSimilarity": true
          }
        }
      }
    ]
  }
}
```

## Configuration Options

### Clustering

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable semantic clustering |
| `epsilon` | `0.15` | Maximum distance for same cluster (0-2 range) |
| `minPoints` | `2` | Minimum points to form a cluster |

**Epsilon Guidelines:**
- `0.05-0.10`: Very strict, only near-duplicates cluster
- `0.15-0.20`: Moderate, groups closely related content
- `0.25-0.30`: Loose, groups broader topics
- Lower = fewer, tighter clusters
- Higher = more, looser clusters

### MMR (Maximal Marginal Relevance)

| Option | Default | Description |
|--------|---------|-------------|
| `enabled` | `false` | Enable MMR re-ranking |
| `lambda` | `0.7` | Balance relevance vs diversity (0-1) |
| `useEmbeddingSimilarity` | `true` | Use embeddings if available |

**Lambda Guidelines:**
- `0.0`: Maximum diversity (ignores relevance)
- `0.5`: Equal balance
- `0.7`: Favor relevance, some diversity (recommended)
- `0.9`: Mostly relevance, minimal diversity
- `1.0`: Pure relevance (no diversity penalty)

## How It Works

### Pipeline Flow

```
User Query
  ↓
Vector Search (embeddings) + Keyword Search (FTS)
  ↓
Merge & Score Results
  ↓
Temporal Decay (boost recent)
  ↓
✨ Semantic Clustering (if enabled)
   - Groups similar results
   - Selects best from each cluster
  ↓
✨ Enhanced MMR (if enabled)
   - Uses cosine similarity on embeddings
   - Or falls back to Jaccard on text
   - Iteratively selects diverse results
  ↓
Final Results (diverse & relevant)
```

### DBSCAN Clustering

**Algorithm**: Density-Based Spatial Clustering of Applications with Noise

**Benefits:**
- No need to pre-specify number of clusters
- Handles outliers/noise naturally (cluster ID = -1)
- Works well with high-dimensional embeddings
- Efficient for memory search result sets (typically <100 items)

**How it works:**
1. For each result, find neighbors within `epsilon` distance
2. If a result has ≥ `minPoints` neighbors, start a cluster
3. Recursively add neighbors to cluster
4. Items that don't fit any cluster are marked as noise

### Enhanced MMR

**Original**: MMR = λ × relevance - (1-λ) × max_text_similarity

**Enhanced**: MMR = λ × relevance - (1-λ) × max_embedding_similarity

**Improvement:**
- **Text**: "The dog barked" vs "The canine howled" → Low similarity (no token overlap)
- **Embeddings**: Same texts → High similarity (semantic match)

## Usage Examples

### Example 1: Enable Both Features

```json
{
  "memory": {
    "clustering": { "enabled": true },
    "mmr": { "enabled": true, "useEmbeddingSimilarity": true }
  }
}
```

**Result**: Best diversity - clusters remove near-duplicates, MMR ensures final results span different topics.

### Example 2: Clustering Only

```json
{
  "memory": {
    "clustering": { "enabled": true },
    "mmr": { "enabled": false }
  }
}
```

**Result**: Removes duplicates but keeps results score-ordered.

### Example 3: Enhanced MMR Only

```json
{
  "memory": {
    "clustering": { "enabled": false },
    "mmr": { "enabled": true, "useEmbeddingSimilarity": true }
  }
}
```

**Result**: Better semantic diversity than text-only MMR, but may include some near-duplicates.

### Example 4: Text-Only MMR (Backward Compatible)

```json
{
  "memory": {
    "mmr": { "enabled": true, "useEmbeddingSimilarity": false }
  }
}
```

**Result**: Original MMR behavior using Jaccard similarity.

## Performance Considerations

### When to Enable

**Enable Clustering If:**
- You have many similar documents in memory
- Search often returns near-duplicate results
- You want to reduce redundancy in results
- Memory size: 100+ documents

**Enable Enhanced MMR If:**
- Embeddings are available
- You want semantically diverse results
- Search results cluster around few topics
- You're okay with slightly lower top-1 relevance

### Performance Impact

| Feature | Time Complexity | Memory | Notes |
|---------|----------------|--------|-------|
| Clustering | O(n²) worst case | O(n) | Fast for n<100 |
| Enhanced MMR | O(n²) | O(n) | Same as original MMR |
| Combined | O(n²) | O(n) | Clustering reduces n for MMR |

**Typical Impact:** <50ms added latency for 50 search results.

## Debugging

### Check Cluster Stats

The clustering system logs stats when enabled:

```
[memory/clustering] Formed 5 clusters (3 real, 2 noise) from 23 results
[memory/clustering] Average cluster size: 4.3, largest: 8
```

### Verify Embedding Usage

```
[memory/mmr] Using embedding-based similarity (cosine)
```

Or:

```
[memory/mmr] Falling back to text-based similarity (Jaccard)
```

### Tuning Epsilon

If you see:
- **Too many small clusters**: Increase epsilon
- **Everything in noise cluster**: Decrease minPoints or increase epsilon
- **Clusters too broad**: Decrease epsilon

## Limitations

1. **Requires Embeddings**: Clustering only works with embedding vectors (from vector search)
2. **Small Result Sets**: Not beneficial for <10 results
3. **Cold Start**: No improvement without indexed memories
4. **Computational Cost**: O(n²) clustering may be slow for >200 results (rare)

## Related Configuration

- [Memory Backend](./memory-backend.md) - Choose between SQLite and QMD
- [Temporal Decay](./temporal-decay.md) - Boost recent memories
- [Query Expansion](./query-expansion.md) - Improve FTS queries

## Implementation Details

**Files:**
- `src/memory/semantic-clustering.ts` - DBSCAN implementation
- `src/memory/mmr.ts` - Enhanced MMR with embeddings
- `src/memory/hybrid.ts` - Pipeline integration

**Tests:**
- `src/memory/semantic-clustering.test.ts`
- `src/memory/mmr-embeddings.test.ts`

## Contributors

- Feature implemented by: *[@YourGitHubUsername](https://github.com/YourGitHubUsername)*
- Based on research: Ester et al. (DBSCAN), Carbonell & Goldstein (MMR)

