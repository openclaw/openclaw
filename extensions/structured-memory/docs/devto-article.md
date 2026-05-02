# I tested 4 local models as memory classifiers for OpenClaw — and thinking models are a trap

I build game server backends for a living — C++ and Go, the kind where a race condition means players lose progress. When I started using OpenClaw, I saw the same class of reliability problems in its memory system. The agent would forget who I was after a session reset. Safety rules would vanish after compaction. I'd told it my preferences three times, and it still asked "Python or Go?"

So I did what any backend engineer would do: I wrote a protocol specification, built a reference implementation, and ran a benchmark. Here's what I learned.

## The problem isn't retrieval. It's input.

OpenClaw's memory pipeline looks like this:

```
Agent decides what to remember → calls memory tools → stores unstructured text → retrieves via vector similarity
```

Every step depends on the agent making the right decision at the right time. When context compacts or the model switches, the agent forgets to call `memory_search`. The memory was _stored correctly_, but it was never _retrieved_. And sometimes it was never stored at all — the agent decided a preference wasn't worth remembering.

The community has built excellent solutions on the retrieval side — LanceDB with hybrid vector + BM25 search, cross-encoder reranking, knowledge graphs. But nobody was fixing the input side: **what should be remembered in the first place?**

## SheetMemory: a structured, typed memory protocol

I wrote a protocol specification called [SheetMemory](https://github.com/openclaw/openclaw/blob/main/PROTOCOL.md) that defines:

- A **7-type schema** (entity, event, fact, rule, impression, plan, reflex) — every memory gets a type, confidence score, importance rating, and optional expiration
- **QUERY / UPSERT / FORGET** primitives with deterministic behavior rules
- A **Perceptor** — a pure-regex signal detector that runs on every user message before anything reaches the LLM
- **Hard constraints**: critical memories are immune to decay, expire_at records are forcibly archived, user corrections override everything

The key architectural decision: **retrieval uses deterministic field filters (type=rule, confidence>=0.7), not vector similarity.** Semantic search is an optional post-processing step on the top-15 candidates, not the primary engine.

I then built a reference implementation as an OpenClaw plugin — `extensions/structured-memory/` — with SQLite storage, Weibull time-based decay, and a local-model classification pipeline.

## The classification bottleneck

The classification step takes raw user text and maps it to the protocol schema. This is a structured output task — the model receives a fixed prompt and must produce valid JSON with predefined fields. It's not a reasoning task. It's a formatting task.

I wanted to know: **which local model can do this reliably, at what latency, in what language?**

## The benchmark

I built a 25-case dirty-input test set covering 10 challenge dimensions:

- **noise-wrapped**: key information buried in casual chatter
- **implicit**: information conveyed without direct statement
- **fragmented**: broken grammar, telegraphic sentences
- **negation/correction**: "No wait, that's wrong, actually it's..."
- **multi-intent**: event + plan, fact + plan intertwined in one message
- **boundary-ambiguous**: impression vs preference, rule vs fact
- **code-switching**: Chinese with embedded English ("new CTO叫James Chen")
- **hypothetical**: "If the review passes next Monday, we'll..."
- **sarcasm**: "Oh absolutely love it when requirements change 2 days before deadline"
- **third-party**: "I heard from Dave that ops had a massive incident..."
- **very short**: "btw my email is james.chen@gmail.com"

Chinese and English versions, identical structure. Tested against 4 models on my MBP14 (32GB, Ollama):

| Model            | ZH 25c | EN 25c | Parse Rate | Avg Latency |
| ---------------- | ------ | ------ | ---------- | ----------- |
| qwen2.5:3b       | 64%    | 64%    | 100%       | 1.5s        |
| qwen:7b          | 68%    | 56%    | 92%        | 3.4s        |
| llama3.2:3b      | —      | 33%    | 47% (EN)   | 1.5s        |
| gemma-26b (GGUF) | —      | —      | 71%        | 30s+        |

The full benchmark script is at `scripts/bench-structured-memory.py`. You can run it against your own models.

## What I learned

### 1. Thinking models are a trap for classification

Gemma-26b was the worst performer by every metric. Its `thinking` field — a chain-of-thought mechanism — consumed 200–500 tokens of internal monologue before writing a single character of JSON output. Sample from the raw API response:

```
*   Text: "我们公司的核心产品是一个AI编码助手..."
*   *Is it a fact?* It is a fact, but "event" is more specific...
*   *Wait, let's check the importance scale again.*
*   10 = Critical (identity, core goals, safety rules)
*   7-9 = Very important (key preferences, recurring patterns)
*   *Decision:* 8.
*   *Self-Correction on importance:* Let's re-evaluate...
```

The model was correct — it just never finished writing the JSON. After 1024 tokens of output budget, it was still debating whether a company description is a fact or an event. The content field was truncated mid-JSON. Average latency: 30+ seconds per message.

Classification does not need chain-of-thought. It needs a model that reads the prompt, sees 7 types, picks one, and outputs JSON. The thinking overhead is pure waste.

### 2. Parse reliability matters more than accuracy

Accuracy numbers are misleading on their own. qwen:7b scored 68% on Chinese — the highest in the matrix. But its 92% parse rate means it dropped 2 out of 25 messages entirely. Both failures were the same bug: the model invented a `"comparison"` type that doesn't exist in the schema, and the parser rejected it.

qwen2.5:3b scored 64% — 4 points lower — but with 100% parse rate across both languages. Every message produced a valid, typed record. In production, a record classified as the wrong type is still retrievable via text search. A record that was never written at all is gone forever.

**100% parse rate > 4% accuracy gain.** This is the most important finding in the benchmark.

### 3. Language-native models dominate their language

qwen:7b is 68% on Chinese and 56% on English — a 12-point gap. llama3.2:3b, an English-native model, couldn't handle Chinese at all (21% parse failure) and collapsed to 47% parse rate on its own native language due to JSON truncation (English keywords are longer, eating more token budget).

qwen2.5:3b is the only model with parity across languages. For a plugin that targets the global OpenClaw community, this stability is non-negotiable.

### 4. Small models can't discriminate importance

The 3B model's importance scores collapsed to binary: either 4 ("moderate") or 7 ("important"). It never assigned 1–3 (minor), 5–6 (contextual), or 8–10 (critical). The 7B model showed more variance but also drifted — it rated "I'm not sure I'll make it to the end of the year" as importance 6 and "meeting at 3pm" as importance 9.

This is why the protocol assigns importance to the Perceptor, not the LLM. Rules can reliably detect high-importance signals: "必须/禁止 → importance 8+", "不喜欢/更倾向 → importance 6", "帮我记一下 → importance 7+". The classifier polishes the summary; the Perceptor owns the importance.

## Why deterministic retrieval?

Vector search dominates the memory-plugin ecosystem. It's powerful for semantic similarity — "birthday" matches "born on". But it has fundamental limits:

- **Results are non-deterministic.** The same query can return different results after re-indexing, embedding model updates, or quantization changes.
- **Debuggability is poor.** You can't inspect why a memory ranked #3 instead of #1 without analyzing embedding vectors.
- **Offline parity is fragile.** Embedding models are large binaries with platform-specific dependencies.

SheetMemory's primary retrieval engine is `SELECT * FROM memory_records WHERE type='rule' AND confidence >= 0.7 AND keywords LIKE '%contract%'`. This is deterministic, debuggable, and runs on the same SQLite file everywhere.

Vector search isn't excluded — it's demoted to an optional rerank pass on the top-15 field-filtered candidates. Deterministic first, semantic second.

## Open source

The protocol is [PROTOCOL.md](https://github.com/openclaw/openclaw/blob/main/PROTOCOL.md). The plugin is at `extensions/structured-memory/`. The benchmark is at `scripts/bench-structured-memory.py`. Everything is MIT.

If you have a better classification model, or you want to add English Perceptor rules, or you found a case where the protocol breaks — open an issue or send a PR. The benchmark script is designed to be extensible: add your own test cases in the `CASES_ZH`/`CASES_EN` arrays and run against your own models.

---

_I'm a game server backend engineer who got annoyed that his AI agent couldn't remember anything reliably. [@mingchxing](https://github.com/innerca)_
