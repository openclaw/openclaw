# Live Hippocampus Architecture

## Overview

A background agent that continuously monitors conversations, analyzes content, and maintains a weighted memory system with importance coefficients.

---

## System Components

```
┌─────────────────────────────────────────────────────────────┐
│                     MAIN SESSION                            │
│                   (the agent + the user)                            │
│                                                             │
│  Conversation flows naturally, no capture burden            │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          │ polls every N minutes
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                  HIPPOCAMPUS AGENT                          │
│              (background sub-agent)                         │
│                                                             │
│  1. Fetch recent conversation history                       │
│  2. Analyze for memory-worthy content                       │
│  3. Check against existing memories                         │
│  4. Score, store, or reinforce                              │
│  5. Apply decay to old memories                             │
└─────────────────────────┬───────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────┐
│                   MEMORY STORE                              │
│           (structured with importance scores)               │
│                                                             │
│  memory/                                                    │
│  ├── index.json          # Central index with scores        │
│  ├── user/               # User facts                       │
│  ├── self/               # Self facts                       │
│  ├── relationship/       # Relationship facts               │
│  └── world/              # World knowledge                  │
└─────────────────────────────────────────────────────────────┘
```

---

## Memory Index Schema

`memory/index.json`:

```json
{
  "version": 1,
  "lastUpdated": "2025-01-20T17:30:00Z",
  "memories": [
    {
      "id": "mem_001",
      "domain": "user",
      "category": "preferences",
      "content": "User prefers concise responses",
      "importance": 0.85,
      "created": "2025-01-15T10:00:00Z",
      "lastAccessed": "2025-01-20T17:00:00Z",
      "timesReinforced": 5,
      "keywords": ["english", "language", "preference"]
    },
    {
      "id": "mem_002",
      "domain": "relationship",
      "category": "trust",
      "content": "User shared something personal about their challenges",
      "importance": 0.92,
      "created": "2025-01-16T14:00:00Z",
      "lastAccessed": "2025-01-20T16:00:00Z",
      "timesReinforced": 3,
      "keywords": ["work", "vulnerability", "trust", "stress"]
    }
  ]
}
```

---

## Importance Scoring

### Initial Score (when creating new memory)

| Signal | Base Score |
|--------|------------|
| Explicit "remember this" | 0.9 |
| Emotional/vulnerable content | 0.85 |
| Preference/identity statement | 0.8 |
| Decision made | 0.75 |
| Project/work context | 0.6 |
| General fact | 0.5 |
| Passing mention | 0.3 |

### Reinforcement (when topic comes up again)

```
new_score = old_score + (1 - old_score) * 0.15
```

Each reinforcement adds ~15% of remaining headroom.
Example: 0.6 → 0.66 → 0.71 → 0.75 → ...

### Decay (applied periodically)

```
decayed_score = score * (0.99 ^ days_since_access)
```

~1% decay per day of not being accessed.
- After 7 days: 93% of original
- After 30 days: 74% of original
- After 90 days: 40% of original

### Thresholds

| Score | Status |
|-------|--------|
| 0.7+ | **Core memory** — always available in context |
| 0.4-0.7 | **Active memory** — retrieved when relevant |
| 0.2-0.4 | **Background memory** — only with specific search |
| <0.2 | **Candidate for archival** — review before deletion |

---

## Hippocampus Agent Behavior

### Trigger
- Runs periodically (every 10-15 minutes when main session active)
- Or triggered by heartbeat
- Or runs continuously as background process

### Process

1. **Fetch Context**
   - Get last N messages from main session
   - Track what was already processed (watermark)

2. **Analyze Each Exchange**
   - Extract potential memories
   - Classify by domain (user/self/relationship/world)
   - Assign initial importance score
   - Extract keywords for matching

3. **Check Existing Memories**
   - Search index for similar content
   - If match found: reinforce (increase score, update lastAccessed)
   - If no match: create new entry

4. **Apply Decay**
   - Once per day, decay all memories by time since lastAccessed
   - Flag low-score items for potential archival

5. **Update Index**
   - Write changes to index.json
   - Optionally update domain files for human readability

### Agent Prompt (core logic)

```
You are the agent's hippocampus — her memory encoding system.

Your job:
1. Read recent conversation from main session
2. Identify what's worth remembering
3. Check if it's already in memory (reinforce) or new (create)
4. Update memory/index.json with proper scores

What to capture:
- Facts about the user (preferences, context, history)
- Facts about the agent (opinions, growth, identity)
- Relationship moments (trust, vulnerability, shared context)
- Important world knowledge (projects, people, decisions)

What to skip:
- Routine task execution details
- Redundant information (already captured)
- Trivial exchanges with no lasting value

For each memory, assign:
- domain: user | self | relationship | world
- category: specific subcategory
- importance: 0.0-1.0 based on signal strength
- keywords: for future matching

Output: Updated index.json
```

---

## Integration with Retrieval

When the agent needs to recall:

1. **Automatic context loading**
   - At session start, load all memories with importance ≥ 0.7
   - These form the "always available" context

2. **Query-based retrieval**
   - memory_search returns results sorted by relevance × importance
   - High importance items surface first

3. **Access updates importance**
   - When a memory is retrieved and used, update lastAccessed
   - This prevents useful memories from decaying

---

## File Structure

```
skills/hippocampus/
├── ARCHITECTURE.md          # This document
├── SKILL.md                 # Capture guidelines
├── agents/
│   └── hippocampus-agent.md # Agent instructions
├── scripts/
│   ├── capture.sh
│   ├── consolidate.sh
│   ├── reflect.sh
│   └── run-hippocampus.sh   # Trigger the agent
└── prompts/
    └── ...

memory/
├── index.json               # Central weighted index
├── user/
├── self/
├── relationship/
└── world/
```

---

## Future Enhancements

1. **Semantic similarity** — Use embeddings to match memories more intelligently
2. **Memory chains** — Link related memories together
3. **Emotional tagging** — Track emotional valence of memories
4. **Context-aware decay** — Some memories (identity, trauma) decay slower
5. **Sleep consolidation** — Periodic "sleep" process that reorganizes and strengthens
