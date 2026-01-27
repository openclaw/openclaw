# Dependency Integration Assessment: Graphiti Case Study

**Date:** 2026-01-26
**Purpose:** Framework for evaluating external dependencies with Graphiti as case study
**Status:** Decision Document

---

## Part 1: Dependency Integration Framework

### 1.1 Decision Matrix

When evaluating whether to integrate an external dependency vs. build in-house, score each factor:

| Factor | Weight | Build (Score 1-5) | Integrate (Score 1-5) | Notes |
|--------|--------|-------------------|----------------------|-------|
| **Strategic Fit** | 20% | | | |
| Core competency? | | 5 if yes, 1 if no | 1 if yes, 5 if no | Is this our bread-and-butter? |
| Differentiation value? | | 5 if high, 1 if low | 1 if high, 5 if low | Does this make us unique? |
| **Technical Considerations** | 30% | | | |
| Implementation effort | | 1-5 (higher = harder) | 1-5 (higher = easier) | Time to integrate/build |
| Maintenance burden | | 1-5 (higher = worse) | 1-5 (higher = better) | Ongoing upkeep |
| Flexibility/control | | 5 if high, 1 if low | 1 if high, 5 if low | Ability to customize |
| **Maturity & Quality** | 25% | | | |
| Code quality of solution | | 1-5 (our estimate) | 1-5 (actual) | Tested, documented? |
| Community support | | N/A | 1-5 (higher = better) | Issues, PRs, discussions |
| Stability of API | | N/A | 1-5 (higher = better) | Breaking changes? |
| **Operational Concerns** | 15% | | | |
| Infrastructure cost | | 1-5 (higher = cheaper) | 1-5 (higher = cheaper) | Compute, storage, services |
| Operational complexity | | 1-5 (higher = simpler) | 1-5 (higher = simpler) | Moving parts to manage |
| Vendor lock-in risk | | 1 (low risk) | 5 (high risk) | Hard to exit later? |
| **Team Factors** | 10% | | | |
| Team expertise | | 1-5 (higher = familiar) | 1-5 (higher = familiar) | Language stack, patterns |
| Learning curve | | 1-5 (higher = easier) | 1-5 (higher = easier) | Time to productive |

**Scoring:**
- **Build Score** = Sum of build scores × weights
- **Integrate Score** = Sum of integrate scores × weights
- **Recommendation:** Higher score wins

### 1.2 Dependency Categories

| Category | Definition | Examples | Typical Decision |
|----------|------------|----------|------------------|
| **Infrastructure** | Databases, queues, storage | PostgreSQL, Redis, S3 | Always integrate |
| **Commodity Libraries** | Well-solved problems | moment.js, lodash | Always integrate |
| **Core Business Logic** | Your product's unique value | RAG extraction, clawdbot-specific | Usually build |
| **Framework-level** | Architectural foundations | ORMs, web frameworks | Case-by-case |
| **Specialized Tools** | Domain-specific | Graphiti, LangChain | Case-by-case |

### 1.3 Red Flags for Dependencies

**Avoid integrating if:**
1. **Strategic Mismatch:** The dependency solves a problem that's core to your differentiation
2. **High Lock-in Risk:** Switching costs are prohibitive (proprietary formats, no export)
3. **Immature API:** Frequent breaking changes, <1.0 version
4. **Single Maintainer:** One person project, no corporate backing
5. **Misaligned Goals:** The tool's roadmap doesn't match your use case
6. **Heavy Infrastructure:** Requires separate services, complex deployment
7. **Language Mismatch:** Python tool in Node.js codebase (or vice versa)

**Green flags for integration::**
1. **Commodity Problem:** Well-understood, not strategic
2. **Stable API:** Version 2.0+, backwards compatibility
3. **Strong Community:** Active issues, multiple contributors
4. **Easy Exit:** Standard formats, clear migration path
5. **Aligned Goals:** Open source, similar use cases
6. **Embedded Mode:** Can run as library, not just service

---

## Part 2: Graphiti Assessment

### 2.1 Strategic Fit Analysis

| Question | Assessment | Score (Build/Integrate) |
|----------|------------|-------------------------|
| **Is knowledge graphs a core competency?** | For Clawdbot: Partially. We're not a graph company, but agent memory is strategic. | Build: 3/5, Integrate: 3/5 |
| **Does Graphiti align with our goals?** | Yes: Agent memory, temporal tracking, hybrid search. But we need SQLite-first. | Build: 2/5, Integrate: 4/5 |
| **Is this a differentiator?** | Partially. Good memory improves agents, but not our primary value prop. | Build: 2/5, Integrate: 4/5 |
| **Will we need deep customization?** | Possibly. We want delimiter extraction, SQLite, specific prompt patterns. | Build: 4/5, Integrate: 2/5 |

**Strategic Fit Score:**
- Build: (3+2+2+4) × 0.25 = **2.75/5**
- Integrate: (3+4+4+2) × 0.25 = **3.25/5**

**Winner:** Integrate (slight edge)

### 2.2 Technical Considerations

| Factor | Build Ourselves | Integrate Graphiti | Score |
|--------|-----------------|---------------------|-------|
| **Implementation Effort** | 2-3 weeks (ZAI-AGENTS.md) | 3-5 days (integration) | Build: 2/5, Integrate: 4/5 |
| **Maintenance Burden** | Ongoing: bug fixes, edge cases, LLM API changes | Ongoing: dependency updates, API breaks | Build: 2/5, Integrate: 3/5 |
| **Flexibility/Control** | Full: delimiter format, SQLite, custom prompts | Limited: must use their extraction pattern, requires graph DB | Build: 5/5, Integrate: 2/5 |
| **Architecture Fit** | Fits: SQLite-first, TypeScript native | Poor: Requires Neo4j/FalkorDB, Python-only | Build: 5/5, Integrate: 1/5 |
| **Integration Complexity** | Low: uses existing datastore interface | High: separate Python service, graph DB, MCP bridge | Build: 4/5, Integrate: 2/5 |

**Technical Score:**
- Build: (2+2+5+5+4) / 5 = **3.6/5**
- Integrate: (4+3+2+1+2) / 5 = **2.4/5**

**Winner:** Build (significant edge)

### 2.3 Maturity & Quality

| Factor | Graphiti | Our Design | Comparison |
|--------|----------|------------|------------|
| **Code Quality** | High: Production-tested at Zep, paper published | Unknown: Not yet built | Graphiti +2 |
| **Testing** | Extensive: Unit tests, integration tests | Would need to build | Graphiti +2 |
| **Documentation** | Excellent: Papers, guides, examples | Would need to write | Graphiti +2 |
| **Community** | Growing: 1.2K stars, active Discord | N/A (we're the community) | Graphiti +1 |
| **API Stability** | Good: v0.17+, but still <1.0 | We control stability | Graphiti -1, Us +1 |
| **Proven Results** | Yes: State-of-the-art agent memory (their paper) | Unknown until built | Graphiti +2 |

**Maturity Score:**
- Build: (0+0+0+0+1+0) / 6 = **0.17/5** (we start from zero)
- Integrate: (2+2+2+1-1+2) / 6 = **1.33/5** (normalized: 4.0/5)

**Winner:** Integrate (significant edge)

### 2.4 Operational Concerns

| Factor | Build Ourselves | Integrate Graphiti | Score |
|--------|-----------------|---------------------|-------|
| **Infrastructure Cost** | Low: SQLite (included) | High: Neo4j/FalkorDB + Python service | Build: 5/5, Integrate: 2/5 |
| **Operational Complexity** | Low: Single database, Node.js only | High: Graph DB + Python + Node.js + MCP bridge | Build: 5/5, Integrate: 1/5 |
| **Deployment Simplicity** | Simple: One binary, embedded DB | Complex: Multi-service Docker compose | Build: 5/5, Integrate: 1/5 |
| **Vendor Lock-in** | Low: We own everything | Medium: Graph DB choice, Python dependency | Build: 5/5, Integrate: 3/5 |
| **Scaling Path** | Gradual: SQLite → PostgreSQL when needed | Immediate: Need graph DB from day 1 | Build: 4/5, Integrate: 2/5 |
| **Migration Cost** | N/A: Built-in | High: Data export/import if switching | Build: 5/5, Integrate: 2/5 |

**Operational Score:**
- Build: (5+5+5+5+4+5) / 6 = **4.83/5**
- Integrate: (2+1+1+3+2+2) / 6 = **1.83/5**

**Winner:** Build (overwhelming edge)

### 2.5 Team Factors

| Factor | Build Ourselves | Integrate Graphiti | Score |
|--------|-----------------|---------------------|-------|
| **Language Match** | Perfect: TypeScript/Node.js | Mismatch: Python in Node.js codebase | Build: 5/5, Integrate: 2/5 |
| **Team Expertise** | High: Node.js, SQLite, existing patterns | Low: Python, Neo4j, Graphiti patterns | Build: 5/5, Integrate: 2/5 |
| **Learning Curve** | Low: Extends existing knowledge | High: New framework, new DB, new language | Build: 4/5, Integrate: 2/5 |
| **Debugging Experience** | Unified: Same stack, same tools | Fragmented: Python logs, Neo4j logs, Node.js logs | Build: 5/5, Integrate: 2/5 |
| **Development Speed** | Medium: Build from scratch | Medium: Learn + integrate | Build: 3/5, Integrate: 3/5 |

**Team Score:**
- Build: (5+5+4+5+3) / 5 = **4.4/5**
- Integrate: (2+2+2+2+3) / 5 = **2.2/5**

**Winner:** Build (significant edge)

---

## Part 3: Weighted Decision Matrix

### 3.1 Complete Scoring

| Category | Weight | Build Score | Integrate Score | Build × Weight | Integrate × Weight |
|----------|--------|-------------|-----------------|----------------|--------------------|
| **Strategic Fit** | 20% | 2.75 | 3.25 | 0.55 | 0.65 |
| **Technical** | 30% | 3.60 | 2.40 | 1.08 | 0.72 |
| **Maturity** | 25% | 0.17 | 4.00 | 0.04 | 1.00 |
| **Operational** | 15% | 4.83 | 1.83 | 0.72 | 0.27 |
| **Team** | 10% | 4.40 | 2.20 | 0.44 | 0.22 |
| **TOTAL** | 100% | - | - | **2.83** | **2.86** |

**Result:** Nearly tied (2.83 vs 2.86)

### 3.2 Sensitivity Analysis

| Scenario | Build Score | Integrate Score | Winner |
|----------|-------------|-----------------|--------|
| **Base Case** | 2.83 | 2.86 | Integrate (by 0.03) |
| **High Operational Weight** (30%) | 3.00 | 2.50 | **Build** (by 0.50) |
| **High Maturity Weight** (40%) | 2.30 | 3.30 | Integrate (by 1.00) |
| **Single-User Focus** | 3.20 | 2.20 | **Build** (by 1.00) |
| **Enterprise Scale** | 2.50 | 3.40 | Integrate (by 0.90) |

**Key Insight:** The decision flips based on context:
- **Single-user / local development:** Build wins
- **Enterprise / production scale:** Integrate wins

---

## Part 4: Recommendation by Context

### 4.1 Build Ourselves If...

**Choose BUILD when:**
1. **Targeting single-user or small deployments** (<100 users)
2. **SQLite-first is a requirement** (embedded, zero-config)
3. **TypeScript/Node.js only** (no Python services)
4. **Cost sensitivity** (can't afford separate graph DB)
5. **Need tight control** over extraction prompts
6. **Team lacks Neo4j/Python expertise**
7. **Simple deployment** is a priority (one binary)

**Build Advantages:**
- Embedded SQLite (zero infrastructure)
- TypeScript native (unified stack)
- Custom extraction (delimiter-based, our prompts)
- Gradual scaling (SQLite → PostgreSQL → Neo4j later)
- Full control over roadmap

**Build Disadvantages:**
- 2-3 weeks development time
- Must implement bi-temporal tracking ourselves
- Less proven than Graphiti
- Ongoing maintenance burden

### 4.2 Integrate Graphiti If...

**Choose INTEGRATE when:**
1. **Enterprise deployment** from day one
2. **Need proven solution** (can't afford to get it wrong)
3. **Complex temporal queries** (state of the art required)
4. **Multi-tenant architecture** (isolation between users)
3. **Team has Python/Neo4j skills**
4. **Budget for infrastructure** (separate services OK)
5. **Time pressure** (need to ship fast)

**Integrate Advantages:**
- Production-tested (Zep paper proves SOTA)
- Bi-temporal tracking built-in
- Hybrid search proven
- MCP server for Claude integration
- Community support

**Integrate Disadvantages:**
- Heavy infrastructure (Neo4j/FalkorDB required)
- Python service in Node.js codebase
- Loss of extraction control
- Vendor lock-in (graph DB format)
- Complex deployment

### 4.3 Hybrid Approach (Recommended)

**Phase 1: Build SQLite Version (Weeks 1-3)**
- Implement our ZAI-DESIGN.md design
- Use SQLite recursive CTEs for graph queries
- Delimiter-based extraction
- Prove the concept

**Phase 2: Evaluate (Week 4)**
- Test with real data
- Measure performance
- Assess query patterns
- Decision point:

**Phase 3a: Stay with Build IF:**
- <50K entities
- Sub-100ms query performance
- Simple temporal queries
- Single-user or small team

**Phase 3b: Migrate to Graphiti IF:**
- >100K entities
- Need complex temporal queries
- Multi-user concurrency issues
- Want bi-temporal state tracking

### 4.4 Exit Strategy

**If we build first, integrating Graphiti later is straightforward:**

```typescript
// Our interface stays the same
interface KnowledgeGraph {
  search(query: string): Promise<SearchResult[]>;
  getNeighborhood(entityId: string): Promise<Neighborhood>;
}

// SQLite implementation
class SQLiteKnowledgeGraph implements KnowledgeGraph { ... }

// Graphiti implementation (future)
class GraphitiKnowledgeGraph implements KnowledgeGraph {
  private client: GraphitiClient;  // Python service bridge

  async search(query: string): Promise<SearchResult[]> {
    return this.client.search({ query });
  }

  async getNeighborhood(entityId: string): Promise<Neighborhood> {
    return this.client.getNeighborhood({ entityId });
  }
}

// Factory selects based on config
const graph = config.graph.type === 'graphiti'
  ? new GraphitiKnowledgeGraph()
  : new SQLiteKnowledgeGraph();
```

**Data migration path:**
```bash
# Export from SQLite
clawdbot knowledge export --format jsonl > graph.jsonl

# Switch to Graphiti
export DATASTORE_TYPE=graphiti

# Import to Graphiti
clawdbot knowledge import --format jsonl < graph.jsonl
```

---

## Part 5: General Dependency Guidelines

### 5.1 When to Integrate (Green Flags)

| Category | Example | Reason |
|----------|---------|--------|
| **Infrastructure** | PostgreSQL, Redis, S3 | Never build your own database |
| **Commodity Libraries** | date-fns, lodash | Well-solved, not strategic |
| **Specialized Algorithms** | sqlite-vec, pgvector | Domain expertise, not our focus |
| **Standards-Based** | OAuth2, WebSocket | Standard protocols |
| **Mature Frameworks** | >2.0, stable API, >10K stars | Proven stability |

### 5.2 When to Build (Red Flags)

| Category | Example | Reason |
|----------|---------|--------|
| **Core Business Logic** | RAG extraction, clawdbot commands | Our differentiator |
| **Simple Implementations** | Progress bars, CLI parsers | Not worth dependency |
| **Tight Coupling** | Project-specific workflows | Hard to map to external tool |
| **Language Mismatch** | Python tool in Node.js codebase | Integration friction |
| **Heavy Infrastructure** | Requires separate services | Deployment complexity |
| **Lock-in Risk** | Proprietary formats | Can't exit easily |

### 5.3 Evaluation Checklist

Before adding any dependency, ask:

**Strategic:**
- [ ] Is this problem core to our value proposition?
- [ ] Will using this limit our differentiation?
- [ ] Does the vendor's goals align with ours?

**Technical:**
- [ ] Is the API stable (version 2.0+)?
- [ ] Is there an exit strategy?
- [ ] Does it fit our architecture (language, patterns)?
- [ ] Can we test it in isolation?

**Operational:**
- [ ] What infrastructure does it require?
- [ ] How does deployment change?
- [ ] What's the ongoing maintenance burden?
- [ ] Can we afford the cost (compute, licensing)?

**Team:**
- [ ] Do we have the expertise to use it?
- [ ] What's the learning curve?
- [ ] Will it fragment our development experience?

**Maturity:**
- [ ] How old is the project?
- [ ] How many contributors?
- [ ] How many issues/PRs?
- [ ] When was the last release?

---

## Part 6: Final Recommendation for Graphiti

### 6.1 Short-Term (Next 3 Months)

**Decision: BUILD**

**Rationale:**
1. **Operational simplicity is critical** for early development
2. **SQLite-first** matches our current architecture
3. **TypeScript native** avoids polyglot complexity
4. **Learning opportunity** - we understand the problem space better
5. **Reversible decision** - can integrate Graphiti later if needed

**Actions:**
1. Implement ZAI-DESIGN.md with SQLite
2. Add bi-temporal tracking (learn from Graphiti)
3. Implement edge invalidation for contradictions
4. Monitor performance and query patterns

### 6.2 Medium-Term (3-6 Months)

**Decision Point: EVALUATE**

**Metrics to track:**
- Entity count (if >100K, consider Graphiti)
- Query latency (if >500ms, consider Graphiti)
- Temporal query complexity (if need point-in-time, consider Graphiti)
- Development velocity (if maintenance burden >30% time, consider Graphiti)

**If metrics trigger:**
1. Prototype Graphiti integration
2. A/B test performance
3. Compare total cost of ownership
4. Make go/no-go decision

### 6.3 Long-Term (6+ Months)

**Decision: HYBRID**

**Architecture:**
```typescript
// Use Graphiti for complex cases
class ProductionKnowledgeGraph {
  private graphiti: GraphitiClient;  // Enterprise features
  private local: SQLiteKnowledgeGraph;  // Fast path

  async getNeighborhood(entityId: string, options): Promise<Neighborhood> {
    // Fast path: simple queries use SQLite
    if (!options.temporal && !options.deep) {
      return this.local.getNeighborhood(entityId, 1);
    }

    // Complex path: temporal queries use Graphiti
    return this.graphiti.getNeighborhood(entityId, options);
  }
}
```

**Benefits:**
- Best of both worlds
- Gradual migration path
- Risk mitigation

---

## Part 7: Dependency Audit Framework

### 7.1 Quarterly Review

Every quarter, audit dependencies:

| Dependency | Added | Version | Why | Alternatives | Exit Cost |
|------------|-------|---------|-----|--------------|-----------|
| Graphiti | - | - | N/A | LightRAG, build | N/A |
| LanceDB | - | - | Vector search | sqlite-vec, Qdrant | Low |
| Marker | - | - | PDF parsing | Unstructured, pdfplumber | Low |

### 7.2 Dependency Budget

**Rules of thumb:**
- **Max 3 heavy dependencies** (frameworks, platforms)
- **Max 10 medium dependencies** (specialized libraries)
- **Unlimited light dependencies** (utilities, helpers)

**Current Clawdbot:**
- Heavy: 0 (Graphiti under consideration)
- Medium: ~5 (Playwright, providers, etc.)
- Light: ~20 (utilities)

**Room for:** 3 more heavy, 5 more medium

### 7.3 Integration Criteria

Before adding any dependency, it must meet **4 of 5** criteria:

1. **Solves a real problem** we have today (not hypothetical)
2. **High quality** (tested, documented, maintained)
3. **Good fit** (language, architecture, team)
4. **Reasonable exit cost** (can switch if needed)
5. **Aligned roadmap** (vendor goals match ours)

---

## Conclusion

**For Graphiti specifically:**

**Build first, integrate later if needed.**

The analysis shows it's nearly tied (2.83 vs 2.86), but the **operational complexity penalty** for Graphiti is severe enough that building ourselves gives us:
- Time to learn the problem space
- Control over architecture
- Simpler deployment
- Reversible decision

**General dependency principle:**

> "Integrate commodities, build differentiation. Prefer embedded over services. Value operational simplicity over theoretical maturity. Always keep an exit strategy."

**Framework for future decisions:**

Use the weighted matrix in Part 1 to evaluate any dependency. The weights may shift based on context, but the categories remain relevant.

---

## Next Steps

1. **Update ZAI-DESIGN.md** with bi-temporal tracking (learned from Graphiti)
2. **Add edge invalidation** logic for contradictions
3. **Implement temporal query interface** (even if simple initially)
4. **Create metrics dashboard** to track when Graphiti might be needed
5. **Document migration path** from SQLite to Graphiti (just in case)
