# CoreMemories Specification v1.0

## Overview

CoreMemories is a hierarchical, event-driven memory system for OpenClaw agents that mimics human memory consolidation. It prioritizes **local processing** for privacy and cost, with **optional API enhancement** for higher-quality archive compression.

## Design Principles

1. **Local-first**: All hot/warm/recent processing happens locally (free, private, fast)
2. **Triggered activation**: Memories load only when conversation keywords match
3. **Progressive compression**: Detail fades with age, hooks remain
4. **User-controlled privacy**: Per-memory privacy levels
5. **Token efficiency**: Load only what's needed, when needed

---

## Layer Architecture

### LAYER 1: HOT (Immediate Recall)

#### Flash Sublayer (0-48 hours)

**Purpose**: Exact recall of current session
**Format**: Full transcript with timestamps
**Detail**: 100%
**Storage**: `memory/hot/flash/current.json`
**Compression**: None (rule-based truncation only)
**Privacy**: In-memory, session-only
**Token Budget**: ~800 tokens (10-15 items)

```json
{
  "window": "rolling-48h",
  "entries": [
    {
      "id": "msg_001",
      "timestamp": "2026-02-02T18:30:00Z",
      "speaker": "user",
      "content": "exact message",
      "emotional_markers": ["excited", "curious"],
      "linked_to": ["msg_000"]
    }
  ]
}
```

#### Warm Sublayer (2-7 days)

**Purpose**: Recent context without full detail
**Format**: Summaries + key quotes
**Detail**: 80%
**Storage**: `memory/hot/warm/week-current.json`
**Compression**: Rule-based (local regex/patterns)
**Privacy**: Local file, plaintext
**Token Budget**: ~600 tokens (15-20 items)

```json
{
  "week": "2026-W05",
  "entries": [
    {
      "id": "mem_001",
      "timestamp": "2026-02-01T14:00:00Z",
      "summary": "Configured system APIs",
      "key_quotes": ["This needs to be remembered"],
      "emotional_tone": "focused",
      "keywords": ["api", "configuration", "system"],
      "linked_to": ["mem_000"]
    }
  ]
}
```

**Compression Rules (Rule-Based)**:

- Keep: User instructions, corrections, decisions
- Summarize: General conversation
- Drop: Tool outputs, status messages, filler
- Extract: Exact quotes where user said "remember this"

---

### LAYER 2: RECENT (Short-term)

All recent layers use **local LLM** (Phi-3 3.8B or Llama 3.2 3B) for compression.

#### Week 1 Sublayer (7-14 days)

**Format**: Hook + 3 key points
**Detail**: 50%
**Storage**: `memory/recent/week-1/2026-02-02.json`
**Compression**: Local LLM
**Privacy**: Local file
**Trigger**: Keyword match or "last week"

```json
{
  "period": "week-1",
  "entries": [
    {
      "id": "mem_100",
      "timestamp": "2026-01-28T10:00:00Z",
      "hook": "Designed hierarchical memory system with the team",
      "key_points": [
        "3-layer architecture (Hot/Recent/Archive)",
        "Age-based compression (48h/7d/weekly)",
        "Local-first with optional API"
      ],
      "keywords": ["memory", "design", "coreMemories"],
      "emotional_salience": 0.9,
      "linked_to": ["mem_050"],
      "full_reference": "memory/archive/2026/01/28-full.json"
    }
  ]
}
```

#### Week 2 Sublayer (14-21 days)

**Format**: Hook + 2 key points
**Detail**: 40%
**Compression**: Local LLM

#### Week 3 Sublayer (21-28 days)

**Format**: Hook + 1 key point
**Detail**: 30%
**Compression**: Local LLM

#### Week 4 Sublayer (28-48 days)

**Format**: Hook only + reconstruction path
**Detail**: 20%
**Compression**: Local LLM

---

### LAYER 3: ARCHIVE (Long-term)

Archive layers support **optional API enhancement** for higher-quality compression.

#### Fresh Archive (1-3 months)

**Format**: Hook + key details + active links
**Detail**: 15%
**Storage**: `memory/archive/fresh/2026-02/`
**Compression**: Local LLM (default), GPT-4o-mini (optional)
**Trigger**: Deep search or link chain

#### Mature Archive (3-6 months)

**Format**: Hook + 3 bullets + weak links
**Detail**: 8%
**Compression**: Local LLM (default), GPT-4o-mini (optional)

#### Deep Archive (6-12 months)

**Format**: Hook + reconstruction path
**Detail**: 3%
**Compression**: GPT-4o-mini (recommended), Local LLM (fallback)

#### Core Archive (1+ years)

**Format**: Single sentence + date
**Detail**: 1%
**Compression**: GPT-4o-mini (recommended), Local LLM (fallback)

---

## Local LLM Integration

### Default: Ollama (Recommended)

```bash
# Install Ollama
curl -fsSL https://ollama.com/install.sh | sh

# Pull lightweight models
ollama pull phi3:mini
ollama pull llama3.2:3b
```

### Configuration

```json
{
  "coreMemories": {
    "localLLM": {
      "provider": "ollama",
      "model": "phi3:mini",
      "endpoint": "http://localhost:11434",
      "timeout": 30000
    },
    "apiEnhancement": {
      "enabled": false,
      "provider": "openai",
      "model": "gpt-4o-mini",
      "apiKey": null
    }
  }
}
```

### Compression Prompts (Local LLM)

**Warm → Recent Week 1**:

```
Summarize this conversation into:
1. One sentence hook
2. Three key points
3. Five keywords
4. Emotional tone (0-1 scale)

Conversation:
{{input}}

Output as JSON:
{
  "hook": "...",
  "key_points": ["...", "...", "..."],
  "keywords": ["...", "...", "...", "...", "..."],
  "emotional_salience": 0.8
}
```

**Archive Compression (with API)**:

```
Extract the essence of this memory. What matters for future retrieval?
- One sentence that triggers full recall
- Key facts that must not be lost
- Keywords for indexing

{{input}}
```

---

## Privacy Levels

### Level 1: Public

- Normal conversations
- General knowledge
- Project details
- **Storage**: Plaintext, all layers

### Level 2: Private

- Personal details
- Credentials (without values)
- Health/family topics
- **Storage**: Encrypted content, plaintext keywords/index

### Level 3: Secret

- Passwords, API keys
- Sensitive personal info
- Legal/medical details
- **Storage**: Encrypted, decrypt only on explicit request

### Encryption

```typescript
// Simple AES-256 for Private/Secret layers
// Key derived from user password or system key
// Keywords remain searchable (plaintext)

interface EncryptedMemory {
  encrypted_content: string; // AES-256-GCM
  iv: string;
  keywords: string[]; // Plaintext for indexing
  privacy_level: "private" | "secret";
}
```

---

## Activation & Retrieval

### Default Session Start

Load (in order):

1. SOUL.md (identity) — always
2. Flash (last 48h) — always
3. Warm (2-7 days) — always
4. Session context — always

**Total**: ~1500-1800 tokens

### Triggered Loading

```
User says: "Remember when we..."
         ↓
Parse for keywords
         ↓
Check Flash → Match? → Use immediately
         ↓ No
Check Warm → Match? → Load to context
         ↓ No
Search Recent Index → Match? → Load layer
         ↓ No
Deep Archive Search → Match? → Reconstruct
         ↓ No
Ask user: "Tell me more about..."
```

### Link Following (The "Digging")

When retrieving a memory, follow links:

- **Strong links**: Bidirectional, same topic
- **Weak links**: Unidirectional, related topic
- **Max depth**: 3 hops (prevents infinite chains)

```typescript
function digMemory(startId: string, depth: number = 0): Memory[] {
  if (depth > 3) return [];

  const memory = loadMemory(startId);
  const chain = [memory];

  for (const link of memory.linked_to) {
    chain.push(...digMemory(link.id, depth + 1));
  }

  return chain;
}
```

---

## Compression Schedule

### Every 6 Hours (Heartbeat)

- Flash → Warm: Entries >48h old
- Warm → Recent Week 1: Entries >7d old
- Cascade Recent Weeks (7 days each)

### Every 24 Hours

- Recent Week 4 → Fresh Archive: Entries >28d old
- Update index with new keywords

### Every 7 Days

- Archive compression (if API enabled)
- Merge similar keywords
- Prune orphaned memories

---

## Token Budgets

| Layer   | Max Tokens | Max Items | Load Strategy    |
| ------- | ---------- | --------- | ---------------- |
| Flash   | 800        | 15        | Always           |
| Warm    | 600        | 20        | Always           |
| Week 1  | 400        | 10        | Triggered        |
| Week 2  | 300        | 10        | Triggered        |
| Week 3  | 200        | 10        | Triggered        |
| Week 4  | 150        | 10        | Triggered        |
| Archive | Variable   | Unlimited | Deep search only |

**Max Load**: ~2300 tokens (vs 2200 always loaded before)
**Typical Load**: ~1500 tokens (Flash + Warm + SOUL)

---

## File Structure

```
memory/
├── index.json                    # Keyword → location mapping
├── hot/
│   ├── flash/
│   │   └── current.json          # Rolling 48h (session-only)
│   └── warm/
│       └── week-current.json     # Rolling 7d
├── recent/
│   ├── week-1/
│   │   └── 2026-02-02.json
│   ├── week-2/
│   ├── week-3/
│   └── week-4/
├── archive/
│   ├── fresh/                    # 1-3 months
│   │   └── 2026-02/
│   ├── mature/                   # 3-6 months
│   ├── deep/                     # 6-12 months
│   └── core/                     # 1+ years
└── keys/                         # Encryption keys (if enabled)
    └── master.key
```

---

## Migration from Existing Memory System

1. Parse MEMORY.md → Create Flash entries
2. Parse daily files → Create Warm entries
3. Extract keywords → Build index
4. Compress older entries → Move to Recent layers
5. Archive entries >1 month → Deep Archive

---

## Configuration Example

```json
{
  "agents": {
    "defaults": {
      "coreMemories": {
        "enabled": true,
        "localLLM": {
          "provider": "ollama",
          "model": "phi3:mini",
          "endpoint": "http://localhost:11434"
        },
        "apiEnhancement": {
          "enabled": false,
          "provider": "openai",
          "model": "gpt-4o-mini",
          "apiKey": null
        },
        "privacy": {
          "defaultLevel": "public",
          "encryptionKeyPath": null
        },
        "limits": {
          "flashMaxItems": 15,
          "warmMaxItems": 20,
          "maxTokenBudget": 2500
        }
      }
    }
  }
}
```

---

## Success Metrics

- **Retrieval accuracy**: >90% for Flash/Warm, >70% for Recent
- **Token efficiency**: 30-40% reduction vs loading full MEMORY.md
- **Response time**: <500ms for Flash/Warm, <2s for Recent
- **Privacy**: Zero external API calls for sensitive memories (if local-only)

---

## Future Enhancements (v2.0)

- Vector embeddings for semantic search
- Cross-session memory sharing
- User-facing memory browser UI
- Automatic topic clustering
- Memory strength decay simulation

---

## Open Questions

1. Should we auto-detect sensitive content for privacy levels?
2. How aggressive should link auto-creation be?
3. Should memories be shared across agent sessions?
4. What's the eviction policy when token budget exceeded?

---

_Specification Version: 1.0_
_Last Updated: 2026-02-02_
_Status: Ready for Review_
