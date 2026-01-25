---
summary: "memory-ruvector plugin: Next-gen vector memory with self-learning AI, graph neural networks, and sub-millisecond queries"
read_when:
  - You want semantic vector search for conversation history
  - You want automatic message indexing with hooks
  - You want self-learning memory that improves over time
  - You need graph-based conversation analysis
  - You are configuring the ruvector memory plugin
---

# Memory Ruvector (plugin)

Next-generation vector memory for Clawdbot, powered by [ruvector](https://github.com/ruvnet/ruvector) - a Rust-based vector database with **self-learning AI**, **graph neural networks**, and **extreme performance**.

## Why memory-ruvector?

This plugin introduces capabilities that go far beyond traditional vector search:

| Feature | memory-ruvector | Traditional Memory |
|---------|-----------------|-------------------|
| **Self-Learning (SONA)** | Improves search accuracy over time from user feedback | Static, manual tuning |
| **Graph Neural Networks** | Discovers relationships between messages automatically | No relationship awareness |
| **Query Latency** | p50: 61 microseconds | Typically 10-100ms |
| **Memory Usage** | 200MB for 1M vectors (compressed) | 2-4GB for same dataset |
| **Cypher Queries** | Neo4j-compatible graph traversal | Not available |
| **Context Injection** | Auto-injects relevant memories into prompts | Manual search required |
| **Pattern Learning** | K-means++ clustering with EWC++ consolidation | No learning |
| **Multi-head Attention** | Semantic, temporal, causal, structural weighting | Single similarity metric |

### Key Differentiators

**SONA (Self-Organizing Neural Architecture)** - The memory system learns from every interaction. When users find search results helpful (or not), SONA adapts its ranking model. No manual retraining needed.

**Graph Neural Networks** - Messages aren't isolated vectors. They form a knowledge graph with relationships like `REPLIED_BY`, `IN_CONVERSATION`, `RELATES_TO`. Query this graph with Cypher to discover conversation threads, user patterns, and topic clusters.

**ruvLLM Adaptive Learning** - Three temporal learning loops (instant, background, consolidation) continuously improve search quality while EWC++ prevents catastrophic forgetting.

**Rust Performance** - Native Rust core with HNSW indexing delivers 16,400 QPS with sub-millisecond p99 latency. 10-100x faster than typical vector databases.

### Use Cases

- **Semantic memory**: Recall past conversations by meaning, not keywords
- **RAG integration**: Build knowledge bases from indexed messages
- **Intent detection**: Find similar user requests across sessions
- **Pattern analysis**: Discover recurring themes in conversations
- **Conversation threading**: Traverse reply chains and topic relationships
- **User preference learning**: Automatically learn and recall user preferences

### Performance Benchmarks

| Metric | Value |
|--------|-------|
| Query latency (p50) | 61 microseconds |
| Query latency (p99) | < 1 millisecond |
| Throughput | 16,400 QPS (k=10, 1536-dim) |
| Memory (1M vectors) | 200MB with compression |
| Index build | O(n log n) with HNSW |

## Install

```bash
clawdbot plugins install @clawdbot/memory-ruvector
```

Restart the Gateway afterwards.

## Config

Set config under `plugins.entries.memory-ruvector.config`:

```json5
{
  plugins: {
    entries: {
      "memory-ruvector": {
        enabled: true,
        config: {
          embedding: {
            provider: "openai",           // "openai" | "voyage" | "local"
            apiKey: "${OPENAI_API_KEY}",  // supports env var syntax
            model: "text-embedding-3-small"
          },
          dbPath: "~/.clawdbot/memory/ruvector",  // optional
          metric: "cosine",               // "cosine" | "euclidean" | "dot"
          hooks: {
            enabled: true,
            indexInbound: true,           // index user messages
            indexOutbound: true,          // index bot responses
            indexAgentResponses: true,    // index full agent turns
            batchSize: 10,                // messages per batch
            debounceMs: 500               // delay before flushing
          }
        }
      }
    }
  }
}
```

## Embedding providers

| Provider | Models | Dimensions | Notes |
|----------|--------|------------|-------|
| OpenAI | text-embedding-3-small, text-embedding-3-large | 1536, 3072 | Default, reliable |
| Voyage AI | voyage-3, voyage-3-large, voyage-code-3 | 1024 | Best for RAG |
| Local | Any OpenAI-compatible API | Configurable | Self-hosted |

Dimension is auto-detected from the model name. Override with the `dimension` config key if needed.

### Voyage AI example

```json5
{
  embedding: {
    provider: "voyage",
    apiKey: "${VOYAGE_API_KEY}",
    model: "voyage-3"
  }
}
```

### Local (OpenAI-compatible) example

```json5
{
  embedding: {
    provider: "local",
    baseUrl: "http://localhost:11434/v1",
    model: "nomic-embed-text"
  },
  dimension: 768  // must match your local model
}
```

## Automatic message indexing

When hooks are enabled (default in local mode), messages are automatically indexed:

| Hook | What gets indexed |
|------|-------------------|
| `message_received` | Incoming user messages |
| `message_sent` | Outgoing bot responses |
| `agent_end` | Full agent conversation turns |

**Smart batching**: Messages are batched (default: 10) with debouncing (default: 500ms) to optimize database writes and embedding API calls.

**Content filtering**: System markers, commands (`/`), and very short/long messages are automatically filtered out.

## CLI

```bash
# Show memory statistics
clawdbot ruvector stats

# Search indexed messages
clawdbot ruvector search "user preferences" --limit 10

# Filter by direction
clawdbot ruvector search "bug reports" --direction inbound

# Filter by channel
clawdbot ruvector search "feature requests" --channel telegram

# Force flush pending batch
clawdbot ruvector flush
```

## Agent tools

### ruvector_search

Search through indexed conversation history using semantic similarity.

```json5
{
  query: "What did the user say about their preferences?",
  limit: 5,              // max results (default: 5)
  direction: "inbound",  // optional: "inbound" | "outbound"
  channel: "telegram",   // optional: filter by channel
  sessionKey: "abc123"   // optional: filter by session
}
```

Returns matching messages with similarity scores. Results are formatted with direction, content preview, and match percentage.

### ruvector_index

Manually index a message or piece of information for future retrieval.

```json5
{
  content: "User prefers dark mode and minimal notifications",
  direction: "outbound",  // optional: "inbound" | "outbound" (default: outbound)
  channel: "manual"       // optional: channel identifier
}
```

Automatically detects and skips duplicates (>95% similarity).

## When to Use memory-ruvector

This plugin can run alongside the built-in `memory-core` plugin (different plugin IDs, no conflicts).

**Choose memory-ruvector when you need:**

| Requirement | Why memory-ruvector |
|-------------|---------------------|
| High-volume production | 16,400 QPS, sub-ms latency handles heavy load |
| Memory-constrained environments | 10-20x compression vs standard vector stores |
| Learning from user behavior | SONA adapts search ranking automatically |
| Conversation analysis | Cypher queries for threading and patterns |
| Multi-channel deployments | Graph relationships connect cross-channel conversations |
| Long-running bots | ruvLLM's continuous learning improves over time |

**Stick with memory-core when:**
- Simple, low-volume use cases
- No need for graph relationships
- Prefer minimal dependencies

## SONA Self-Learning

SONA (Self-Organizing Neural Architecture) improves search accuracy over time by learning from user feedback without manual retraining.

### Configuration

```json5
{
  plugins: {
    entries: {
      "memory-ruvector": {
        enabled: true,
        config: {
          embedding: {
            provider: "openai",
            apiKey: "${OPENAI_API_KEY}"
          },
          sona: {
            enabled: true,              // Enable self-learning
            hiddenDim: 256,             // Hidden dimension for neural architecture
            learningRate: 0.01,         // How quickly to adapt (0.001-0.1)
            qualityThreshold: 0.5,      // Minimum quality for learning (0-1)
            backgroundIntervalMs: 30000 // Background learning interval
          }
        }
      }
    }
  }
}
```

### How it works

1. **Trajectory Recording**: Every search query and its results are recorded as a trajectory
2. **Feedback Collection**: When users interact with results (click, use, dismiss), feedback is recorded
3. **Pattern Learning**: Graph Neural Networks analyze feedback to identify patterns
4. **Adaptive Ranking**: Future searches are re-ranked based on learned patterns

### ruvector_feedback tool

Record feedback on search results to improve future searches.

```json5
{
  searchId: "search-abc123",       // The original search ID
  selectedResultId: "result-456",  // The result being evaluated
  relevanceScore: 0.95             // Relevance score from 0 to 1
}
```

### CLI

```bash
# View SONA learning statistics
clawdbot ruvector sona-stats

# Output includes:
# - Total feedback recorded
# - Patterns learned
# - Accuracy improvement (%)
# - Recent trajectory count
```

## Graph Queries (Cypher)

Query message relationships using Neo4j-compatible Cypher syntax. This enables finding conversation threads, reply chains, and topic relationships.

Graph features are automatically available when the ruvector library is built with graph extension support. No additional configuration is needed.

### Linking messages

**Manual linking** via the `ruvector_graph` tool or CLI:

```json5
{
  action: "link",
  sourceId: "msg-123",
  targetId: "msg-456",
  relationship: "RELATES_TO",
  properties: { reason: "same topic" }
}
```

### ruvector_graph tool

Execute graph operations on the message store.

**Actions:**

| Action | Description | Parameters |
|--------|-------------|------------|
| `query` | Execute Cypher query | `cypher`, `params` |
| `neighbors` | Find connected nodes | `nodeId`, `depth`, `relationship` |
| `link` | Create edge between nodes | `sourceId`, `targetId`, `relationship`, `properties` |

**Query example:**

```json5
{
  action: "query",
  cypher: "MATCH (n)-[:REPLIED_BY]->(m) WHERE n.channel = $channel RETURN m.content LIMIT 10",
  params: { channel: "telegram" }
}
```

**Neighbors example:**

```json5
{
  action: "neighbors",
  nodeId: "msg-123",
  depth: 2,
  relationship: "IN_CONVERSATION"
}
```

### Cypher examples

Find all replies to a message:

```cypher
MATCH (original {id: $messageId})-[:REPLIED_BY*1..3]->(reply)
RETURN reply.content, reply.timestamp
ORDER BY reply.timestamp ASC
```

Find conversation threads by topic:

```cypher
MATCH (n)-[:IN_CONVERSATION]->(m)
WHERE n.content CONTAINS $topic
RETURN DISTINCT n.conversationId, COUNT(m) AS messageCount
ORDER BY messageCount DESC
LIMIT 10
```

Find user interaction patterns:

```cypher
MATCH (u:User)-[:SENT]->(m)-[:REPLIED_BY]->(r)
WHERE u.id = $userId
RETURN m.content AS original, r.content AS reply, r.timestamp
ORDER BY r.timestamp DESC
LIMIT 20
```

Get messages between two time ranges:

```cypher
MATCH (n)
WHERE n.timestamp >= $startTime AND n.timestamp <= $endTime
RETURN n.content, n.channel, n.direction
ORDER BY n.timestamp ASC
```

### CLI

```bash
# Execute a Cypher query
clawdbot ruvector graph "MATCH (n)-[:REPLIED_BY]->(m) RETURN m.content LIMIT 5"

# Find neighbors of a message
clawdbot ruvector neighbors msg-123 --depth 2 --relationship IN_CONVERSATION

# Link two messages manually
clawdbot ruvector link msg-123 msg-456 --relationship RELATES_TO
```

## ruvLLM Adaptive Learning

ruvLLM extends SONA with advanced adaptive learning features including trajectory recording, context injection, pattern clustering, and multi-temporal learning loops.

### Configuration

```json5
{
  plugins: {
    entries: {
      "memory-ruvector": {
        enabled: true,
        config: {
          embedding: {
            provider: "openai",
            apiKey: "${OPENAI_API_KEY}"
          },
          ruvllm: {
            enabled: true,
            contextInjection: {
              enabled: true,           // Inject relevant memories into agent context
              maxTokens: 2000,         // Maximum tokens for injected context
              relevanceThreshold: 0.3  // Minimum similarity for inclusion
            },
            trajectoryRecording: {
              enabled: true,           // Record search trajectories for learning
              maxTrajectories: 1000    // Maximum trajectories to retain
            }
          }
        }
      }
    }
  }
}
```

### Context injection

When enabled, relevant memories are automatically injected into agent system prompts via the `before_agent_start` hook:

1. Recent user messages are analyzed for semantic similarity
2. Top matching memories are formatted as context
3. Context is prepended to the agent's system prompt

This enables agents to recall relevant past conversations without explicit search calls.

### Trajectory recording

Every search query and its results are recorded as trajectories:

```typescript
{
  id: "traj-abc123",
  query: "user preferences",
  queryVector: [...],  // Embedding of the query
  results: [...],      // Result IDs with scores
  feedback: 0.85,      // User feedback score (optional)
  timestamp: 1706123456789,
  sessionId: "session-xyz"
}
```

Trajectories enable:
- Finding similar past searches
- Learning from feedback patterns
- Improving search ranking over time

### Pattern learning

The plugin learns patterns from feedback using K-means++ clustering:

1. **Sample collection**: High-quality feedback is stored as samples
2. **Clustering**: Similar samples are grouped into pattern clusters
3. **Re-ranking**: Search results are boosted based on matching patterns

### ruvector_recall tool

Pattern-aware memory recall combining vector search, learned patterns, and graph traversal.

```json5
{
  query: "What are the user's coding preferences?",
  usePatterns: true,    // Apply learned pattern re-ranking (default: true)
  expandGraph: true,    // Include graph-connected memories (default: false)
  graphDepth: 2,        // Depth for graph traversal (1-3, default: 1)
  patternBoost: 0.2     // Boost factor for pattern matches (0-1, default: 0.2)
}
```

### ruvector_learn tool

Manually index knowledge with automatic relationship inference.

```json5
{
  content: "User prefers TypeScript over JavaScript",
  category: "preference",     // "preference" | "fact" | "decision" | "entity" | "other"
  importance: 0.8,            // 0-1, affects pattern clustering
  relationships: ["msg-123"], // Explicit links to other entries
  inferRelationships: true,   // Auto-detect entities and relationships (default: true)
  linkSimilar: true,          // Link to similar existing entries (default: false)
  similarityThreshold: 0.8    // Threshold for auto-linking (default: 0.8)
}
```

### Learning loops

Three temporal learning loops adapt the system over time:

| Loop | Interval | Purpose |
|------|----------|---------|
| **Instant** | Immediate | Process feedback in real-time, apply micro-boosts |
| **Background** | 30s | Cluster recent trajectories, update pattern store |
| **Consolidation** | 5min | Deep reanalysis, merge patterns, prune stale data |

### EWC++ (Elastic Weight Consolidation)

Prevents catastrophic forgetting by:
- Tracking pattern importance via Fisher Information Matrix
- Protecting critical patterns during consolidation
- Computing penalties for modifying important patterns

### Pattern export and import

Save and restore learned patterns across sessions:

```bash
# Export learned patterns
clawdbot ruvector export-patterns ./patterns.json

# Import patterns (replaces existing)
clawdbot ruvector import-patterns ./patterns.json

# Merge with existing patterns
clawdbot ruvector import-patterns ./patterns.json --merge

# View pattern statistics
clawdbot ruvector pattern-stats
```

### Graph attention

Multi-head attention aggregates context from graph neighbors:

- **Semantic head**: Weights by content similarity
- **Temporal head**: Weights by time proximity
- **Causal head**: Weights by cause-effect relationships
- **Structural head**: Weights by graph structure

### CLI (ruvLLM)

```bash
# Show trajectory recording statistics
clawdbot ruvector trajectory-stats

# Show ruvLLM feature status
clawdbot ruvector ruvllm-status

# Export/import patterns
clawdbot ruvector export-patterns <path>
clawdbot ruvector import-patterns <path> [--merge]
clawdbot ruvector pattern-stats
```

## Error handling

The plugin handles failures gracefully:
- **Connection failures**: Falls back to in-memory storage
- **Embedding API errors**: 30-second timeout, response validation
- **Service unavailable**: Tools return `disabled: true`
- **Batch failures**: Retry with limits, reject pending on shutdown

## Config reference

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `embedding.provider` | string | `"openai"` | Embedding provider |
| `embedding.apiKey` | string | - | API key (supports `${ENV_VAR}`) |
| `embedding.model` | string | `"text-embedding-3-small"` | Embedding model |
| `embedding.baseUrl` | string | - | Custom API base URL |
| `dbPath` | string | `~/.clawdbot/memory/ruvector` | Database directory |
| `dimension` | number | auto | Vector dimension |
| `metric` | string | `"cosine"` | Distance metric |
| `hooks.enabled` | boolean | `true` | Enable auto-indexing |
| `hooks.indexInbound` | boolean | `true` | Index user messages |
| `hooks.indexOutbound` | boolean | `true` | Index bot messages |
| `hooks.indexAgentResponses` | boolean | `true` | Index agent turns |
| `hooks.batchSize` | number | `10` | Messages per batch |
| `hooks.debounceMs` | number | `500` | Batch flush delay |
| `sona.enabled` | boolean | `false` | Enable SONA self-learning |
| `sona.hiddenDim` | number | `256` | Hidden dimension for neural architecture |
| `sona.learningRate` | number | `0.01` | Learning rate (0.001-0.1) |
| `sona.qualityThreshold` | number | `0.5` | Minimum quality for learning |
| `sona.backgroundIntervalMs` | number | `30000` | Background learning interval |
| `ruvllm.enabled` | boolean | `false` | Enable ruvLLM features |
| `ruvllm.contextInjection.enabled` | boolean | `false` | Enable context injection |
| `ruvllm.contextInjection.maxTokens` | number | `2000` | Max tokens for injected context |
| `ruvllm.contextInjection.relevanceThreshold` | number | `0.3` | Min similarity for inclusion |
| `ruvllm.trajectoryRecording.enabled` | boolean | `false` | Enable trajectory recording |
| `ruvllm.trajectoryRecording.maxTrajectories` | number | `1000` | Max trajectories to retain |
