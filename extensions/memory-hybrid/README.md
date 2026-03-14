# Memory (Hybrid) Plugin for OpenClaw

Enhanced long-term memory plugin with **Knowledge Graph**, **Hybrid Recall Scoring**, **Smart Capture**, **Memory Reflection**, and free **Google Gemini** support.

## Why This Plugin?

The built-in `memory-lancedb` plugin uses vector search with OpenAI embeddings. It works, but has limitations:

- **Only OpenAI** — requires a paid API key
- **Regex-only capture** — misses most personal facts
- **Vector-only recall** — doesn't consider recency or importance
- **No knowledge graph** — doesn't understand entity relationships

**memory-hybrid** solves all of these while remaining a drop-in replacement.

## Features

| Feature                          | memory-lancedb | **memory-hybrid** |
| -------------------------------- | -------------- | ----------------- |
| Vector search (LanceDB)          | ✅             | ✅                |
| Google Gemini (free!)            | ❌             | ✅                |
| OpenAI support                   | ✅             | ✅                |
| Knowledge Graph                  | ❌             | ✅                |
| Smart Capture (LLM)              | ❌             | ✅                |
| Hybrid Scoring (5-channel)       | ❌             | ✅                |
| Memory Reflection / User Profile | ❌             | ✅                |
| Memory Consolidation             | ❌             | ✅                |
| Memory Reinforcement             | ❌             | ✅                |
| Contradiction Resolution         | ❌             | ✅                |
| Working Memory Buffer            | ❌             | ✅                |
| Retry with backoff               | ❌             | ✅                |
| Modular codebase                 | ❌             | ✅                |
| Prompt injection protection      | ✅             | ✅                |
| GDPR-compliant forget            | ✅             | ✅                |

### Knowledge Graph

When you store a memory, the plugin uses an LLM to extract entities and relationships:

```
Memory: "I use Python for my web projects at Acme Corp"
  → Nodes: [User (Person), Python (Language), Acme Corp (Company)]
  → Edges: [User --uses--> Python, User --works_at--> Acme Corp]
```

When recalling, graph connections enrich the results — so asking about "Python" also surfaces "Acme Corp".

### Hybrid Recall Scoring

Instead of pure vector similarity, memories are ranked by a 5-channel combined score:

```
Score = 0.50 × VectorSimilarity
      + 0.12 × Recency
      + 0.18 × Importance
      + 0.10 × GraphConnections
      + 0.10 × Reinforcement (recall frequency)
```

This means recent, important, frequently-recalled, and well-connected memories rank higher.

### Memory Reflection

Generates a high-level "user profile" from all stored memories using LLM analysis:

```
Raw facts: "Uses Python", "Builds Telegram bots", "Learning with AI", "Lives in Ukraine"

Reflection:
  Summary: "User is a Ukrainian developer who is self-teaching programming
            through AI tools, focusing on practical projects like Telegram bots."
  Patterns:
    - Prefers hands-on learning over theory
    - Focuses on Python ecosystem
    - Strong interest in AI-assisted development
```

This goes beyond storing facts — it **understands the person**.

### Smart Capture

Traditional regex capture only catches obvious patterns like "I prefer X" or email addresses.

Smart Capture sends user messages to an LLM which extracts individual facts:

```
Message: "Мене звати Вова, мені 25, я працюю з Python і живу в Києві"
  → Facts:
    1. "User's name is Vova" (importance: 0.9, category: entity)
    2. "User is 25 years old" (importance: 0.7, category: fact)
    3. "User works with Python" (importance: 0.7, category: fact)
    4. "User lives in Kyiv" (importance: 0.8, category: fact)
```

Each fact is stored separately with proper categorization.

### Memory Consolidation

Merges duplicate or similar memories into stronger consolidated facts:

```
Before: "I like coffee", "Coffee is good", "Drinking coffee daily"
After:  "User preference: Coffee — drinks daily and enjoys it" (importance: 0.85)
```

Run via `openclaw ltm consolidate` CLI command.

## Configuration

### With Google Gemini (Free)

```json
{
  "embedding": {
    "apiKey": "${GEMINI_API_KEY}",
    "model": "gemini-embedding-001"
  },
  "autoCapture": true,
  "autoRecall": true,
  "smartCapture": true
}
```

### With OpenAI

```json
{
  "embedding": {
    "apiKey": "${OPENAI_API_KEY}",
    "model": "text-embedding-3-small"
  },
  "autoCapture": true,
  "autoRecall": true
}
```

### All Options

| Option             | Default                      | Description                                                                         |
| ------------------ | ---------------------------- | ----------------------------------------------------------------------------------- |
| `embedding.apiKey` | _required_                   | API key (OpenAI or Google)                                                          |
| `embedding.model`  | `gemini-embedding-001`       | Embedding model (Google, 1K RPD free)                                               |
| `chatModel`        | auto                         | LLM for graph/capture (auto: `gemma-3-27b-it` for Google, `gpt-4o-mini` for OpenAI) |
| `dbPath`           | `~/.openclaw/memory/lancedb` | Database path                                                                       |
| `autoCapture`      | `false`                      | Auto-capture from conversations                                                     |
| `autoRecall`       | `true`                       | Auto-inject memories into context                                                   |
| `smartCapture`     | `false`                      | Use LLM for intelligent fact extraction                                             |
| `captureMaxChars`  | `500`                        | Max message length for capture                                                      |

## Tools

The plugin registers four tools for the AI agent:

- **`memory_recall`** — Search memories by query (uses hybrid scoring)
- **`memory_store`** — Store a new memory (with graph extraction + contradiction check)
- **`memory_forget`** — Delete a memory by ID or query (GDPR-compliant)
- **`memory_reflect`** — Generate a user profile from all memories (requires ≥5 memories)

## CLI Commands

```bash
openclaw ltm list           # Show memory count
openclaw ltm search <query> # Search memories with hybrid scoring
openclaw ltm graph          # Show knowledge graph stats
openclaw ltm stats          # Show overall statistics
openclaw ltm consolidate    # Merge similar memories (use --dry-run to preview)
openclaw ltm reflect        # Generate user profile from all memories
```

## Architecture

```
config.ts        → Configuration parsing and validation
embeddings.ts    → OpenAI + Google embedding API clients
chat.ts          → LLM client with retry logic (OpenAI + Google)
graph.ts         → Knowledge Graph storage and LLM extraction
capture.ts       → Rule-based + LLM-powered memory capture
recall.ts        → Hybrid scoring (vector + recency + importance + graph + reinforcement)
buffer.ts        → Working Memory Buffer (short-term → long-term promotion)
consolidate.ts   → Memory deduplication / clustering / LLM merging
reflection.ts    → User profile generation from accumulated memories
index.ts         → Plugin registration, tools, hooks, CLI
```

## Testing

```bash
# Run all tests
pnpm exec vitest run extensions/memory-hybrid/ --config vitest.extensions.config.ts
```

## Acknowledgements

Built upon the foundation of `memory-lancedb` by the OpenClaw team.
AI-assisted development using Gemini.
