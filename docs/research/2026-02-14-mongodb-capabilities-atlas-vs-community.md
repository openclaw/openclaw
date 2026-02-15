# MongoDB Capabilities: Atlas vs Community Edition (Feb 2026)

## Research Date: 2026-02-14

## Sources: MongoDB official docs, blog posts, product announcements

---

## Executive Summary

**Major shift since Sep 2025**: MongoDB democratized Search and Vector Search to Community Edition. The CLAWMONGO_FRESH_START.md spec was written assuming Community Edition lacks native search. This is no longer true. All three deployment tiers (Atlas M10+, Atlas M0, Community) now support native `$vectorSearch`, `$search`, `$rankFusion`, and `$scoreFusion`.

---

## Feature Availability Matrix (Verified Feb 2026)

| Feature                             | Atlas M10+  | Atlas M0/Free        | Community Edition   | Min MongoDB Version               |
| ----------------------------------- | ----------- | -------------------- | ------------------- | --------------------------------- |
| `$vectorSearch`                     | GA          | GA (limited indexes) | Public Preview      | 6.0.11+ (Atlas), 8.0+ (Community) |
| `$search` (Atlas Search)            | GA          | GA (limited indexes) | Public Preview      | 6.0+ (Atlas), 8.0+ (Community)    |
| `$rankFusion`                       | GA          | GA                   | Public Preview      | 8.0+                              |
| `$scoreFusion`                      | GA          | GA                   | Public Preview      | 8.2+                              |
| Automated Embedding (Voyage AI)     | Coming Soon | Coming Soon          | Public Preview      | 8.2+                              |
| Vector Quantization (scalar/binary) | GA          | GA                   | Via mongot          | 7.0+                              |
| `mongot` engine                     | Managed     | Managed              | Self-managed (SSPL) | 8.0+                              |
| Change Streams                      | GA          | GA                   | GA                  | 3.6+                              |
| `bulkWrite` command                 | GA          | GA                   | GA                  | 8.0+                              |

---

## 1. Community Edition Native Search (Sep 2025)

**Announcement**: Sep 16-17, 2025
**Status**: Public Preview (dev/eval, not production)

- Full-text search via `$search` aggregation stage
- Vector search via `$vectorSearch` aggregation stage
- Powered by `mongot` engine (Lucene-based, now SSPL open source as of Jan 15, 2026)
- Keeps indexes in sync through Change Streams
- Supports autocomplete, semantic retrieval, hybrid search
- GitHub: https://github.com/mongodb/mongot

**Deployment**: mongot runs as a separate process alongside mongod

---

## 2. $rankFusion (MongoDB 8.0+)

**Availability**: Atlas, Enterprise, AND Community Edition
**Algorithm**: Reciprocal Rank Fusion (RRF) with sensitivity parameter = 60

### Syntax

```javascript
{
  $rankFusion: {
    input: {
      pipelines: {
        vectorPipeline: [
          { $vectorSearch: { index: "vector_index", path: "embedding", queryVector: [...], numCandidates: 200, limit: 10 } }
        ],
        textPipeline: [
          { $search: { index: "text_index", text: { query: "search terms", path: "text" } } }
        ]
      }
    },
    combination: {
      weights: {
        vectorPipeline: 0.7,
        textPipeline: 0.3
      }
    },
    scoreDetails: true
  }
}
```

### RRF Formula

For each document `d`, score = SUM over pipelines: `weight * (1 / (60 + rank_in_pipeline))`

### Allowed Input Stages

- `$match`, `$search`, `$vectorSearch`, `$sample`, `$geoNear`, `$sort`, `$skip`, `$limit`

---

## 3. $scoreFusion (MongoDB 8.2+)

**Availability**: Atlas, Enterprise, AND Community Edition
**Algorithm**: Score-based fusion with normalization

### Syntax

```javascript
{
  $scoreFusion: {
    input: {
      pipelines: {
        vectorPipeline: [
          { $vectorSearch: { index: "vector_index", path: "embedding", queryVector: [...], numCandidates: 200, limit: 10 } }
        ],
        textPipeline: [
          { $search: { index: "text_index", text: { query: "search terms", path: "text" } } }
        ]
      },
      normalization: "sigmoid"  // "none" | "sigmoid" | "minMaxScaler"
    },
    combination: {
      weights: {
        vectorPipeline: 0.7,
        textPipeline: 0.3
      },
      method: "avg"  // "avg" | "expression"
    },
    scoreDetails: true
  }
}
```

### Normalization Methods

- `none`: Raw scores
- `sigmoid`: Sigmoid normalization to 0-1
- `minMaxScaler`: Min-max scaling to 0-1

### vs $rankFusion

- $rankFusion: Position-based (RRF), simpler, less sensitive to score calibration
- $scoreFusion: Score-based, more flexible, better when score distributions are well-calibrated

---

## 4. Automated Embedding (Jan 2026)

**Announcement**: Jan 15, 2026
**Status**: Public Preview in Community Edition (Atlas coming soon)

- Uses Voyage AI models (voyage-4-large, voyage-4, voyage-4-lite, voyage-code-3)
- New `autoEmbed` field type in vectorSearch index definitions
- Automatically generates embeddings at index-time AND query-time
- Eliminates need for external embedding pipeline
- Handles vector synchronization automatically

### Index Definition with Automated Embedding

```javascript
db.collection.createSearchIndex("auto_vector_index", "vectorSearch", {
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: 1536,
      similarity: "cosine",
      autoEmbed: {
        sourceField: "text",
        model: "voyage-4-large",
      },
    },
  ],
});
```

---

## 5. Vector Quantization (GA on Atlas)

- **Scalar quantization**: int8, ~3.75x RAM reduction, 90-95% accuracy retained
- **Binary quantization**: int1, ~24x RAM reduction (Public Preview Dec 2024)
- Configured at index level:

```javascript
{
  fields: [
    {
      type: "vector",
      path: "embedding",
      numDimensions: 1536,
      similarity: "cosine",
      quantization: "scalar", // or "binary"
    },
  ];
}
```

---

## 6. Atlas M0 (Free Tier) Limitations

- **3 total search/vector indexes** (combined limit)
- 500MB storage maximum
- 100 ops/second
- 500 max connections
- No backups, no sharding
- Auto-pauses after 30 days inactivity

---

## Impact on CLAWMONGO_FRESH_START.md

### What Changes:

1. **Community Edition is no longer second-class** - has native $vectorSearch and $search
2. **JS cosine fallback is last resort**, not the default Community path
3. **Automated Embedding** can replace OpenClaw's entire embedding pipeline on MongoDB
4. **$scoreFusion** available on 8.2+ everywhere (our target version)
5. **Deployment tiers** need updating - Community much more capable now

### Updated Deployment Tiers:

| Tier                            | Vector Search          | Text Search            | Hybrid Search         | Automated Embedding         |
| ------------------------------- | ---------------------- | ---------------------- | --------------------- | --------------------------- |
| Atlas M10+                      | Native $vectorSearch   | Native $search         | $scoreFusion (native) | Coming Soon                 |
| Atlas M0                        | Native (3 index limit) | Native (3 index limit) | $scoreFusion (native) | Coming Soon                 |
| Community 8.2+ (with mongot)    | Native $vectorSearch   | Native $search         | $scoreFusion (native) | Public Preview              |
| Community 8.2+ (without mongot) | JS cosine fallback     | $text index fallback   | JS merge fallback     | N/A (use OpenClaw pipeline) |

### Key Insight:

The only fallback path needed is for Community deployments WITHOUT mongot installed. When mongot is present, Community has feature parity with Atlas for search.
