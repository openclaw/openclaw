---
title: "Memory Search"
summary: "How OpenClaw memory search works -- embedding providers, hybrid search, MMR, and temporal decay"
read_when:
  - You want to understand how memory_search retrieves results
  - You want to tune hybrid search, MMR, or temporal decay
  - You want to choose an embedding provider
---

# Memory Search

OpenClaw indexes workspace memory files (`MEMORY.md` and `memory/*.md`) into
chunks (~400 tokens, 80-token overlap) and searches them with `memory_search`.
This page explains how the search pipeline works and how to tune it. For the
file layout and memory basics, see [Memory](/concepts/memory).

## Search pipeline

```
Query -> Embedding -> Vector Search ─┐
                                     ├─> Weighted Merge -> Temporal Decay -> MMR -> Top-K
Query -> Tokenize  -> BM25 Search  ──┘
```

Both retrieval paths run in parallel when hybrid search is enabled. If either
path is unavailable (no embeddings or no FTS5), the other runs alone.

## Embedding providers

The default `memory-core` plugin ships built-in adapters for these providers:

| Provider   | Adapter ID | Auto-selected        | Notes                               |
| ---------- | ---------- | -------------------- | ----------------------------------- |
| Local GGUF | `local`    | Yes (first priority) | node-llama-cpp, ~0.6 GB model       |
| OpenAI     | `openai`   | Yes                  | `text-embedding-3-small` default    |
| Gemini     | `gemini`   | Yes                  | Supports multimodal (images, audio) |
| Voyage     | `voyage`   | Yes                  |                                     |
| Mistral    | `mistral`  | Yes                  |                                     |
| Ollama     | `ollama`   | No (explicit only)   | Local/self-hosted                   |

Auto-selection picks the first provider whose API key can be resolved. Set
`memorySearch.provider` explicitly to override.

Remote embeddings require an API key for the embedding provider. OpenClaw
resolves keys from auth profiles, `models.providers.*.apiKey`, or environment
variables. Codex OAuth covers chat/completions only and does not satisfy
embedding requests.

### Quick start

Enable memory search with OpenAI embeddings:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "openai",
        model: "text-embedding-3-small",
      },
    },
  },
}
```

Or use local embeddings (no API key needed):

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "local",
      },
    },
  },
}
```

Local mode uses node-llama-cpp and may require `pnpm approve-builds` to build
the native addon.

## Hybrid search (BM25 + vector)

When both FTS5 and embeddings are available, OpenClaw combines two retrieval
signals:

- **Vector similarity** -- semantic matching. Good at paraphrases ("Mac Studio
  gateway host" vs "the machine running the gateway").
- **BM25 keyword relevance** -- exact token matching. Good at IDs, code symbols,
  error strings, and config keys.

### How scores are merged

1. Retrieve a candidate pool from each side (top
   `maxResults x candidateMultiplier`).
2. Convert BM25 rank to a 0-1 score: `textScore = 1 / (1 + max(0, bm25Rank))`.
3. Union candidates by chunk ID and compute:
   `finalScore = vectorWeight x vectorScore + textWeight x textScore`.

Weights are normalized to 1.0, so they behave as percentages. If either path is
unavailable, the other runs alone with no hard failure.

### CJK support

FTS5 uses configurable trigram tokenization with a short-substring fallback so
Chinese, Japanese, and Korean text is searchable. CJK-heavy text is weighted
correctly during chunk-size estimation, and surrogate-pair characters are
preserved during fine splits.

## Post-processing

After merging scores, two optional stages refine the result list:

### Temporal decay (recency boost)

Daily notes accumulate over months. Without decay, a well-worded note from six
months ago can outrank yesterday's update on the same topic.

Temporal decay applies an exponential multiplier based on age:

```
decayedScore = score x e^(-lambda x ageInDays)
```

With the default half-life of 30 days:

| Age      | Score retained |
| -------- | -------------- |
| Today    | 100%           |
| 7 days   | ~84%           |
| 30 days  | 50%            |
| 90 days  | 12.5%          |
| 180 days | ~1.6%          |

**Evergreen files are never decayed** -- `MEMORY.md` and non-dated files in
`memory/` (like `memory/projects.md`) always rank at full score. Dated daily
files use the date from the filename.

**When to enable:** Your agent has months of daily notes and stale information
outranks recent context.

### MMR re-ranking (diversity)

When search returns results, multiple chunks may contain similar or overlapping
content. MMR (Maximal Marginal Relevance) re-ranks results to balance relevance
with diversity.

How it works:

1. Start with the highest-scoring result.
2. Iteratively select the next result that maximizes:
   `lambda x relevance - (1 - lambda) x max_similarity_to_already_selected`.
3. Similarity is measured using Jaccard text similarity on tokenized content.

The `lambda` parameter controls the trade-off:

- `1.0` -- pure relevance (no diversity penalty).
- `0.0` -- maximum diversity (ignores relevance).
- Default: `0.7` (balanced, slight relevance bias).

**When to enable:** `memory_search` returns redundant or near-duplicate
snippets, especially with daily notes that repeat similar information.

## Configuration

Both post-processing features and hybrid search weights are configured under
`memorySearch.query.hybrid`:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        query: {
          hybrid: {
            enabled: true,
            vectorWeight: 0.7,
            textWeight: 0.3,
            candidateMultiplier: 4,
            mmr: {
              enabled: true, // default: false
              lambda: 0.7,
            },
            temporalDecay: {
              enabled: true, // default: false
              halfLifeDays: 30,
            },
          },
        },
      },
    },
  },
}
```

You can enable either feature independently:

- **MMR only** -- many similar notes but age does not matter.
- **Temporal decay only** -- recency matters but results are already diverse.
- **Both** -- recommended for agents with large, long-running daily note
  histories.

## Session memory search (experimental)

You can optionally index session transcripts and surface them via
`memory_search`. This is gated behind an experimental flag:

```json5
{
  agents: {
    defaults: {
      memorySearch: {
        experimental: { sessionMemory: true },
        sources: ["memory", "sessions"],
      },
    },
  },
}
```

Session indexing is opt-in and runs asynchronously. Results can be slightly stale
until background sync finishes. Session logs live on disk, so treat filesystem
access as the trust boundary.

## Troubleshooting

**`memory_search` returns nothing?**

- Check `openclaw memory status` -- is the index populated?
- Verify an embedding provider is configured and has a valid key.
- Run `openclaw memory index --force` to trigger a full reindex.

**Results are all keyword matches, no semantic results?**

- Embeddings may not be configured. Check `openclaw memory status --deep`.
- If using `local`, ensure node-llama-cpp built successfully.

**CJK text not found?**

- FTS5 trigram tokenization handles CJK. If results are missing, run
  `openclaw memory index --force` to rebuild the FTS index.

## Further reading

- [Memory](/concepts/memory) -- file layout, backends, tools
- [Memory configuration reference](/reference/memory-config) -- all config knobs
  including QMD, batch indexing, embedding cache, sqlite-vec, and multimodal
