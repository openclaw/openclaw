## Summary

Propose integrating a dual-brain memory architecture (SQLite + LanceDB) with advanced features like importance scoring, time decay, emotional analysis, and associative memory into OpenClaw's memory system.

## Problem

OpenClaw has a robust memory system with multiple backends (Builtin, QMD, Honcho), but there are several enhancement requests that could benefit from a more advanced memory architecture:

1. **Multi-Slot Memory Architecture** (#60572) - Need purpose-specific memory slots
2. **Memory importance scoring + time decay** (#57307) - Need importance-based retrieval
3. **Palace-style structured memory** (#62488) - Need hierarchical memory organization

Current limitations:
- Flat memory structure lacks hierarchical organization
- No importance scoring or time decay for long-term memory
- Limited support for associative memory and emotional analysis
- Single memory slot forces all-or-nothing choices

## Proposed Solution

### Dual-Brain Memory Architecture

Inspired by human brain's left-right hemisphere specialization:

**Left Brain (SQLite) - Structured Memory**
- Facts, events, preferences, decisions
- Structured queries and exact matches
- Importance scoring (1-10)
- Time decay based on access frequency
- Category and tag-based organization

**Right Brain (LanceDB) - Vector Memory**
- Semantic associations and patterns
- Vector similarity search
- Cross-domain connections
- Contextual retrieval
- Multi-modal support (text, images, audio)

### Key Features

1. **Importance Scoring**
   - Automatic 1-10 scoring at write time
   - Weibull time decay (half-life configurable)
   - Access boost on recall
   - Importance-weighted retrieval

2. **Time Decay**
   ```python
   def decay_importance(original, days_since_update, days_since_access):
       half_life = 14  # configurable
       decay = math.exp(-0.693 * (days_since_update / half_life) ** 1.5)
       access_boost = 1.0 if days_since_access < 3 else 0.8 if days_since_access < 7 else 0.5
       return max(1, round(original * decay * access_boost))
   ```

3. **Emotional Analysis**
   - Sentiment polarity (positive/negative/neutral)
   - Emotional intensity
   - Emotional context for memory retrieval

4. **Associative Memory**
   - Memory-to-memory connections
   - Cross-domain associations
   - Pattern recognition
   - Knowledge graph visualization

5. **Hierarchical Organization**
   - Palace-style structure (Wings/Halls)
   - Category-based organization
   - Tag-based filtering
   - Domain-specific retrieval

### Integration with OpenClaw

#### Option 1: New Memory Backend
Create a new memory backend plugin that implements the dual-brain architecture:
- Plugin ID: `memory-dual-brain`
- Slot: `plugins.slots.memory` (or new `memory.dualBrain` slot)
- Compatible with existing `memory_search` and `memory_get` tools

#### Option 2: Enhancement to Existing Backends
Enhance the builtin memory backend with:
- Importance scoring and time decay
- Hierarchical organization support
- Associative memory features
- Emotional analysis

#### Option 3: Multi-Slot Integration
Leverage the multi-slot architecture proposal (#60572):
- `memory.recall` - Dual-brain semantic search
- `memory.compaction` - Importance-aware context management
- `memory.capture` - Auto-classification into Palace structure
- `memory.userModel` - Emotional and preference tracking

### Database Schema

#### SQLite (Left Brain)
```sql
CREATE TABLE memories (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,  -- 'fact', 'event', 'preference', 'decision'
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    category TEXT,
    tags TEXT,  -- JSON array
    importance INTEGER DEFAULT 5,  -- 1-10
    created_at TIMESTAMP,
    updated_at TIMESTAMP,
    last_accessed_at TIMESTAMP,
    access_count INTEGER DEFAULT 0,
    emotional_polarity REAL,  -- -1.0 to 1.0
    emotional_intensity REAL  -- 0.0 to 1.0
);

CREATE TABLE associations (
    id TEXT PRIMARY KEY,
    source_id TEXT NOT NULL,
    target_id TEXT NOT NULL,
    strength REAL DEFAULT 0.5,  -- 0.0 to 1.0
    type TEXT,  -- 'semantic', 'temporal', 'causal'
    created_at TIMESTAMP,
    FOREIGN KEY (source_id) REFERENCES memories(id),
    FOREIGN KEY (target_id) REFERENCES memories(id)
);
```

#### LanceDB (Right Brain)
```python
# Vector tables for semantic search
memories = db.create_table("memories", schema=[
    ("id", str),
    ("content", str),
    ("embedding", np.array),  # vector embedding
    ("category", str),
    ("tags", list),
    ("importance", int),
    ("emotional_polarity", float),
    ("emotional_intensity", float),
    ("created_at", str),
])

thoughts = db.create_table("thoughts", schema=[
    ("id", str),
    ("content", str),
    ("embedding", np.array),
    ("memory_ids", list),  -- associated memories
    ("created_at", str),
])

associations = db.create_table("associations", schema=[
    ("id", str),
    ("source_id", str),
    ("target_id", str),
    ("embedding", np.array),
    ("strength", float),
    ("type", str),
    ("created_at", str),
])
```

### API Design

```typescript
// Memory storage
interface MemoryStore {
  store(memory: Memory): Promise<string>;
  retrieve(query: MemoryQuery): Promise<Memory[]>;
  update(id: string, updates: Partial<Memory>): Promise<void>;
  delete(id: string): Promise<void>;
}

// Importance scoring
interface ImportanceScorer {
  score(content: string): Promise<number>;  // 1-10
  decay(id: string): Promise<number>;
  boost(id: string): Promise<void>;
}

// Emotional analysis
interface EmotionalAnalyzer {
  analyze(content: string): Promise<EmotionalState>;
}

// Associative memory
interface AssociativeMemory {
  findAssociations(id: string): Promise<Association[]>;
  createAssociation(source: string, target: string, strength: number): Promise<void>;
  findRelated(query: string): Promise<Memory[]>;
}
```

## Alternatives Considered

1. **Use existing QMD backend** - QMD is powerful but doesn't have built-in importance scoring or emotional analysis
2. **Use Honcho for user modeling** - Honcho focuses on user preferences, not general memory architecture
3. **Implement as external overlay** - Works but lacks integration with OpenClaw's memory tools

## Impact

### Benefits
- **Better retrieval quality** - Importance-weighted search returns more relevant results
- **Long-term memory management** - Time decay prevents memory bloat
- **Richer context** - Emotional analysis provides context for memory retrieval
- **Better organization** - Hierarchical structure improves navigation
- **Associative thinking** - Cross-domain connections enable creative insights

### Affected Users
- All users with long-running assistants (months of accumulated memory)
- Users who need structured memory organization
- Users who want importance-based retrieval

### Migration Path
- Backward compatible with existing MEMORY.md and memory/*.md files
- Gradual migration to dual-brain architecture
- Configurable opt-in for new features

## Evidence/Examples

I've implemented this architecture in my local OpenClaw workspace with the following results:

- **268 memories** stored in SQLite database
- **Vector search** via LanceDB for semantic retrieval
- **Importance scoring** with automatic decay
- **Emotional analysis** for context-aware retrieval
- **Associative memory** with knowledge graph visualization

Performance:
- SQLite queries: <10ms for typical queries
- Vector search: <50ms for semantic search
- Importance decay: O(1) per memory entry
- Association finding: <100ms for related memories

## Additional Information

### Dependencies
- SQLite (already in OpenClaw)
- LanceDB (new dependency, ~50MB)
- Optional: Ollama for local embeddings

### Configuration
```json5
{
  agents: {
    defaults: {
      memorySearch: {
        provider: "dual-brain",
        dualBrain: {
          leftBrain: {
            path: "~/.openclaw/memory/xiaozhi_memory.db",
            importance: {
              halfLife: 14,  // days
              minImportance: 1,
              maxImportance: 10,
            },
          },
          rightBrain: {
            path: "~/.openclaw/memory/lancedb",
            embeddingProvider: "openai",
          },
          emotional: {
            enabled: true,
            polarityThreshold: 0.3,
          },
          associations: {
            enabled: true,
            minStrength: 0.3,
          },
        },
      },
    },
  },
}
```

### Backward Compatibility
- Existing MEMORY.md and memory/*.md files remain valid
- Can import existing memories into dual-brain architecture
- Gradual migration path for existing users

## Next Steps

1. **Community feedback** - Gather feedback on this proposal
2. **Prototype implementation** - Create a proof-of-concept plugin
3. **Integration testing** - Test with existing OpenClaw memory tools
4. **Documentation** - Write comprehensive documentation
5. **Performance testing** - Benchmark against existing backends

## References

- Multi-Slot Memory Architecture (#60572)
- Memory importance scoring + time decay (#57307)
- Palace-style structured memory (#62488)
- Cognitive Memory Layer (#52532)
- memory-nexo: Cognitive memory backend (#52974)
- Built-in Adaptive Memory (#59095)

---

**Contributor**: Erbing (717986230)
**Experience**: 2 PRs submitted to OpenClaw (#65669, #65675)
**Implementation**: Dual-brain memory architecture running in local workspace
