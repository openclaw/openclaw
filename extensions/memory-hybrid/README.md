# BrainClaw (Cognitive Memory Plugin for OpenClaw)

> **"Code without memory is just a calculator. Code with BrainClaw is an entity."**

## 🧠 BrainClaw: The Cognitive Architecture Parallel

BrainClaw is more than a vector database; it is a technical attempt to replicate the core neurological functions of the human brain within an AI agent.

### 1. The Hippocampus (Working Memory Buffer)

Humans do not store every trivial "okay" or "thanks". Our brains filter noise. **BrainClaw's Working Memory Buffer** (`buffer.ts`) mimics this by staging facts and only "promoting" them to long-term storage (LanceDB) if they cross importance thresholds or are reinforced by repetition.

### 2. Associative Thinking (AMHR & Knowledge Graph)

Human memory is associative, not just semantic. When you think of "Coffee", you might recall "that cafe in Kyiv". **BrainClaw's Associative Multi-Hop Retrieval** (`index.ts`) traverses the Knowledge Graph to surface connected facts even when mathematical vector similarity is low.

### 3. Synaptic Reinforcement (7-Channel Scoring)

The more you think about something, the stronger the neural pathway becomes. **BrainClaw's 7-Channel Scoring** (`recall.ts`) directly applies this. Facts that are frequently recalled (**Reinforcement**), emotionally charged (**Emotional Tone**), or recent (**Recency**) naturally rise to the surface of the agent's consciousness.

### 4. Continuous Reflection (User Profiling)

Just as humans build a self-identity from accumulated experiences, BrainClaw's **Reflection Engine** (`reflection.ts`) analyzes the entire memory pool to generate a psychological persona and deep behavioral patterns.

---

## Why BrainClaw?

Standard RAG (Retrieval-Augmented Generation) systems use simple vector similarity. They miss context, forget old facts, and don't understand _relationships_. BrainClaw solves this while remaining a drop-in replacement for `memory-lancedb`.

## Features

| Feature                          | memory-lancedb | **BrainClaw**        |
| -------------------------------- | -------------- | -------------------- |
| Vector search (LanceDB)          | ✅             | ✅                   |
| Google Gemini (free!)            | ❌             | ✅                   |
| OpenAI support                   | ✅             | ✅                   |
| Knowledge Graph                  | ❌             | ✅                   |
| AMHR (Associative Retrieval)     | ❌             | ✅                   |
| Smart Capture (LLM)              | ❌             | ✅                   |
| Hybrid Scoring (7-channel)       | ❌             | ✅                   |
| Conversation Stack (Compression) | ❌             | ✅                   |
| Memory Reflection / User Profile | ❌             | ✅                   |
| Memory Consolidation             | ❌             | ✅                   |
| Contradiction Resolution         | ❌             | ✅ (PHOENIX Logic)   |
| JSON-Mode API Optimization       | ❌             | ✅ (Gemma 3 Fix)     |
| Working Memory Buffer            | ❌             | ✅                   |
| JSONL Observability Tracer       | ❌             | ✅ (Deep Monitoring) |
| Prompt injection protection      | ✅             | ✅                   |
| GDPR-compliant forget            | ✅             | ✅                   |
| **Background Orchestration**     | ❌             | ✅ (429 Optimizer)   |
| **Batch Summarization**          | ❌             | ✅ (RPM Optimizer)   |

### 🧠 7-Channel Hybrid Recall Scoring

Instead of pure vector similarity, memories are ranked by a 7-channel combined mathematical scoring system. This directly mirrors how human neurology prioritizes thoughts:

```javascript
Score =
  0.42 * VectorSimilarity +
  0.16 * Importance +
  0.1 * Temporal +
  0.1 * Recency +
  0.08 * Reinforcement +
  0.08 * Graph +
  0.06 * Emotional;
```

1. **Vector (0.42)** — Pure semantic and contextual similarity.
2. **Importance (0.16)** — Facts with high emotional or practical weight (injected during Smart Capture) rise to the top.
3. **Recency (0.10)** — Uses Exponential Decay (`Math.exp(-decay * days)`). Old memories naturally fade unless reinforced.
4. **Temporal (0.10)** — Aligns "today" with memories matching the current date/context.
5. **Graph (0.08)** — Multi-hop connections in the Knowledge Graph. Highly connected nodes (like your name or core skills) naturally trigger associated memories.
6. **Reinforcement (0.08)** — Boosts for frequently recalled facts. The more a memory is accessed, the stronger its neural pathway.
7. **Emotional (0.06)** — Matches the emotional tone of the current conversation to the original memory's tone.

### 🕸️ Knowledge Graph & AMHR

When you store a memory, BrainClaw uses an LLM to extract entities and relationships:

```
Memory: "I use Python for my web projects at Acme Corp"
  → Nodes: [User (Person), Python (Language), Acme Corp (Company)]
  → Edges: [User --uses--> Python, User --works_at--> Acme Corp]
```

**Associative Multi-Hop Retrieval (AMHR)** allows the system to traverse this graph when recalling. Asking about "Python" surfaces "Acme Corp" purely through associative graph links, even if the vector similarity is low.

### 📚 Conversation Stack

To understand full context without blowing up the 15k context window (e.g. Gemma 3 limits), BrainClaw utilizes a `ConversationStack`.
It compresses each user/assistant turn into a ~30-word summary, accumulating them into a session-scoped stack.
**Result:** ~17x token compression with full context retention.

### 💡 Smart Capture & Working Memory Buffer

Traditional regex capture only catches obvious patterns like "I prefer X".
Smart Capture routes via an LLM to extract facts, placing them in a **Working Memory Buffer**. The buffer requires patterns (e.g. `importance >= 0.7`, or `mentioned > 3 times`) before promoting facts to the permanent LanceDB database. This is the exact mechanism of the human Hippocampus.

### 🪞 Memory Reflection

Generates a high-level "user profile" from all stored memories using LLM analysis. Instead of searching raw facts, it summarizes patterns.

```
Summary: "User is a Ukrainian developer who is self-teaching programming
          through AI tools, focusing on practical projects like Telegram bots."
Patterns:
  - Prefers hands-on learning over theory
  - Focuses on Python ecosystem
```

### 🧹 Memory Consolidation

Merges duplicate or similar memories into stronger consolidated facts via the `openclaw ltm consolidate` CLI command.

## Installation

As an open-source `OpenClaw` plugin, installation is simple:

1. **Clone into `extensions/`**:
   Navigate to your OpenClaw root directory and clone BrainClaw:
   ```bash
   git clone https://github.com/vova/BrainClaw.git extensions/memory-hybrid
   ```
2. **Install dependencies**:
   ```bash
   pnpm install
   ```
3. **Configure Settings**:
   Add the following to your `~/.openclaw/config.json`.

### Configuration (Google Gemini Free Tier)

```json
{
  "plugins": {
    "slots": { "memory": "memory-hybrid" },
    "entries": {
      "memory-hybrid": {
        "enabled": true,
        "config": {
          "embedding": {
            "apiKey": "${GEMINI_API_KEY}",
            "model": "gemini-embedding-002"
          },
          "autoRecall": true,
          "autoCapture": true,
          "smartCapture": true
        }
      }
    }
  }
}
```

### Configuration (OpenAI)

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

### All Config Options

| Option             | Default                      | Description                                                            |
| ------------------ | ---------------------------- | ---------------------------------------------------------------------- |
| `embedding.apiKey` | _required_                   | API key (OpenAI or Google)                                             |
| `embedding.model`  | `gemini-embedding-002`       | Latest Google embedding model (768/3072 dims)                          |
| `chatModel`        | auto                         | LLM for graph/capture (auto: `gemini-3.1-flash-lite` or `gpt-4o-mini`) |
| `dbPath`           | `~/.openclaw/memory/lancedb` | Database path                                                          |
| `autoCapture`      | `true`                       | Auto-capture from conversations                                        |
| `autoRecall`       | `true`                       | Auto-inject memories into context                                      |
| `smartCapture`     | `true`                       | Use LLM for intelligent fact extraction                                |
| `captureMaxChars`  | `500`                        | Max message length for capture                                         |

## Tools

The plugin registers four tools for the AI agent:

| Tool             | Description                                           |
| ---------------- | ----------------------------------------------------- |
| `memory_recall`  | Search memories (hybrid scoring + graph enrichment)   |
| `memory_store`   | Store memory (graph extraction + contradiction check) |
| `memory_forget`  | Delete memory (GDPR-compliant)                        |
| `memory_reflect` | Generate user profile from all memories               |

## CLI Commands

```bash
openclaw ltm list           # Show memory count
openclaw ltm search <query> # Search memories with hybrid scoring
openclaw ltm graph          # Show knowledge graph stats
openclaw ltm stats          # Show overall statistics
openclaw ltm consolidate    # Merge similar memories
openclaw ltm reflect        # Generate user profile

# NEW: Real-time Observability Dashboard
bun extensions/memory-hybrid/scripts/monitor.ts
```

## 🛠️ Observability & Monitoring

BrainClaw provides deep, non-blocking observability into every thought and recall.

### 1. The Trace Log

All critical events (Store, Recall, Summarize, Graph) are logged to:
`~/.openclaw/memory/traces/thoughts.jsonl`

### 2. The Real-time Monitor

Run the dedicated dashboard to see the bot's "inner thoughts" as they happen:

```bash
bun extensions/memory-hybrid/scripts/monitor.ts
```

It provides:

- **Recall Visualization**: Exact scores for all candidates.
- **Batch Summarization Logs**: Highlights context compression events.
- **Memory Storage**: Real-time feedback on importance and category extraction.

## ⚙️ Advanced Features

### 🧊 Dream Service (Background Maintenance)

The `DreamService` runs periodic maintenance (Cleanup, Emotional Profiling, Proactive Questions).
**Protection:** Includes atomic guards to prevent multiple instances from running even during plugin restarts, preserving your API quota.

### ⛓️ Candidate Pool Preservation

Unlike standard RAG, BrainClaw preserves a pool of **50-70 candidates** through the entire 7-channel re-ranking process. This prevents "late-stage" signals like recency or importance from being drowned out by early vector similarity truncation.

## Architecture

| File             | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `config.ts`      | Configuration parsing and validation                     |
| `embeddings.ts`  | OpenAI + Google embedding API clients                    |
| `chat.ts`        | LLM client with retry logic (OpenAI + Google)            |
| `graph.ts`       | Knowledge Graph storage and LLM extraction               |
| `capture.ts`     | Rule-based + LLM-powered memory capture                  |
| `stack.ts`       | Conversation Stack (context compression module)          |
| `recall.ts`      | 7-Channel Hybrid scoring routing & AMHR logic            |
| `buffer.ts`      | Working Memory Buffer (short-term → long-term promotion) |
| `tracer.ts`      | Asynchronous JSONL Observability logging                 |
| `consolidate.ts` | Memory deduplication / clustering / LLM merging          |
| `reflection.ts`  | User profile generation from accumulated memories        |
| `index.ts`       | Plugin registration, tools, hooks, CLI                   |

## Testing

```bash
# Run all core extension tests
pnpm exec vitest run extensions/memory-hybrid/ --config vitest.extensions.config.ts
```
