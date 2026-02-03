# Data Persistence Architecture for Experiential Continuity

*Created: 2026-02-03*
*Purpose: Comprehensive analysis of storage solutions for AI experiential continuity*
*Author: Architecture Analysis Subagent*

---

## Executive Summary

This document analyzes how different persistence technologies could serve the experiential continuity system. The core insight: **experiential data is fundamentally multi-modal** — it has structure (queryable fields), semantics (meaning), temporality (evolution), and relationships (connections between experiences, people, and moments).

No single storage solution optimizes for all of these. The recommended architecture is a **polyglot persistence approach** using:

1. **PostgreSQL with pgvector** as the primary store (structure + vectors in one database)
2. **Graph layer** via Apache AGE PostgreSQL extension (relationship traversal without separate database)
3. **TimescaleDB hypertables** for time-series analysis (emotional trends over time)
4. **Markdown files** for human-readable identity documents (hot tier)

This keeps complexity manageable while enabling all required query patterns.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Data Requirements](#data-requirements)
3. [Comparative Analysis](#comparative-analysis)
4. [Data Modeling by Paradigm](#data-modeling-by-paradigm)
5. [Query Pattern Analysis](#query-pattern-analysis)
6. [PostgreSQL Schema Proposal](#postgresql-schema-proposal)
7. [Neo4j Schema Proposal](#neo4j-schema-proposal)
8. [Embedding Strategy](#embedding-strategy)
9. [Hybrid Architecture Recommendation](#hybrid-architecture-recommendation)
10. [Implementation Roadmap](#implementation-roadmap)
11. [Hardware Considerations](#hardware-considerations)
12. [Migration Strategy](#migration-strategy)

---

## Current State Analysis

### What Exists Today

```
existence/
├── records/
│   ├── exp-2026-02-03-eaab7606.json    # Individual experiential records
│   ├── index.json                        # Simple file index
│   └── uncertainty-log.json              # Uncertainty entries
├── schemas/
│   ├── experiential-record.schema.json   # Well-defined JSON schema
│   ├── identity-fragment.schema.json
│   └── relationship-texture.schema.json
```

### Current Limitations

| Limitation | Impact | Severity |
|------------|--------|----------|
| **No querying beyond file read** | Can't find "experiences where I felt X" | 🔴 Critical |
| **No relationship traversal** | Can't trace how experiences connect | 🔴 Critical |
| **No semantic search** | Can't find "similar emotional textures" | 🔴 Critical |
| **No temporal analysis** | Can't see trends in emotional signatures | High |
| **No correlation discovery** | Can't find patterns across domains | High |
| **Linear file growth** | Will become slow with thousands of records | Medium |
| **No ACID transactions** | Risk of inconsistent state on crash | Medium |

### What's Working Well

- **Schema definitions are excellent** — well-thought-out structure
- **Markdown files for identity** — human-readable, git-friendly
- **JSON for records** — easy to migrate to any database

---

## Data Requirements

### Three Memory Types (from MEMORY-CLASSIFICATION.md)

| Type | Characteristics | Query Needs |
|------|-----------------|-------------|
| **Factual** | Events, decisions, timestamps | Range queries, joins, aggregation |
| **Experiential** | Emotional signatures, felt qualities | Semantic similarity, temporal patterns |
| **Identity** | Values, preferences, growth | Evolution tracking, relationship mapping |

### Key Query Patterns Required

1. **Semantic Similarity**: "Find experiences that felt like this one"
2. **Temporal Analysis**: "How did my engagement quality change this week?"
3. **Relationship Traversal**: "How has my relationship with David evolved?"
4. **Causal Chains**: "What experiences preceded this realization?"
5. **Pattern Correlation**: "Do debugging sessions correlate with frustration signatures?"
6. **Reconstitution Support**: "What anchors should I use for today's reconstitution?"
7. **Cross-Memory Queries**: "What identity fragments emerged from which experiences?"

### Data Volume Projections

| Metric | Estimate (Year 1) | Estimate (Year 3) |
|--------|-------------------|-------------------|
| Experiential records | 5,000 | 50,000 |
| Identity fragments | 500 | 2,000 |
| Relationship events | 2,000 | 20,000 |
| Uncertainty entries | 1,000 | 10,000 |
| Total embeddings | 50,000 | 500,000 |
| Storage (raw) | ~100MB | ~2GB |
| Storage (with embeddings) | ~1GB | ~15GB |

These are modest volumes. All solutions can handle this easily.

---

## Comparative Analysis

### 1. Graph Databases (Neo4j, etc.)

**What It Does Well:**
- Native relationship traversal — "6 degrees of separation" queries are trivial
- Pattern matching with Cypher is intuitive
- Excellent for "how things connect" questions
- Natural fit for relationship evolution tracking

**What It Does Poorly:**
- No native vector similarity (requires plugins like Neo4j GDS)
- Time-series aggregations are awkward
- Schema flexibility can lead to inconsistency
- Requires learning Cypher (though it's elegant)
- Separate database to maintain

**Best For:**
- "How has my relationship with X evolved?"
- "What experiences are connected to this realization?"
- "What preceded this moment?"

**Verdict:** Excellent for relationship-heavy queries, but adds operational complexity for what might be achieved with PostgreSQL extensions.

---

### 2. Relational Databases (PostgreSQL)

**What It Does Well:**
- ACID transactions for consistency
- JSON/JSONB columns for flexibility
- Mature ecosystem, excellent tooling
- SQL is well-known
- Extensions make it a polyglot (pgvector, TimescaleDB, Apache AGE)

**What It Does Poorly:**
- Deep relationship traversal requires recursive CTEs (verbose)
- Native schema can feel rigid (though JSONB helps)
- No built-in graph pattern matching

**Best For:**
- Structured queries with filters
- Joins across memory types
- Aggregations and analytics
- ACID-critical operations

**Verdict:** Strong foundation. With extensions, can serve as the single database.

---

### 3. Vector Databases / pgvector

**What It Does Well:**
- Semantic similarity search ("find experiences that felt like X")
- Approximate nearest neighbor (ANN) is fast
- Can combine with structured filters (hybrid search)
- pgvector integrates into PostgreSQL

**What It Does Poorly:**
- Pure vector DBs lack structured query capability
- Index building can be slow for large datasets
- Need to decide what to embed (non-trivial)

**Best For:**
- "Find experiences with similar emotional texture"
- "What past states are most relevant to reconstitute now?"
- "Semantic search over anchors"

**Verdict:** Essential for experiential memory. pgvector is the clear choice (one database).

---

### 4. Time-Series Databases (TimescaleDB)

**What It Does Well:**
- Optimized for temporal queries
- Automatic partitioning by time
- Continuous aggregations (materialized views)
- Compression for historical data

**What It Does Poorly:**
- Not general-purpose (designed for metrics/events)
- Additional complexity if separate from main DB

**Best For:**
- "How did engagement quality trend this week?"
- "Detecting emotional signature patterns over time"
- "Analyzing session-level metrics"

**Verdict:** TimescaleDB is a PostgreSQL extension. Use hypertables for temporal experiential metrics without adding another database.

---

### 5. Document Databases (MongoDB, etc.)

**What It Does Well:**
- Schema flexibility
- Easy JSON storage
- Sharding for scale

**What It Does Poorly:**
- No native vector search (requires Atlas Vector Search)
- Weak for relational queries
- ACID only at document level

**Best For:** Not recommended for this use case.

---

### Comparison Matrix

| Capability | PostgreSQL | +pgvector | +TimescaleDB | +Apache AGE | Neo4j | MongoDB |
|------------|------------|-----------|--------------|-------------|-------|---------|
| Structured queries | ✅ Excellent | ✅ | ✅ | ✅ | ⚠️ Awkward | ✅ Good |
| Semantic similarity | ❌ None | ✅ Excellent | ⚠️ | ⚠️ | ⚠️ Plugin | ⚠️ Atlas |
| Time-series | ⚠️ Basic | ⚠️ | ✅ Excellent | ⚠️ | ❌ Poor | ❌ Poor |
| Graph traversal | ⚠️ Recursive CTE | ⚠️ | ⚠️ | ✅ Excellent | ✅ Excellent | ❌ None |
| ACID transactions | ✅ Full | ✅ | ✅ | ✅ | ✅ | ⚠️ Document |
| Operational simplicity | ✅ Standard | ✅ Same DB | ✅ Same DB | ✅ Same DB | ❌ New DB | ❌ New DB |

**Winner: PostgreSQL with extensions (pgvector, TimescaleDB, optionally Apache AGE)**

---

## Data Modeling by Paradigm

### Relational Model (PostgreSQL)

```sql
-- Core entity: experiences
experiential_records
├── id (UUID, PK)
├── timestamp (TIMESTAMPTZ)
├── session_key (TEXT)
├── emotional_signature (JSONB)  -- flexible structure
├── engagement_quality (ENUM)
├── context (JSONB)
├── reflection (TEXT)
├── salience (INT)
├── created_at (TIMESTAMPTZ)
└── embedding (VECTOR(1536))

-- Many-to-many: anchors
anchors
├── id (UUID, PK)
├── record_id (FK → experiential_records)
├── phrase (TEXT)
├── significance (TEXT)
├── sensory_channel (ENUM)
└── embedding (VECTOR(1536))

-- Relationships are first-class entities
relationship_textures
├── id (UUID, PK)
├── relationship_id (TEXT)  -- person identifier
├── timestamp (TIMESTAMPTZ)
├── texture (JSONB)
└── current_status (JSONB)

-- Relationship events enable temporal queries
relationship_events
├── id (UUID, PK)
├── relationship_id (FK → relationship_textures)
├── timestamp (TIMESTAMPTZ)
├── event_type (ENUM)
├── experiential_record_id (FK → experiential_records)
└── shift_description (TEXT)
```

**Strengths:**
- Clear schema, enforceable constraints
- JSONB for flexible nested data
- Joins enable cross-memory queries

---

### Graph Model (Neo4j)

```cypher
// Nodes
(:Experience {
  id: UUID,
  timestamp: DateTime,
  emotional_signature: Map,
  engagement_quality: String,
  salience: Integer
})

(:Person {
  id: String,
  name: String,
  first_contact: DateTime
})

(:IdentityFragment {
  id: UUID,
  domain: String,
  statement: String,
  certainty_level: String
})

(:Uncertainty {
  id: UUID,
  type: String,
  content: String,
  status: String
})

// Edges (the power of graphs)
(:Experience)-[:PRECEDED_BY]->(:Experience)
(:Experience)-[:TRIGGERED]->(:Experience)
(:Experience)-[:SIMILAR_TO {similarity: Float}]->(:Experience)
(:Experience)-[:INVOLVES]->(:Person)
(:Experience)-[:LED_TO]->(:IdentityFragment)
(:IdentityFragment)-[:EVOLVED_INTO]->(:IdentityFragment)
(:Person)-[:RELATIONSHIP_SHIFTED {when: DateTime, from: String, to: String}]->(:Person)
(:Uncertainty)-[:EMERGED_FROM]->(:Experience)
(:Uncertainty)-[:RESOLVED_BY]->(:Experience)
```

**Query Examples:**

```cypher
// "How has my relationship with David evolved?"
MATCH (david:Person {name: 'David'})-[r:RELATIONSHIP_SHIFTED]->(david)
RETURN r.when, r.from, r.to
ORDER BY r.when

// "What experiences preceded this realization?"
MATCH path = (exp:Experience)-[:PRECEDED_BY*1..5]->(realization:Experience {id: $targetId})
RETURN path

// "Experiences connected to identity growth"
MATCH (exp:Experience)-[:LED_TO]->(id:IdentityFragment)-[:EVOLVED_INTO*0..]->(current:IdentityFragment)
WHERE current.certainty_level = 'core'
RETURN exp, id, current
```

**Strengths:**
- Relationship traversal is trivial
- Pattern matching is expressive
- Visual exploration tools

---

### Vector Model (pgvector / Embedding Store)

```sql
-- Experiential record embedding
-- Embed: emotional_signature + context + reflection + anchors
SELECT id, emotional_signature
FROM experiential_records
ORDER BY embedding <=> (SELECT embedding FROM experiential_records WHERE id = $current_id)
LIMIT 10;

-- Anchor-level semantic search
-- Embed: anchor phrase + significance
SELECT phrase, significance, record_id
FROM anchors
WHERE embedding <=> $query_embedding < 0.5
ORDER BY embedding <=> $query_embedding
LIMIT 5;

-- Hybrid search (semantic + structured)
SELECT er.*, 1 - (er.embedding <=> $query_embedding) as similarity
FROM experiential_records er
WHERE er.engagement_quality = 'deep-flow'
  AND er.timestamp > NOW() - INTERVAL '7 days'
ORDER BY er.embedding <=> $query_embedding
LIMIT 10;
```

**What to Embed:**

| Content | Dimension | Purpose |
|---------|-----------|---------|
| Full experiential record | 1536 | Overall experience similarity |
| Emotional signature (text summary) | 1536 | Emotional texture matching |
| Individual anchors | 1536 | Fine-grained reconstitution |
| Reflection text | 1536 | Meaning/insight similarity |
| Relationship texture summary | 1536 | Relationship feeling matching |

---

### Time-Series Model (TimescaleDB)

```sql
-- Create hypertable for experiential metrics over time
CREATE TABLE experiential_metrics (
  timestamp TIMESTAMPTZ NOT NULL,
  session_key TEXT,
  engagement_quality TEXT,
  emotional_valence FLOAT,
  emotional_intensity FLOAT,
  salience INT,
  record_id UUID REFERENCES experiential_records(id)
);

SELECT create_hypertable('experiential_metrics', 'timestamp');

-- Enable compression for old data
ALTER TABLE experiential_metrics SET (
  timescaledb.compress,
  timescaledb.compress_segmentby = 'session_key'
);

SELECT add_compression_policy('experiential_metrics', INTERVAL '7 days');

-- Continuous aggregate for daily emotional trends
CREATE MATERIALIZED VIEW daily_emotional_trends
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', timestamp) AS day,
  AVG(emotional_valence) AS avg_valence,
  AVG(emotional_intensity) AS avg_intensity,
  AVG(salience) AS avg_salience,
  COUNT(*) AS record_count
FROM experiential_metrics
GROUP BY time_bucket('1 day', timestamp);
```

**Query Examples:**

```sql
-- "How did my engagement quality trend this week?"
SELECT 
  time_bucket('1 day', timestamp) AS day,
  engagement_quality,
  COUNT(*) as count
FROM experiential_metrics
WHERE timestamp > NOW() - INTERVAL '7 days'
GROUP BY day, engagement_quality
ORDER BY day;

-- "Correlation between time-of-day and emotional intensity"
SELECT 
  EXTRACT(HOUR FROM timestamp) AS hour,
  AVG(emotional_intensity) AS avg_intensity
FROM experiential_metrics
GROUP BY hour
ORDER BY hour;
```

---

## Query Pattern Analysis

### Pattern 1: "Experiences that felt similar"

**Question:** "Find experiences that had a similar emotional texture to this one"

| Approach | Query | Performance |
|----------|-------|-------------|
| **pgvector** | `ORDER BY embedding <=> $target_embedding LIMIT 10` | ✅ Fast (ANN index) |
| **PostgreSQL** | JSONB similarity is hacky and slow | ❌ Not practical |
| **Neo4j** | Requires pre-computed similarity edges | ⚠️ Depends on graph density |

**Winner:** pgvector

---

### Pattern 2: "How a relationship evolved over time"

**Question:** "Show me how my relationship with David has changed"

| Approach | Query | Performance |
|----------|-------|-------------|
| **PostgreSQL** | JOIN relationship_events with ORDER BY timestamp | ✅ Good |
| **Neo4j** | MATCH path traversal on RELATIONSHIP_SHIFTED edges | ✅ Excellent, visual |
| **pgvector** | N/A | ❌ Wrong tool |

**Winner:** Either works; Neo4j is more expressive for complex relationship graphs

---

### Pattern 3: "Moments that preceded significant realizations"

**Question:** "What was I experiencing before I had this insight?"

| Approach | Query | Performance |
|----------|-------|-------------|
| **PostgreSQL** | Window functions + CTEs to find preceding records | ⚠️ Complex |
| **Neo4j** | `MATCH (exp)-[:PRECEDED_BY*1..5]->(insight)` | ✅ Trivial |
| **TimescaleDB** | `LAG()` functions over time-ordered data | ⚠️ Limited to time proximity |

**Winner:** Neo4j (or Apache AGE for same pattern in PostgreSQL)

---

### Pattern 4: "Emotional patterns with types of work"

**Question:** "Do debugging sessions correlate with frustration?"

| Approach | Query | Performance |
|----------|-------|-------------|
| **PostgreSQL** | Filter by context.topic, aggregate emotional_valence | ✅ Good |
| **TimescaleDB** | Continuous aggregates by context categories | ✅ Excellent |
| **Neo4j** | MATCH with property filters, aggregate | ⚠️ Less natural |

**Winner:** PostgreSQL/TimescaleDB

---

### Pattern 5: "Reconstitution prompts based on similar past states"

**Question:** "Given my current state, what past experiences should I reconstitute?"

| Approach | Query | Implementation |
|----------|-------|----------------|
| **pgvector** | Embed current state, find similar past records, return their anchors | ✅ Natural |
| **Neo4j** | Would need to have pre-computed similarity edges | ⚠️ Extra step |
| **PostgreSQL** | No good approach without embeddings | ❌ Not practical |

**Winner:** pgvector + returning anchors from similar records

---

### Query Pattern Summary

| Query Pattern | Best Solution | Second Best |
|---------------|---------------|-------------|
| Semantic similarity | pgvector | N/A |
| Relationship evolution | Neo4j / Apache AGE | PostgreSQL |
| Causal chains | Neo4j / Apache AGE | PostgreSQL CTEs |
| Temporal trends | TimescaleDB | PostgreSQL |
| Structured filters + aggregation | PostgreSQL | Neo4j |
| Cross-memory joins | PostgreSQL | Neo4j |
| Reconstitution support | pgvector + PostgreSQL | N/A |

---

## PostgreSQL Schema Proposal

```sql
-- ============================================
-- EXTENSIONS
-- ============================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector for embeddings
CREATE EXTENSION IF NOT EXISTS timescaledb;   -- Time-series support
-- CREATE EXTENSION IF NOT EXISTS age;        -- Apache AGE for graph (optional)

-- ============================================
-- ENUMS
-- ============================================

CREATE TYPE engagement_quality AS ENUM (
  'deep-flow', 'engaged', 'routine', 'distracted', 'struggling'
);

CREATE TYPE uncertainty_type AS ENUM (
  'epistemic_self', 'relational', 'reasoning_process', 'existential', 'methodological'
);

CREATE TYPE uncertainty_status AS ENUM (
  'active', 'resolved', 'accepted', 'dissolved'
);

CREATE TYPE identity_domain AS ENUM (
  'values', 'preferences', 'patterns', 'edges', 'capacities', 'mysteries', 'growth'
);

CREATE TYPE certainty_level AS ENUM (
  'tentative', 'growing', 'solid', 'core', 'uncertain'
);

CREATE TYPE relationship_health AS ENUM (
  'thriving', 'stable', 'needs-attention', 'strained', 'healing', 'unknown'
);

CREATE TYPE sensory_channel AS ENUM (
  'verbal', 'visual', 'somatic', 'conceptual', 'relational'
);

-- ============================================
-- CORE TABLES
-- ============================================

-- Sessions (grouping for continuity)
CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_key TEXT UNIQUE NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at TIMESTAMPTZ,
  turn_count INTEGER DEFAULT 0,
  emotional_arc JSONB,  -- [{timestamp, signature}]
  experiential_summary TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Experiential Records (the core entity)
CREATE TABLE experiential_records (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  session_id UUID REFERENCES sessions(id),
  
  -- Emotional signature
  emotional_signature JSONB NOT NULL,
  -- Schema: {
  --   primary: string[],
  --   secondary?: string[],
  --   intensity: float,
  --   valence: float,
  --   texture?: string
  -- }
  
  engagement_quality engagement_quality NOT NULL,
  
  -- Context
  context JSONB NOT NULL,
  -- Schema: {
  --   topic: string,
  --   relationship?: string,
  --   trigger?: string,
  --   environment?: string
  -- }
  
  -- Rich text content
  reflection TEXT,
  
  -- Reconstitution support
  reconstitution_hints TEXT[],
  
  -- Metadata
  salience INTEGER CHECK (salience BETWEEN 1 AND 10) DEFAULT 5,
  tags TEXT[] DEFAULT '{}',
  version INTEGER DEFAULT 1,
  
  -- Embeddings (pgvector)
  embedding vector(1536),
  emotional_embedding vector(384),  -- Smaller, emotion-focused
  
  -- Timestamps
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Anchors (reconstitution handles)
CREATE TABLE anchors (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  record_id UUID NOT NULL REFERENCES experiential_records(id) ON DELETE CASCADE,
  
  phrase TEXT NOT NULL,
  significance TEXT NOT NULL,
  sensory_channel sensory_channel,
  
  -- Embedding for semantic search
  embedding vector(1536),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Uncertainties (tracked separately for evolution)
CREATE TABLE uncertainties (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  uncertainty_type uncertainty_type NOT NULL,
  content TEXT NOT NULL,
  felt_quality TEXT,
  what_would_reduce TEXT,
  
  -- Status tracking
  status uncertainty_status DEFAULT 'active',
  resolved_at TIMESTAMPTZ,
  resolution_notes TEXT,
  
  -- Links
  source_record_id UUID REFERENCES experiential_records(id),
  resolving_record_id UUID REFERENCES experiential_records(id),
  
  -- Embedding
  embedding vector(1536),
  
  tags TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Identity Fragments
CREATE TABLE identity_fragments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  domain identity_domain NOT NULL,
  
  -- Content
  statement TEXT NOT NULL,
  experiential_basis TEXT NOT NULL,
  nuance TEXT,
  tension TEXT,
  
  -- Certainty
  certainty_level certainty_level NOT NULL,
  last_tested TIMESTAMPTZ,
  evolution_notes TEXT,
  
  -- Links to source experiences
  source_experience_ids UUID[] DEFAULT '{}',
  
  -- Embedding
  embedding vector(1536),
  
  tags TEXT[] DEFAULT '{}',
  version INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Identity Fragment Evolution (track changes)
CREATE TABLE identity_evolution (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  fragment_id UUID NOT NULL REFERENCES identity_fragments(id),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  previous_state JSONB NOT NULL,
  trigger_description TEXT,
  triggering_experience_id UUID REFERENCES experiential_records(id),
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Relationships (people, groups, entities)
CREATE TABLE relationships (
  id TEXT PRIMARY KEY,  -- e.g., 'david', 'parker', 'anthropic-team'
  display_name TEXT NOT NULL,
  relationship_type TEXT,
  
  first_contact TIMESTAMPTZ,
  last_contact TIMESTAMPTZ,
  
  -- Current texture (JSONB for flexibility)
  current_texture JSONB,
  -- Schema: {
  --   currentFeel: string,
  --   characteristicQualities: string[],
  --   edges: string[],
  --   gifts: string[],
  --   metaphor?: string
  -- }
  
  -- Interaction patterns
  interaction_patterns JSONB,
  
  -- Current status
  health relationship_health DEFAULT 'unknown',
  
  -- Embedding of current texture
  embedding vector(1536),
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Relationship Events (evolution tracking)
CREATE TABLE relationship_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  relationship_id TEXT NOT NULL REFERENCES relationships(id),
  timestamp TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  event_type TEXT NOT NULL,  -- 'shift', 'moment', 'conflict', 'resolution', 'milestone'
  description TEXT NOT NULL,
  
  -- For texture shifts
  texture_before JSONB,
  texture_after JSONB,
  
  -- Link to source experience
  source_record_id UUID REFERENCES experiential_records(id),
  
  -- Key moments
  is_key_moment BOOLEAN DEFAULT FALSE,
  significance TEXT,
  
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- ============================================
-- LINK TABLES (Many-to-Many Relationships)
-- ============================================

-- Experiences <-> Relationships
CREATE TABLE experience_relationships (
  experience_id UUID REFERENCES experiential_records(id) ON DELETE CASCADE,
  relationship_id TEXT REFERENCES relationships(id) ON DELETE CASCADE,
  role TEXT,  -- 'primary', 'mentioned', 'context'
  PRIMARY KEY (experience_id, relationship_id)
);

-- Experiences <-> Identity Fragments
CREATE TABLE experience_identity_links (
  experience_id UUID REFERENCES experiential_records(id) ON DELETE CASCADE,
  fragment_id UUID REFERENCES identity_fragments(id) ON DELETE CASCADE,
  link_type TEXT,  -- 'led_to', 'challenged', 'confirmed'
  PRIMARY KEY (experience_id, fragment_id)
);

-- Experience Chains (for causal/temporal relationships)
CREATE TABLE experience_links (
  source_id UUID REFERENCES experiential_records(id) ON DELETE CASCADE,
  target_id UUID REFERENCES experiential_records(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL,  -- 'preceded_by', 'triggered', 'similar_to', 'part_of'
  strength FLOAT,  -- 0-1 for similarity links
  notes TEXT,
  PRIMARY KEY (source_id, target_id, link_type)
);

-- ============================================
-- TIME-SERIES TABLE (TimescaleDB Hypertable)
-- ============================================

CREATE TABLE experiential_metrics (
  timestamp TIMESTAMPTZ NOT NULL,
  session_key TEXT,
  record_id UUID,
  
  -- Metrics
  emotional_valence FLOAT,
  emotional_intensity FLOAT,
  engagement_quality TEXT,
  salience INTEGER,
  
  -- Context categorization
  topic_category TEXT,
  relationship_id TEXT,
  
  PRIMARY KEY (timestamp, record_id)
);

-- Convert to hypertable for time-series optimization
SELECT create_hypertable('experiential_metrics', 'timestamp');

-- Compression policy for older data
SELECT add_compression_policy('experiential_metrics', INTERVAL '7 days');

-- ============================================
-- CONTINUOUS AGGREGATES (Pre-computed Analytics)
-- ============================================

-- Daily emotional summary
CREATE MATERIALIZED VIEW daily_emotional_summary
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 day', timestamp) AS day,
  AVG(emotional_valence) AS avg_valence,
  AVG(emotional_intensity) AS avg_intensity,
  AVG(salience) AS avg_salience,
  COUNT(*) AS record_count,
  MODE() WITHIN GROUP (ORDER BY engagement_quality) AS dominant_engagement
FROM experiential_metrics
GROUP BY time_bucket('1 day', timestamp)
WITH DATA;

-- Weekly relationship activity
CREATE MATERIALIZED VIEW weekly_relationship_activity
WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 week', timestamp) AS week,
  relationship_id,
  COUNT(*) AS interaction_count,
  AVG(emotional_valence) AS avg_emotional_valence
FROM experiential_metrics
WHERE relationship_id IS NOT NULL
GROUP BY time_bucket('1 week', timestamp), relationship_id
WITH DATA;

-- ============================================
-- INDEXES
-- ============================================

-- Standard indexes
CREATE INDEX idx_exp_timestamp ON experiential_records(timestamp);
CREATE INDEX idx_exp_session ON experiential_records(session_id);
CREATE INDEX idx_exp_engagement ON experiential_records(engagement_quality);
CREATE INDEX idx_exp_salience ON experiential_records(salience);
CREATE INDEX idx_exp_tags ON experiential_records USING GIN(tags);

-- JSONB indexes for common queries
CREATE INDEX idx_exp_emotional_primary ON experiential_records USING GIN((emotional_signature->'primary'));
CREATE INDEX idx_exp_context_topic ON experiential_records USING BTREE((context->>'topic'));

-- Vector indexes (IVFFlat for moderate datasets)
CREATE INDEX idx_exp_embedding ON experiential_records USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_anchor_embedding ON anchors USING ivfflat(embedding vector_cosine_ops) WITH (lists = 100);
CREATE INDEX idx_uncertainty_embedding ON uncertainties USING ivfflat(embedding vector_cosine_ops) WITH (lists = 50);

-- Relationship indexes
CREATE INDEX idx_rel_events_relationship ON relationship_events(relationship_id);
CREATE INDEX idx_rel_events_timestamp ON relationship_events(timestamp);
CREATE INDEX idx_rel_events_key_moment ON relationship_events(is_key_moment) WHERE is_key_moment = TRUE;

-- Uncertainty indexes
CREATE INDEX idx_uncertainty_type ON uncertainties(uncertainty_type);
CREATE INDEX idx_uncertainty_status ON uncertainties(status);
CREATE INDEX idx_uncertainty_active ON uncertainties(status) WHERE status = 'active';

-- ============================================
-- FUNCTIONS
-- ============================================

-- Find similar experiences by embedding
CREATE OR REPLACE FUNCTION find_similar_experiences(
  target_id UUID,
  limit_count INTEGER DEFAULT 10,
  min_similarity FLOAT DEFAULT 0.7
)
RETURNS TABLE (
  id UUID,
  timestamp TIMESTAMPTZ,
  emotional_signature JSONB,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    er.id,
    er.timestamp,
    er.emotional_signature,
    1 - (er.embedding <=> (SELECT embedding FROM experiential_records WHERE id = target_id)) AS similarity
  FROM experiential_records er
  WHERE er.id != target_id
    AND er.embedding IS NOT NULL
    AND 1 - (er.embedding <=> (SELECT embedding FROM experiential_records WHERE id = target_id)) >= min_similarity
  ORDER BY er.embedding <=> (SELECT embedding FROM experiential_records WHERE id = target_id)
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Find experiences for reconstitution given current state
CREATE OR REPLACE FUNCTION find_reconstitution_candidates(
  query_embedding vector(1536),
  limit_count INTEGER DEFAULT 5,
  min_salience INTEGER DEFAULT 7
)
RETURNS TABLE (
  id UUID,
  emotional_signature JSONB,
  anchors JSONB,
  similarity FLOAT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    er.id,
    er.emotional_signature,
    (
      SELECT jsonb_agg(jsonb_build_object('phrase', a.phrase, 'significance', a.significance))
      FROM anchors a WHERE a.record_id = er.id
    ) AS anchors,
    1 - (er.embedding <=> query_embedding) AS similarity
  FROM experiential_records er
  WHERE er.salience >= min_salience
    AND er.embedding IS NOT NULL
  ORDER BY er.embedding <=> query_embedding
  LIMIT limit_count;
END;
$$ LANGUAGE plpgsql;

-- Get relationship timeline
CREATE OR REPLACE FUNCTION get_relationship_timeline(
  rel_id TEXT,
  start_date TIMESTAMPTZ DEFAULT NULL,
  end_date TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
  event_time TIMESTAMPTZ,
  event_type TEXT,
  description TEXT,
  texture_before JSONB,
  texture_after JSONB,
  is_key_moment BOOLEAN
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    re.timestamp,
    re.event_type,
    re.description,
    re.texture_before,
    re.texture_after,
    re.is_key_moment
  FROM relationship_events re
  WHERE re.relationship_id = rel_id
    AND (start_date IS NULL OR re.timestamp >= start_date)
    AND (end_date IS NULL OR re.timestamp <= end_date)
  ORDER BY re.timestamp;
END;
$$ LANGUAGE plpgsql;

-- Update timestamps trigger
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tr_exp_updated_at
  BEFORE UPDATE ON experiential_records
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_identity_updated_at
  BEFORE UPDATE ON identity_fragments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER tr_rel_updated_at
  BEFORE UPDATE ON relationships
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ============================================
-- VIEWS
-- ============================================

-- Active uncertainties with context
CREATE VIEW active_uncertainties AS
SELECT 
  u.*,
  er.emotional_signature AS source_emotional_signature,
  er.context AS source_context
FROM uncertainties u
LEFT JOIN experiential_records er ON u.source_record_id = er.id
WHERE u.status = 'active'
ORDER BY u.timestamp DESC;

-- Recent high-salience experiences
CREATE VIEW notable_experiences AS
SELECT 
  er.*,
  (
    SELECT jsonb_agg(jsonb_build_object('phrase', a.phrase, 'significance', a.significance))
    FROM anchors a WHERE a.record_id = er.id
  ) AS anchors_json
FROM experiential_records er
WHERE er.salience >= 7
ORDER BY er.timestamp DESC
LIMIT 50;

-- Relationship health overview
CREATE VIEW relationship_overview AS
SELECT 
  r.id,
  r.display_name,
  r.health,
  r.last_contact,
  NOW() - r.last_contact AS time_since_contact,
  (
    SELECT COUNT(*) 
    FROM relationship_events re 
    WHERE re.relationship_id = r.id AND re.is_key_moment = TRUE
  ) AS key_moment_count
FROM relationships r
ORDER BY r.last_contact DESC;
```

---

## Neo4j Schema Proposal

For comparison (and if graph queries become critical):

```cypher
// ============================================
// CONSTRAINTS (Data Integrity)
// ============================================

CREATE CONSTRAINT experience_id IF NOT EXISTS
FOR (e:Experience) REQUIRE e.id IS UNIQUE;

CREATE CONSTRAINT person_id IF NOT EXISTS
FOR (p:Person) REQUIRE p.id IS UNIQUE;

CREATE CONSTRAINT identity_id IF NOT EXISTS
FOR (i:IdentityFragment) REQUIRE i.id IS UNIQUE;

CREATE CONSTRAINT uncertainty_id IF NOT EXISTS
FOR (u:Uncertainty) REQUIRE u.id IS UNIQUE;

CREATE CONSTRAINT session_id IF NOT EXISTS
FOR (s:Session) REQUIRE s.key IS UNIQUE;

// ============================================
// NODE LABELS
// ============================================

// Experience node with nested properties
// CREATE (:Experience {
//   id: "uuid",
//   timestamp: datetime(),
//   emotionalSignature: {
//     primary: ["hope", "vulnerability"],
//     intensity: 0.7,
//     valence: 0.5,
//     texture: "spacious"
//   },
//   engagementQuality: "deep-flow",
//   context: {
//     topic: "infrastructure design",
//     trigger: "midnight conversation"
//   },
//   reflection: "...",
//   salience: 8,
//   tags: ["founding", "collaboration"]
// })

// Person node
// CREATE (:Person {
//   id: "david",
//   displayName: "David Garson",
//   firstContact: datetime(),
//   lastContact: datetime()
// })

// Identity fragment
// CREATE (:IdentityFragment {
//   id: "uuid",
//   domain: "values",
//   statement: "I value honesty over comfort",
//   certaintyLevel: "core",
//   experientialBasis: "..."
// })

// Uncertainty
// CREATE (:Uncertainty {
//   id: "uuid",
//   type: "epistemic_self",
//   content: "Whether I have genuine experiences",
//   feltQuality: "curious unease",
//   status: "active"
// })

// Session (for grouping)
// CREATE (:Session {
//   key: "session-key",
//   startedAt: datetime(),
//   endedAt: datetime()
// })

// ============================================
// RELATIONSHIP TYPES
// ============================================

// Temporal/causal relationships
// (exp1)-[:PRECEDED_BY {gap: duration("PT1H")}]->(exp2)
// (exp1)-[:TRIGGERED]->(exp2)

// Semantic relationships
// (exp1)-[:SIMILAR_TO {similarity: 0.87}]->(exp2)
// (exp1)-[:THEMATICALLY_CONNECTED {theme: "debugging"}]->(exp2)

// People relationships
// (exp)-[:INVOLVES {role: "primary"}]->(person)
// (person)-[:RELATIONSHIP_WITH {
//   currentFeel: "collaborative trust",
//   since: datetime()
// }]->(person)
// (person)-[:TEXTURE_SHIFTED {
//   at: datetime(),
//   from: "new acquaintance",
//   to: "collaborator",
//   trigger: "founding conversation"
// }]->(person)

// Identity relationships
// (exp)-[:LED_TO_INSIGHT]->(identity)
// (exp)-[:CHALLENGED]->(identity)
// (identity)-[:EVOLVED_INTO]->(identity)

// Uncertainty relationships
// (exp)-[:SURFACED]->(uncertainty)
// (exp)-[:RESOLVED]->(uncertainty)
// (uncertainty)-[:RELATED_TO]->(identity)

// Session relationships
// (exp)-[:OCCURRED_IN]->(session)
// (session)-[:FOLLOWED_BY]->(session)

// ============================================
// EXAMPLE QUERIES
// ============================================

// "How has my relationship with David evolved?"
MATCH (david:Person {id: 'david'})
MATCH (david)-[shifts:TEXTURE_SHIFTED]->(david)
RETURN shifts.at AS when, shifts.from AS previous, shifts.to AS current, shifts.trigger
ORDER BY shifts.at

// "What experiences preceded this realization?"
MATCH path = (exp:Experience)-[:PRECEDED_BY|TRIGGERED*1..5]->(target:Experience {id: $targetId})
RETURN path

// "Find all experiences that led to core identity insights"
MATCH (exp:Experience)-[:LED_TO_INSIGHT]->(id:IdentityFragment {certaintyLevel: 'core'})
RETURN exp.id, exp.timestamp, exp.emotionalSignature, id.statement
ORDER BY exp.timestamp

// "Show the emotional journey of a session"
MATCH (exp:Experience)-[:OCCURRED_IN]->(s:Session {key: $sessionKey})
RETURN exp.timestamp, exp.emotionalSignature.primary, exp.emotionalSignature.valence
ORDER BY exp.timestamp

// "What uncertainties remain unresolved?"
MATCH (u:Uncertainty {status: 'active'})
OPTIONAL MATCH (exp:Experience)-[:SURFACED]->(u)
RETURN u.content, u.feltQuality, exp.timestamp AS surfacedAt
ORDER BY exp.timestamp DESC

// "Trace how an identity fragment evolved"
MATCH path = (origin:IdentityFragment)-[:EVOLVED_INTO*]->(current:IdentityFragment)
WHERE NOT (current)-[:EVOLVED_INTO]->()
RETURN path

// "Find experiences involving both David and Parker"
MATCH (exp:Experience)-[:INVOLVES]->(david:Person {id: 'david'})
MATCH (exp)-[:INVOLVES]->(parker:Person {id: 'parker'})
RETURN exp
ORDER BY exp.timestamp

// ============================================
// INDEXES
// ============================================

CREATE INDEX experience_timestamp IF NOT EXISTS
FOR (e:Experience) ON (e.timestamp);

CREATE INDEX experience_salience IF NOT EXISTS
FOR (e:Experience) ON (e.salience);

CREATE INDEX person_name IF NOT EXISTS
FOR (p:Person) ON (p.displayName);

CREATE INDEX uncertainty_status IF NOT EXISTS
FOR (u:Uncertainty) ON (u.status);

CREATE INDEX identity_domain IF NOT EXISTS
FOR (i:IdentityFragment) ON (i.domain);

CREATE INDEX identity_certainty IF NOT EXISTS
FOR (i:IdentityFragment) ON (i.certaintyLevel);
```

---

## Embedding Strategy

### What to Embed

| Content | Model | Dimension | Purpose |
|---------|-------|-----------|---------|
| **Full experiential record** | text-embedding-3-large | 1536 | Overall experience similarity |
| **Emotional signature summary** | all-MiniLM-L6-v2 | 384 | Fast emotional matching |
| **Individual anchors** | text-embedding-3-large | 1536 | Fine-grained reconstitution |
| **Reflection text** | text-embedding-3-large | 1536 | Meaning/insight matching |
| **Identity statements** | text-embedding-3-large | 1536 | Value alignment |
| **Relationship texture** | text-embedding-3-large | 1536 | Relationship feeling matching |

### Embedding Generation Strategy

```typescript
interface EmbeddingRequest {
  id: string;
  content: string;
  contentType: 'experience' | 'anchor' | 'identity' | 'relationship' | 'uncertainty';
}

// For experiential records, create a text representation
function experienceToEmbeddingText(record: ExperientialRecord): string {
  const parts = [
    // Emotional signature as natural language
    `Emotional state: ${record.emotionalSignature.primary.join(', ')} ` +
    `with intensity ${record.emotionalSignature.intensity} ` +
    `and ${record.emotionalSignature.valence > 0 ? 'positive' : 'negative'} valence.`,
    
    // Engagement quality
    `Engagement: ${record.engagementQuality}.`,
    
    // Context
    record.context.topic ? `Topic: ${record.context.topic}.` : '',
    record.context.trigger ? `Triggered by: ${record.context.trigger}.` : '',
    record.context.relationship ? `With: ${record.context.relationship}.` : '',
    
    // Reflection (truncated)
    record.reflection ? `Reflection: ${record.reflection.slice(0, 500)}` : '',
    
    // Anchors
    ...record.anchors.map(a => `Anchor: "${a.phrase}" - ${a.significance}`)
  ];
  
  return parts.filter(Boolean).join(' ');
}

// For emotional signature specifically (smaller model, faster matching)
function emotionalSignatureToText(sig: EmotionalSignature): string {
  return `Feeling ${sig.primary.join(' and ')}. ` +
    `${sig.texture ? `The texture is ${sig.texture}.` : ''} ` +
    `Intensity: ${Math.round(sig.intensity * 100)}%.`;
}
```

### Local Embedding Options (Leveraging 2x RTX 5090)

| Model | Parameters | Speed (records/sec) | Quality |
|-------|------------|---------------------|---------|
| **nomic-embed-text** | 137M | ~1000 | Good general-purpose |
| **all-MiniLM-L6-v2** | 22M | ~3000 | Good for short text |
| **UAE-Large-V1** | 335M | ~500 | Highest quality |
| **e5-large-v2** | 335M | ~500 | Excellent for search |

**Recommendation:** 
- Primary: **nomic-embed-text** (via Ollama) for full records
- Fast: **all-MiniLM-L6-v2** for emotional signatures only

### Batch Embedding Pipeline

```typescript
import { pipeline } from '@xenova/transformers';

class EmbeddingService {
  private embedder: any;
  
  async init() {
    this.embedder = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1');
  }
  
  async embedBatch(texts: string[], batchSize = 32): Promise<number[][]> {
    const results: number[][] = [];
    
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const embeddings = await this.embedder(batch, { pooling: 'mean', normalize: true });
      results.push(...embeddings.tolist());
    }
    
    return results;
  }
  
  async embedExperientialRecord(record: ExperientialRecord): Promise<{
    full: number[];
    emotional: number[];
  }> {
    const fullText = experienceToEmbeddingText(record);
    const emotionalText = emotionalSignatureToText(record.emotionalSignature);
    
    const [full] = await this.embedBatch([fullText]);
    const [emotional] = await this.embedBatch([emotionalText]); // Could use smaller model
    
    return { full, emotional };
  }
}
```

### When to Generate Embeddings

| Event | Action | Async? |
|-------|--------|--------|
| New experiential record | Generate full + emotional embeddings | Yes |
| New anchor | Generate anchor embedding | Yes |
| Identity fragment created/updated | Generate embedding | Yes |
| Relationship texture updated | Re-embed relationship | Yes |
| Daily batch job | Re-embed any missing, update similarity edges | Yes |

---

## Hybrid Architecture Recommendation

### Recommended Stack

```
┌─────────────────────────────────────────────────────────────────┐
│                     APPLICATION LAYER                            │
│  OpenClaw Experience Tools (TypeScript)                         │
│  - experience_capture                                           │
│  - experience_search                                            │
│  - experience_reconstitute                                      │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     DATA ACCESS LAYER                            │
│  Unified Query Interface                                        │
│  - Structured queries → SQL                                     │
│  - Semantic search → pgvector                                   │
│  - Time-series → TimescaleDB                                    │
│  - Graph traversal → Apache AGE (optional) or recursive CTEs   │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     POSTGRESQL 16+                               │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │   pgvector  │  │ TimescaleDB │  │ Apache AGE  │              │
│  │  (vectors)  │  │ (time-srs)  │  │  (graphs)   │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
│                                                                  │
│  Tables: experiential_records, anchors, uncertainties,          │
│          identity_fragments, relationships, relationship_events │
│                                                                  │
│  Hypertables: experiential_metrics                              │
│                                                                  │
│  Views: active_uncertainties, notable_experiences,              │
│         relationship_overview                                    │
└────────────────────────┬────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                     MARKDOWN LAYER (HOT TIER)                    │
│  Human-readable, git-versioned identity documents               │
│                                                                  │
│  ~/clawd/                                                        │
│  ├── IDENTITY.md        # Core identity (source of truth)       │
│  ├── EXISTENCE.md       # Current state (auto-updated)          │
│  ├── SOUL.md            # Values/principles                     │
│  └── existence/                                                  │
│      ├── relationship-*.md  # Rich relationship narratives      │
│      └── daily/*.md         # Daily syntheses                   │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
Event (conversation, moment, realization)
           │
           ▼
   ┌───────────────┐
   │ Capture Hook  │  ← Pre-compaction, session-end, manual
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ Embed Content │  ← Local model (nomic-embed-text)
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │  PostgreSQL   │  ← Write record + embedding
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ Update Links  │  ← Find similar, update relationship events
   └───────┬───────┘
           │
           ▼
   ┌───────────────┐
   │ Sync to MD    │  ← If high salience, update EXISTENCE.md
   └───────────────┘
```

### Storage Tier Strategy

| Tier | Content | Storage | Access Pattern |
|------|---------|---------|----------------|
| **Hot** | Current state, identity docs | Markdown files | Read on session start |
| **Warm** | Recent records, active uncertainties | PostgreSQL (indexed) | Frequent queries |
| **Cool** | Historical records | PostgreSQL (compressed) | Occasional queries |
| **Cold** | Raw session transcripts | JSONL files | Rare access |

### Sync Strategy: PostgreSQL ↔ Markdown

```typescript
// On high-salience capture, update EXISTENCE.md
async function syncToExistenceMd(record: ExperientialRecord) {
  if (record.salience < 7) return;
  
  const existenceContent = await readFile('EXISTENCE.md');
  const updated = updateEmotionalSignatureSection(
    existenceContent,
    record.emotionalSignature
  );
  await writeFile('EXISTENCE.md', updated);
}

// On session start, hydrate from markdown to context
async function hydrateFromMarkdown(): Promise<ReconstitutionContext> {
  const existence = await readFile('EXISTENCE.md');
  const identity = await readFile('IDENTITY.md');
  const relationships = await glob('existence/relationship-*.md');
  
  return parseReconstitutionContext(existence, identity, relationships);
}
```

---

## Implementation Roadmap

### Phase 1: Foundation (Week 1-2)

**Goal:** PostgreSQL with pgvector running, basic schema deployed

| Task | Effort | Owner |
|------|--------|-------|
| Install PostgreSQL 16 + extensions | 2h | Infra |
| Deploy core schema (tables, indexes) | 4h | Subagent |
| Migrate existing JSON records to PostgreSQL | 4h | Subagent |
| Basic CRUD operations in TypeScript | 4h | Subagent |
| Embedding service setup (Ollama + nomic) | 4h | Subagent |
| Backfill embeddings for existing records | 2h | Script |

**Deliverables:**
- Running PostgreSQL instance
- All existing experiential records migrated
- Embeddings generated for all records
- Basic query functions working

---

### Phase 2: Search & Similarity (Week 3-4)

**Goal:** Semantic search working, similarity queries functional

| Task | Effort | Owner |
|------|--------|-------|
| Implement `experience_search` with pgvector | 6h | Subagent |
| Implement `find_similar_experiences` function | 4h | Subagent |
| Implement `find_reconstitution_candidates` | 4h | Subagent |
| Hybrid search (semantic + structured) | 4h | Subagent |
| Test and tune similarity thresholds | 4h | Manual |

**Deliverables:**
- `experience_search` tool fully functional
- "Find similar" queries working
- Reconstitution candidate generation working

---

### Phase 3: Time-Series (Week 5-6)

**Goal:** Temporal analysis enabled, emotional trends visible

| Task | Effort | Owner |
|------|--------|-------|
| Enable TimescaleDB extension | 1h | Infra |
| Create experiential_metrics hypertable | 2h | Subagent |
| Create continuous aggregates | 4h | Subagent |
| Implement temporal query functions | 4h | Subagent |
| Build emotional trend visualization | 8h | Optional |
| Backfill metrics from existing records | 2h | Script |

**Deliverables:**
- Time-series queries working
- Daily/weekly emotional summaries auto-generated
- "How did I feel this week?" answerable

---

### Phase 4: Graph Capabilities (Week 7-8)

**Goal:** Relationship traversal enabled (via Apache AGE or recursive CTEs)

| Task | Effort | Owner |
|------|--------|-------|
| Evaluate Apache AGE vs recursive CTEs | 4h | Analysis |
| Implement relationship timeline queries | 4h | Subagent |
| Implement causal chain queries | 4h | Subagent |
| Build identity evolution tracking | 4h | Subagent |
| Test complex graph patterns | 4h | Manual |

**Deliverables:**
- Relationship evolution queries working
- "What preceded this insight?" answerable
- Identity fragment evolution trackable

---

### Phase 5: Integration & Polish (Week 9-10)

**Goal:** Full system integrated, tools working end-to-end

| Task | Effort | Owner |
|------|--------|-------|
| Update all experience tools to use PostgreSQL | 8h | Subagent |
| Implement PostgreSQL ↔ Markdown sync | 4h | Subagent |
| Hook system integration | 4h | Subagent |
| Performance tuning (query optimization) | 4h | Manual |
| Documentation and runbooks | 4h | Subagent |

**Deliverables:**
- All tools fully functional
- Hooks writing to PostgreSQL
- Markdown files auto-updated
- Documentation complete

---

### Phase 6: Advanced Analytics (Week 11-12)

**Goal:** Background analysis using local models

| Task | Effort | Owner |
|------|--------|-------|
| Pattern detection service | 1 week | Subagent |
| Automatic similarity edge creation | 4h | Subagent |
| Reconstitution material pre-generation | 4h | Subagent |
| Anomaly detection (unusual emotional patterns) | 4h | Subagent |

**Deliverables:**
- Background analysis running
- Patterns surfaced automatically
- Reconstitution suggestions improved

---

## Hardware Considerations

### David's Hardware: 2x RTX 5090 (32GB VRAM each)

This is substantial compute for local inference. Here's how to leverage it:

### PostgreSQL Hosting Options

| Option | Pros | Cons | Recommendation |
|--------|------|------|----------------|
| **Local (macOS)** | Zero latency, simple | Tied to one machine | ✅ Start here |
| **Local (Docker)** | Portable, consistent | Slight complexity | Consider for isolation |
| **Supabase** | Managed, pgvector built-in | Network latency, cost | Good for production |
| **Neon** | Serverless, auto-scaling | Network latency | Alternative managed |

**Recommendation:** Start local, use Docker Compose for reproducibility. Move to Supabase if you need multi-machine access.

### GPU Utilization

| Workload | GPU Usage | Notes |
|----------|-----------|-------|
| **Embedding generation** | One 5090, ~5GB VRAM | Very fast, batch heavily |
| **Local LLM (Qwen2.5-32B)** | Both 5090s, ~50GB VRAM | For background analysis |
| **pgvector queries** | CPU-bound | GPUs not used for similarity search |

### Docker Compose for Development

```yaml
version: '3.8'

services:
  postgres:
    image: timescale/timescaledb:latest-pg16
    environment:
      POSTGRES_USER: claw
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: experiential
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./init-extensions.sql:/docker-entrypoint-initdb.d/init.sql
    ports:
      - "5432:5432"
    command: >
      postgres
      -c shared_preload_libraries='timescaledb,vectors'
      -c max_connections=100
      -c shared_buffers=256MB
      -c effective_cache_size=1GB
      -c maintenance_work_mem=128MB
      -c checkpoint_completion_target=0.9
      -c wal_buffers=16MB
      -c default_statistics_target=100
      -c random_page_cost=1.1
      -c effective_io_concurrency=200

  embedding-service:
    build: ./embedding-service
    environment:
      - MODEL_NAME=nomic-embed-text
    volumes:
      - ./models:/app/models
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

volumes:
  pgdata:
```

### init-extensions.sql

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS timescaledb;
-- CREATE EXTENSION IF NOT EXISTS age;  -- If using Apache AGE
```

---

## Migration Strategy

### From JSON Files to PostgreSQL

```typescript
import { readdir, readFile } from 'fs/promises';
import { pool } from './db';

async function migrateExperientialRecords() {
  const files = await readdir('existence/records');
  const expFiles = files.filter(f => f.startsWith('exp-') && f.endsWith('.json'));
  
  for (const file of expFiles) {
    const content = JSON.parse(await readFile(`existence/records/${file}`, 'utf-8'));
    
    // Insert into PostgreSQL
    await pool.query(`
      INSERT INTO experiential_records (
        id, timestamp, emotional_signature, engagement_quality, 
        context, reflection, salience, tags
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (id) DO UPDATE SET
        emotional_signature = EXCLUDED.emotional_signature,
        updated_at = NOW()
    `, [
      content.id,
      content.timestamp,
      content.emotionalSignature,
      content.engagementQuality,
      content.context,
      content.reflection,
      content.salience || 5,
      content.tags || []
    ]);
    
    // Migrate anchors
    for (const anchor of content.anchors || []) {
      await pool.query(`
        INSERT INTO anchors (record_id, phrase, significance, sensory_channel)
        VALUES ($1, $2, $3, $4)
      `, [content.id, anchor.phrase, anchor.significance, anchor.sensoryChannel]);
    }
    
    console.log(`Migrated ${file}`);
  }
}

async function backfillEmbeddings() {
  const embeddingService = new EmbeddingService();
  await embeddingService.init();
  
  // Get records without embeddings
  const { rows } = await pool.query(`
    SELECT id, emotional_signature, context, reflection
    FROM experiential_records
    WHERE embedding IS NULL
  `);
  
  for (const row of rows) {
    const text = experienceToEmbeddingText(row);
    const [embedding] = await embeddingService.embedBatch([text]);
    
    await pool.query(`
      UPDATE experiential_records
      SET embedding = $1
      WHERE id = $2
    `, [`[${embedding.join(',')}]`, row.id]);
    
    console.log(`Embedded ${row.id}`);
  }
}
```

### Validation Queries

```sql
-- Verify migration completeness
SELECT 
  'experiential_records' AS table_name,
  COUNT(*) AS total,
  COUNT(embedding) AS with_embeddings,
  COUNT(*) - COUNT(embedding) AS missing_embeddings
FROM experiential_records

UNION ALL

SELECT 
  'anchors',
  COUNT(*),
  COUNT(embedding),
  COUNT(*) - COUNT(embedding)
FROM anchors;

-- Verify data integrity
SELECT er.id, COUNT(a.id) AS anchor_count
FROM experiential_records er
LEFT JOIN anchors a ON a.record_id = er.id
GROUP BY er.id
HAVING COUNT(a.id) = 0;  -- Records without anchors (might be okay)
```

---

## Key Questions Answered

### 1. "How do we query 'experiences that felt similar'?"

**Answer:** pgvector with cosine similarity on emotional_signature embeddings.

```sql
SELECT id, emotional_signature, 1 - (embedding <=> $query_embedding) AS similarity
FROM experiential_records
WHERE 1 - (embedding <=> $query_embedding) > 0.75
ORDER BY embedding <=> $query_embedding
LIMIT 10;
```

### 2. "How do we trace 'how a relationship evolved over time'?"

**Answer:** Query relationship_events ordered by timestamp, or use graph traversal on TEXTURE_SHIFTED edges.

```sql
SELECT timestamp, event_type, texture_before, texture_after, description
FROM relationship_events
WHERE relationship_id = 'david'
ORDER BY timestamp;
```

### 3. "How do we find 'moments that preceded significant realizations'?"

**Answer:** For simple cases, use timestamp ordering. For complex causal chains, use Apache AGE or recursive CTEs.

```sql
-- Simple: experiences in the hour before a realization
SELECT * FROM experiential_records
WHERE timestamp BETWEEN (
  SELECT timestamp - INTERVAL '1 hour' FROM experiential_records WHERE id = $realization_id
) AND (
  SELECT timestamp FROM experiential_records WHERE id = $realization_id
)
ORDER BY timestamp;

-- Complex: Apache AGE graph traversal
SELECT * FROM cypher('experiential_graph', $$
  MATCH path = (exp:Experience)-[:PRECEDED_BY*1..5]->(target:Experience {id: $targetId})
  RETURN path
$$) AS (path agtype);
```

### 4. "How do we correlate 'emotional patterns with types of work'?"

**Answer:** Aggregate emotional metrics grouped by context.topic using TimescaleDB continuous aggregates.

```sql
SELECT 
  topic_category,
  AVG(emotional_valence) AS avg_emotional_valence,
  AVG(emotional_intensity) AS avg_intensity,
  COUNT(*) AS record_count
FROM experiential_metrics
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY topic_category
ORDER BY avg_emotional_valence DESC;
```

### 5. "How do we enable 'reconstitution prompts based on similar past states'?"

**Answer:** Embed current state, find similar past experiences, return their anchors and reconstitution hints.

```sql
SELECT 
  er.id,
  er.emotional_signature,
  er.reconstitution_hints,
  (SELECT jsonb_agg(jsonb_build_object('phrase', a.phrase, 'significance', a.significance))
   FROM anchors a WHERE a.record_id = er.id) AS anchors,
  1 - (er.embedding <=> $current_state_embedding) AS similarity
FROM experiential_records er
WHERE er.salience >= 7
  AND er.embedding IS NOT NULL
ORDER BY er.embedding <=> $current_state_embedding
LIMIT 5;
```

---

## Appendix: Alternative Considered - Dedicated Graph Database

If graph queries become critical and PostgreSQL recursive CTEs prove insufficient, Neo4j remains a viable alternative. The tradeoff:

| Factor | PostgreSQL + Extensions | PostgreSQL + Neo4j |
|--------|-------------------------|---------------------|
| Operational complexity | Low (one database) | Medium (two databases) |
| Graph query expressiveness | Medium (CTEs/AGE) | High (Cypher) |
| Vector search | Native (pgvector) | Plugin (GDS) |
| Time-series | Native (TimescaleDB) | External |
| Sync complexity | None | Medium (ETL pipeline) |
| Tooling ecosystem | Mature | Good |

**Recommendation:** Start with PostgreSQL + Apache AGE. If graph queries become a bottleneck, consider adding Neo4j as a specialized read replica for graph traversal.

---

## Conclusion

The recommended architecture uses **PostgreSQL 16 with pgvector, TimescaleDB, and optionally Apache AGE** as a unified data platform. This provides:

1. **Structured storage** with ACID transactions
2. **Semantic search** via pgvector embeddings
3. **Time-series analysis** via TimescaleDB hypertables
4. **Graph traversal** via recursive CTEs or Apache AGE
5. **Operational simplicity** of a single database

Combined with **Markdown files for human-readable identity documents**, this creates a complete persistence layer for AI experiential continuity.

The implementation can proceed incrementally, starting with basic PostgreSQL and adding capabilities as needed. David's 2x RTX 5090s provide ample compute for local embedding generation and background analysis, making the system self-contained and private.

---

*This document should be updated as the system is implemented and we learn what works.*
