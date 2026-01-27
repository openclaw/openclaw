# GraphRAG Implementation: Final Design Decisions

**Date:** 2026-01-26
**Purpose:** Consolidate all final architectural decisions for implementation
**Status:** Ready for Implementation

---

## Executive Summary

This document consolidates all design decisions for the GraphRAG knowledge graph system. All alternatives have been evaluated and decisions finalized.

**Key Decisions:**
1. **Storage:** Pluggable datastore (SQLite default, PostgreSQL optional)
2. **Models:** Pluggable model abstraction (OpenAI/Gemini/Ollama)
3. **Extraction:** Schema-based with delimiter fallback
4. **Visualization:** React Flow for all graph visualization
5. **Performance:** Strategy pattern for cost/speed optimization

---

## Part 1: Storage Architecture

### Decision: Pluggable Datastore Interface

**Official Choice:** `RelationalDatastore` interface with SQLite and PostgreSQL implementations

**Architecture:**
```typescript
interface RelationalDatastore {
  query<T>(sql: string, params?: any[]): Promise<T[]>;
  execute(sql: string, params?: any[]): Promise<RunResult>;
  transaction<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  migrate(migrations: Migration[]): Promise<void>;
  // ...
}
```

**Implementations:**
- **`SQLiteDatastore`** (default): Embedded, zero-config, single-file database
- **`PostgreSQLDatastore`** (production): Scalable, concurrent, high-performance

**Migration Path:**
- Start with SQLite (zero infrastructure)
- Switch to PostgreSQL when scale requires
- Same application code, different datastore implementation

**Related Documents:**
- `ZAI-DATASTORE.md` - Complete datastore architecture
- `ZAI-DESIGN.md` - Schema and migration design

---

## Part 2: Model Abstraction

### Decision: Pluggable LanguageModel Interface

**Official Choice:** All model access through `LanguageModel` interface

**Supported Providers:**
- **OpenAI:** GPT-4o, GPT-4.1-mini (cloud)
- **Gemini:** Gemini 2.0 Flash Exp (cloud)
- **Ollama:** Local models (deepseek-r1:7b, nomic-embed-text, etc.)

**Architecture:**
```typescript
interface LanguageModel {
  chat(messages: ChatMessage[], options?: ModelConfig): Promise<string>;
  structuredChat<T>(messages: ChatMessage[], schema: z.Schema<T>, examples?: T[]): Promise<StructuredOutput<T>>;
  embed(text: string | string[]): Promise<number[][]>;
  streamChat(messages: ChatMessage[], onChunk: (chunk: string) => void): Promise<void>;
}
```

**Configuration:**
```yaml
models:
  chat:
    provider: openai
    model: gpt-4o
    fallback:
      provider: ollama
      model: deepseek-r1:7b
  embeddings:
    provider: ollama  # Local for throughput
    model: nomic-embed-text
```

**Benefits:**
- Easy swapping between cloud and local models
- Consistent API across providers
- Runtime selection based on cost/speed/quality needs

**Related Documents:**
- `ZAI-UPDATED-DESIGN.md` - Model abstraction architecture

---

## Part 3: Extraction Strategy

### Decision: Hybrid Extraction (Schema + Fallback)

**Official Choice:** Structured output first, delimiter parsing as fallback

**Extraction Pipeline:**
1. **Attempt 1:** Structured output via model's native API
   - Uses JSON Schema or function calling
   - Provides schema definition + concrete examples
   - Assumes models support this reasonably well

2. **Attempt 2 (Fallback):** Delimiter-based parsing
   - Triggered when structured output fails
   - Token-efficient format
   - Works with any model
   - Proven approach (LightRAG validation)

**Architecture:**
```typescript
class HybridExtractor {
  async extractEntities(text: string, schema: z.Schema<EntityExtraction>) {
    // Try structured output
    const result = await this.model.structuredChat(
      [{ role: 'user', content: text }],
      schema,
      EXAMPLES
    );

    if (result.success) {
      return result;
    }

    // Fall back to delimiter parsing
    return this.delimiterExtract(text, schema);
  }
}
```

**Benefits:**
- Best reliability (structured output when available)
- Best efficiency (delimiter fallback when needed)
- Works with any model capability level
- No complex logic needed

**Related Documents:**
- `ZAI-UPDATED-DESIGN.md` - Hybrid extraction architecture
- `ZAI-GRAPHITI-PROMPT-ANALYSIS.md` - Prompt customization analysis

---

## Part 4: Visualization Framework

### Decision: React Flow for Knowledge Graphs + D3 for Advanced Visualizations

**Official Choices:**
- **React Flow** for knowledge graph visualization (node-edge graphs)
- **D3.js** for advanced data visualizations (charts, maps, custom plots)

**Rationale:**
- **React Flow** provides the best developer experience for interactive knowledge graphs
- **D3.js** complements React Flow with powerful data visualization capabilities
- **Both can be used together** in the same React application
- **React Flow actually uses D3 internally** for some calculations
- **Not mutually exclusive:** D3 is a tool, React Flow is a specialized graph library

---

### React Flow: Knowledge Graph Visualization

**Use React Flow for:**
- Interactive node-edge knowledge graphs
- Force-directed layouts
- Network diagrams with entity relationships
- Graph exploration with drag-and-drop
- Mini-map navigation

**Benefits:**
- **Native React Integration:** Clawdbot UI is React-based
- **Interactive Features:** Built-in drag-drop, mini-map, zoom controls
- **Developer Experience:** Excellent TypeScript support, docs, examples
- **Community:** 23K GitHub stars, 500K weekly NPM downloads
- **Performance:** Optimized for <1000 visible nodes

**When to Reconsider:**
- Graph grows to >2000 visible nodes → consider server-side pre-aggregation or virtualization
- Need 3D visualization capabilities → evaluate three.js or 3D force-simulation libraries

---

### D3.js: Advanced Data Visualizations

**Use D3 for:**
- Statistical charts (bar, line, pie, scatter plots)
- Geographic maps and choropleths
- Hierarchical tree layouts (treemaps, sunbursts, partition layouts)
- Custom data transformations
- Complex animations and transitions
- Time-series visualizations
- Histograms and density plots
- Custom visualization research

**D3 + React Integration:**
- Use D3 for data calculations, scales, and scales
- Use React for component rendering and state management
- Libraries like `@visx` provide D3-based React components

**Benefits:**
- **Comprehensive:** 30+ visualization types
- **Flexible:** Build custom visualizations from scratch
- **Performant:** Efficient data handling
- **Well-documented:** Extensive examples and tutorials

**Example Use Cases for Clawdbot:**

**1. Entity Type Distribution (Bar Chart)**
```typescript
// Use D3 for bar chart showing entity distribution
import { BarChart } from '@visx/mock-visualization';
import { scaleBand, scaleLinear } from '@visx/scale';

function EntityTypeDistribution({ entities }) {
  // D3 for data processing, React for rendering
  const counts = d3.rollup(entities)
    .groupBy(d => d.type)
    .rollup(d => d.length);

  return <BarChart data={counts} x="type" y="count" />;
}
```

**2. Temporal Entity Evolution (Line Chart)**
```typescript
// Use D3 for time-series of entity mentions over time
import { LineChart } from '@visx/xychart';

function EntityTemporalTrend({ entities, timeRange }) {
  const data = aggregateByTime(entities, timeRange);
  return <LineChart data={data} x="timestamp" y="count" />;
}
```

**3. Relationship Heatmap**
```typescript
// Use D3 for heatmap visualization
import { HeatmapRect } from '@visx/heatmap';

function RelationshipHeatmap({ relationships }) {
  return <HeatmapRect data={relationships} {...} />;
}
```

---

### D3 and React Flow: Complementary Usage

**How They Work Together:**

```typescript
// React Flow for the main graph
import ReactFlow from 'reactflow';

// D3 for auxiliary charts
import { PieChart } from '@visx/mock-visualization';
import { BarChart } from '@visx/mock-visualization';

function KnowledgeGraphDashboard({ entities, relationships }) {
  const [selectedEntity, setSelectedEntity] = useState(null);

  return (
    <div className="knowledge-graph-dashboard">
      {/* React Flow: Main knowledge graph */}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={(_, node) => setSelectedEntity(node.data)}
      />

      {/* D3: Entity type distribution chart */}
      <div className="stats-panel">
        <PieChart data={getEntityTypeDistribution(entities)} />
      </div>

      {/* D3: Temporal trend chart */}
      <div className="trend-panel">
        <LineChart data={getTemporalTrend(entities)} />
      </div>

      {/* D3: Selected entity detail view */}
      {selectedEntity && (
        <EntityDetailPanel entity={selectedEntity}>
          {/* More D3 visualizations */}
          <RelationshipHeatmap relationships={getEntityRelationships(selectedEntity)} />
        </EntityDetailPanel>
      )}
    </div>
  );
}
```

---

### Visualization Library Recommendations by Use Case

| Use Case | Recommended Library | Reason |
|----------|-------------------|---------|
| **Knowledge graph (node-edge)** | **React Flow** | Interactive graphs, native React |
| **Statistical charts** | **@visx** (D3-based) | Bar, line, pie charts with React |
| **Geographic maps** | **D3 + d3-geo** | Maps, choropleths, geo projections |
| **Hierarchical data** | **D3** | Treemaps, sunbursts, partition layouts |
| **Time-series** | **@visx/xychart** (D3-based) | Line charts, area charts |
| **Heatmaps** | **@visx/heatmap** (D3-based) | 2D density visualizations |
| **Network diagrams** | **React Flow** | Interactive node-edge graphs |
| **Custom research vis** | **D3** | Maximum flexibility |
| **Quick charts** | **Recharts** | Pre-built components, easy to use |

---

### Dependencies

```json5
{
  "dependencies": {
    "reactflow": "^11.0.0",
    "@visx/xychart": "^0.18.0",
    "@visx/mock-visualization": "^0.18.0",
    "@visx/heatmap": "^0.18.0",
    "@visx/choropleth": "^0.18.0",
    "d3": "^7.0.0",
    "d3-geo": "^3.0.0"
  }
}
```

---

### Implementation Strategy

**Phase 1: React Flow for Knowledge Graphs**
- Implement main graph visualization using React Flow
- Add interactive features (drag, zoom, mini-map)
- Create custom node components for entities

**Phase 2: D3 for Analytics (Optional)**
- Add entity type distribution pie chart
- Add temporal trend line chart
- Add relationship heatmap
- Use @visx components for D3 integration

**Benefits:**
- **Right tool for each job:** React Flow for graphs, D3 for charts
- **Consistent React ecosystem:** All visualizations in React
- **Shared styling:** Tailwind CSS for all components
- **TypeScript throughout:** Type-safe visualizations

---

## Part 5: Cost/Performance Optimization

### Decision: Strategy Pattern for Extraction Operations

**Official Choice:** Pluggable extraction strategies

**Strategies Available:**
1. **`CloudQualityStrategy`**: GPT-4o, highest quality, $2/1M tokens
2. **`LocalSpeedStrategy`**: Ollama local, free, 200ms latency
3. **`HybridCostOptimizedStrategy`**: Local first, cloud fallback, $0.50/1M tokens

**Architecture:**
```typescript
interface ExtractionStrategy {
  readonly name: string;
  readonly estimatedCostPer1KTokens: number;
  readonly estimatedLatency: number;
  extract(text: string, options: ExtractionOptions): Promise<ExtractionResult>;
}

class StrategySelector {
  select(options: ExtractionOptions): ExtractionStrategy {
    switch (options.priority) {
      case 'cost': return strategies.localSpeed;
      case 'speed': return strategies.localSpeed;
      case 'quality': return strategies.cloudQuality;
      default: return strategies.hybridCost;
    }
  }
}
```

**Usage:**
```typescript
const strategy = selector.select({ priority: 'cost' });
const result = await strategy.extract(text);
```

**Benefits:**
- Isolated cost/speed decisions
- Easy to add new strategies
- Runtime selection based on priority
- Transparent cost tracking

**Related Documents:**
- `ZAI-UPDATED-DESIGN.md` - Cost/performance architecture

---

## Part 6: Schema & Migrations

### Decision: Extensible Schema with User-Defined Types

**Official Choice:** `kg_entity_types` and `kg_relationship_types` tables

**Schema:**
```sql
CREATE TABLE kg_entity_types (
  entity_type_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#007bff',
  icon TEXT
);

CREATE TABLE kg_relationship_types (
  relationship_type_id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  color TEXT DEFAULT '#6c757d',
  directed BOOLEAN DEFAULT TRUE
);
```

**Benefits:**
- Users can define domain-specific types
- No migration required for new types
- Built-in types seeded by default
- Configuration-driven

**Related Documents:**
- `ZAI-DESIGN.md` - Schema design
- `ZAI-DECISIONS.md` - ADR-05: Extensible schema

---

## Part 7: Consolidation Algorithm

### Decision: 3-Tier Entity Consolidation

**Official Choice:** Three-tier deduplication

**Tiers:**
1. **Tier 1:** Exact match (MD5 hash of normalized name)
2. **Tier 1.5:** Edit distance check (fast-levenshtein, threshold 3)
3. **Tier 2:** Embedding similarity (cosine ≥0.92)
4. **Tier 3:** LLM confirmation (optional, for 0.88-0.92 band)

**Benefits:**
- Catches trivial variations (casing, whitespace)
- Catches typos without embedding cost
- Catches semantic aliases via embeddings
- Configurable precision via thresholds

**Related Documents:**
- `ZAI-DESIGN.md` - Consolidation design
- `ZAI-DECISIONS.md` - ADR-04: 3-tier consolidation
- `ZAI-EVALUATION.md` - Edit distance recommendation

---

## Part 8: Crawler Architecture

### Decision: Multi-Mode with Auth Support

**Official Choice:** HTTP fetch default, Playwright opt-in

**Modes:**
1. **Single page:** Quick one-off ingestion
2. **Sitemap-based:** Complete doc site coverage
3. **Recursive BFS:** Deep exploration with depth limit

**Authentication:**
- Bearer token support
- Basic auth support
- Custom headers

**JavaScript Rendering:**
- Default: HTTP fetch (faster, lighter)
- Opt-in: `--js-render` flag for Playwright

**Related Documents:**
- `ZAI-DESIGN.md` - Crawler system design
- `ZAI-DECISIONS.md` - ADR-07: Playwright opt-in
- `ZAI-EVALUATION.md` - Crawler auth gap

---

## Part 9: Testing Strategy

### Decision: Comprehensive Testing with Benchmarking

**Official Choice:** Unit + Integration + E2E + Benchmarking

**Coverage Targets:**
- **Unit tests:** ~70% coverage target
- **Integration tests:** ~10% of total tests
- **E2E tests:** Full pipeline verification
- **Benchmarks:** Performance regression detection

**Tools:**
- **Vitest** for unit/integration tests
- **@vitest/browser** for browser testing
- **Playwright** for E2E UI tests
- **Custom benchmarks** for performance tracking

**What's Tested:**
- Extraction parsing accuracy
- Consolidation re-points relationships
- Orphaned relationship cleanup
- Graph query latency (1-hop, 2-hop, 3-hop)
- React Flow rendering FPS

**Related Documents:**
- `ZAI-ALTERNATIVES.md` - Testing strategy decision
- `ZAI-EVALUATION.md` - Testing additions

---

## Part 10: Implementation Phases

### Phase 1: Foundation (Week 1)
- Create datastore interface
- Implement SQLite and PostgreSQL datastores
- Create migration repository
- Add model abstraction layer
- Implement OpenAI and Ollama providers

### Phase 2: Extraction (Week 2)
- Implement hybrid extractor
- Add 3-tier consolidation
- Create extraction strategies
- Implement retry logic
- Add unit tests

### Phase 3: Crawler (Week 3)
- Implement multi-mode crawler
- Add robots.txt handler
- Implement auth support
- Add progress tracking
- Create CLI commands

### Phase 4: Graph Search (Week 4)
- Extend search with graph expansion
- Implement graph queries
- Add agent tools
- Create visualization components

### Phase 5: Testing & Polish (Week 5-7)
- Add E2E tests
- Performance benchmarks
- Load testing
- Documentation
- Bug fixes and refinement

**Estimated Timeline with Coding Agents:** 2-3 weeks
**Estimated Timeline Solo:** 5-7 weeks

**Related Documents:**
- `ZAI-AGENTS.md` - Coding agent time estimation

---

## Part 11: Technology Stack Summary

### Storage
- **Primary:** SQLite (embedded, zero-config)
- **Production Optional:** PostgreSQL (scalable, concurrent)

### Models
- **Cloud:** OpenAI (GPT-4o), Gemini (2.0 Flash)
- **Local:** Ollama (deepseek-r1:7b, nomic-embed-text)
- **Interface:** Pluggable `LanguageModel` abstraction

### Extraction
- **Primary:** Schema-based structured output
- **Fallback:** Delimiter-based parsing
- **Library:** Zod for schema validation

### Graph Algorithms
- **Library:** graphology
- **Storage:** SQLite recursive CTEs (default)
- **Optional:** Neo4j for scale

### Visualization
- **Library:** React Flow
- **Rendering:** SVG (via React Flow)
- **Layout:** Force-directed (built-in)

### Crawler
- **Default:** HTTP fetch
- **Opt-in:** Playwright for JS rendering
- **Libraries:** Playwright (existing), robotstxt-parser

### Testing
- **Framework:** Vitest
- **Browser:** @vitest/browser
- **E2E:** Playwright
- **Coverage:** 70% target

### Web UI
- **Framework:** React (knowledge graph section)
- **Main UI:** Lit (existing)
- **Visualization:** React Flow

---

## Part 12: Configuration

### Minimal Configuration

```yaml
# config.yaml
models:
  chat:
    provider: openai
    model: gpt-4o
  embeddings:
    provider: ollama
    model: nomic-embed-text

datastore:
  type: sqlite
  sqlite:
    path: ~/.clawdbot/memory.db

knowledge:
  enabled: true
  extraction:
    strategy: hybrid-cost
    priority: quality
    delimiterFallback: true
```

### Advanced Configuration

```yaml
models:
  chat:
    provider: openai
    model: gpt-4o
    fallback:
      provider: ollama
      model: deepseek-r1:7b
      baseURL: http://localhost:11434/v1
  embeddings:
    provider: ollama
    model: nomic-embed-text
  fast:
    provider: ollama
    model: deepseek-r1:7b

datastore:
  type: sqlite
  sqlite:
    path: ~/.clawdbot/memory.db
    wal: true

knowledge:
  enabled: true
  extraction:
    strategy: hybrid-cost
    priority: quality
    maxRetries: 3
    delimiterFallback: true
  consolidation:
    fuzzyThreshold: 0.92
    editDistanceThreshold: 3
    llmConfirm: true
  retrieval:
    graphExpansion: true
    maxHops: 1
    maxChunks: 4
    minGraphScore: 0.3

visualization:
  framework: react-flow
  layout: force
  maxNodes: 500
```

---

## Part 13: Key Files Reference

### Design Documents
- `ZAI-DESIGN.md` - Complete system design
- `ZAI-UPDATED-DESIGN.md` - Updated decisions (models, strategies, React Flow)
- `ZAI-DATASTORE.md` - Pluggable datastore architecture
- `ZAI-TOOLS.md` - Mature tool integration analysis
- `ZAI-GRAPHITI-PROMPT-ANALYSIS.md` - Graphiti evaluation
- `ZAI-GRAPHITI-ASSESSMENT.md` - Dependency evaluation framework

### Decision Records
- `ZAI-DECISIONS.md` - ADRs for all major decisions
- `ZAI-ALTERNATIVES.md` - Alternatives considered and rejected

### Planning Documents
- `ZAI-PLAN.md` - Implementation roadmap
- `ZAI-EVALUATION.md` - Original evaluation with gaps identified
- `ZAI-GLOSSARY.md` - Terminology definitions
- `ZAI-AGENTS.md` - Coding agent time estimation

### Component Documents
- `08-web-visualization.md` - Web visualization UX design

---

## Part 14: Implementation Checklist

### Core Infrastructure
- [ ] Create `RelationalDatastore` interface
- [ ] Implement `SQLiteDatastore`
- [ ] Implement `PostgreSQLDatastore`
- [ ] Create migration system
- [ ] Create model registry
- [ ] Implement OpenAI provider
- [ ] Implement Ollama provider
- [ ] Implement Gemini provider (optional)

### Knowledge Graph
- [ ] Implement hybrid extractor
- [ ] Implement delimiter parser
- [ ] Implement 3-tier consolidation
- [ ] Add retry logic
- [ ] Create extraction strategies
- [ ] Implement strategy selector
- [ ] Add graph query interface
- [ ] Create graph repository

### Crawler
- [ ] Implement crawler orchestrator
- [ ] Add robots.txt handler
- [ ] Implement multi-mode crawling
- [ ] Add auth support
- [ ] Create progress tracker
- [ ] Add CLI commands

### Visualization
- [ ] Install React Flow
- [ ] Create graph visualization component
- [ ] Implement custom node components
- [ ] Add interactive features (zoom, mini-map)
- [ ] Integrate with graph queries
- [ ] Add entity detail panel

### Testing
- [ ] Add unit tests for extraction
- [ ] Add integration tests for consolidation
- [ ] Add E2E tests for full pipeline
- [ ] Add performance benchmarks
- [ ] Add browser tests for visualization

### Documentation
- [ ] Update CLI documentation
- [ ] Add API documentation
- [ ] Create migration guide
- [ ] Update README with new features

---

## Conclusion

All design decisions have been finalized and documented. The system is ready for implementation with:

1. **Pluggable architecture** - Easy to swap implementations
2. **Performance optimization** - Strategic use of local vs cloud models
3. **Production readiness** - Gradual scaling path from SQLite to PostgreSQL
4. **Developer experience** - React Flow for visualization, TypeScript throughout
5. **Reliability** - Hybrid extraction with fallbacks, comprehensive testing

The architecture supports evolution from simple (SQLite + local models) to production (PostgreSQL + cloud models) without major rewrites.

**Next Step:** Begin Phase 1 implementation following the timeline in `ZAI-AGENTS.md`.
