# Coding Agent Implementation Time Estimation

**Date:** 2026-01-26
**Purpose:** Estimate implementation timeline when working with AI Coding Agents
**Based on:** ZAI-DESIGN.md migration path (solo: 7 weeks)

---

## Executive Summary

| Phase | Solo Estimate | With Coding Agents | Reduction | Agent Suitability |
|-------|---------------|-------------------|-----------|-------------------|
| Phase 1: Schema & Storage | 1 week | 2-3 days | 60% | HIGH |
| Phase 2: Extraction Pipeline | 1 week | 3-4 days | 50% | MEDIUM |
| Phase 3: Crawler System | 1 week | 3-4 days | 55% | HIGH |
| Phase 4: Graph Search Integration | 1 week | 2-3 days | 70% | HIGH |
| Phase 5: Python Service (optional) | 2 weeks | 1 week | 50% | MEDIUM |
| Phase 6: Testing & Refinement | 1 week | 2-3 days | 65% | HIGH |

**Total with Coding Agents:** 2.5-3 weeks (vs. 7 weeks solo)
**Optimal Parallelization:** 2 weeks (2-3 agents working in parallel)

---

## Phase-by-Phase Agent Analysis

### Phase 1: Schema & Storage (Week 1 → 2-3 days)

**Solo Work:**
- Add graph tables to schema
- Create migration script
- Add embedding cache table
- Update file watching hooks

**Coding Agent Suitability: HIGH**

**Why Agents Excel:**
1. **Schema generation** - LLMs excel at SQL schema design
2. **Migration scripts** - Pattern-based transformation
3. **Type definitions** - TypeScript generation from SQL is deterministic
4. **No complex logic** - Mostly declarative work

**Agent Challenges:**
- Must understand existing memory schema deeply
- Migration script needs careful testing with real data
- File watching hooks touch core infrastructure

**Recommended Agent Tasks:**
| Task | Agent Capability | Human Review Needed |
|------|------------------|---------------------|
| Generate SQL schema for graph tables | 95% | Yes - verify foreign keys |
| Create TypeScript types from schema | 98% | Light |
| Write migration script | 80% | Yes - data safety |
| Update file watching hooks | 70% | Yes - core system |

**Time Breakdown:**
- Agent generates schema + types: 2-3 hours
- Human review + refinement: 2 hours
- Agent writes migration: 2-3 hours
- Human tests migration: 2 hours
- Agent updates file watching: 1-2 hours
- Human integration testing: 2 hours
- **Total: ~11-14 hours (2-3 days with breaks)**

---

### Phase 2: Extraction Pipeline (Week 1 → 3-4 days)

**Solo Work:**
- Implement `ExtractionPipeline` class
- Add LLM extraction with gleaning
- Implement 3-tier consolidation
- Add unit tests

**Coding Agent Suitability: MEDIUM**

**Why Agents Struggle:**
1. **Prompt engineering** - LLMs can over-engineer prompts
2. **Consolidation logic** - Fuzzy matching requires careful tuning
3. **Edge cases** - Entity merging has many corner cases

**Agent Strengths:**
- Parser implementation (delimiter format)
- Class structure and interfaces
- Boilerplate error handling

**Agent Challenges:**
- Gleaning loop timing and retry logic
- Embedding similarity thresholds need empirical tuning
- LLM confirmation prompts may need iteration

**Recommended Agent Tasks:**
| Task | Agent Capability | Human Review Needed |
|------|------------------|---------------------|
| ExtractionPipeline class structure | 90% | Light |
| Delimiter parser | 95% | Light |
| Gleaning loop implementation | 75% | Yes - prompt quality |
| 3-tier consolidation skeleton | 80% | Yes - thresholds |
| Unit test scaffolding | 90% | Light |

**Time Breakdown:**
- Agent builds extraction pipeline skeleton: 3-4 hours
- Human refines extraction prompts: 2-3 hours
- Agent implements parser: 2 hours
- Agent implements consolidation: 3-4 hours
- Human tunes thresholds (needs real data): 3-4 hours
- Agent writes tests: 2-3 hours
- **Total: ~15-20 hours (3-4 days)**

---

### Phase 3: Crawler System (Week 1 → 3-4 days)

**Solo Work:**
- Implement `CrawlerOrchestrator`
- Add robots.txt handler
- Implement progress tracking
- Add CLI commands

**Coding Agent Suitability: HIGH**

**Why Agents Excel:**
1. **Orchestration patterns** - Standard async/await patterns
2. **HTTP clients** - Fetch patterns are well-known
3. **CLI commands** - Clawdbot has established patterns
4. **Progress tracking** - Reusable existing patterns

**Agent Strengths:**
- Queue implementation patterns
- Rate limiting logic
- Robots.txt parsing (library-based)
- Markdown conversion (library-based)

**Agent Challenges:**
- Breadth-first discovery has edge cases
- Playwright integration for JS rendering
- Error handling for various HTTP failures

**Recommended Agent Tasks:**
| Task | Agent Capability | Human Review Needed |
|------|------------------|---------------------|
| CrawlerOrchestrator skeleton | 90% | Light |
| Robots.txt handler | 95% | Light |
| Sitemap discovery | 85% | Yes - edge cases |
| BFS discovery algorithm | 80% | Yes - cycles |
| Rate limiting | 90% | Light |
| CLI commands | 95% | Light |
| Progress tracking | 90% | Light |

**Time Breakdown:**
- Agent builds orchestrator + robots: 3-4 hours
- Human reviews discovery algorithms: 1-2 hours
- Agent implements rate limiting: 1-2 hours
- Agent adds CLI commands: 1-2 hours
- Human tests with real URLs: 2-3 hours
- Bug fixes (HTTP edge cases): 2-3 hours
- **Total: ~12-16 hours (3-4 days)**

---

### Phase 4: Graph Search Integration (Week 1 → 2-3 days)

**Solo Work:**
- Extend `MemorySearchManager` with graph awareness
- Implement graph expansion
- Add `GraphAwareSearchManager`
- Update agent tools

**Coding Agent Suitability: HIGH**

**Why Agents Excel:**
1. **Extension patterns** - Adding methods to existing classes
2. **Recursive CTEs** - SQL pattern matching
3. **Score merging** - Mathematical formulas
4. **Agent tool registration** - Declarative patterns

**Agent Strengths:**
- SQLite recursive queries (well-documented pattern)
- Score computation (deterministic math)
- Extending existing interfaces

**Agent Challenges:**
- Understanding existing `MemorySearchManager` architecture
- Graph query optimization (indexes)
- Score weighting may need tuning

**Recommended Agent Tasks:**
| Task | Agent Capability | Human Review Needed |
|------|------------------|---------------------|
| GraphQuery class implementation | 90% | Light |
| Recursive CTE queries | 85% | Yes - performance |
| GraphAwareSearchManager | 90% | Light |
| Score merging algorithm | 85% | Yes - weights |
| Agent tool registration | 95% | Light |

**Time Breakdown:**
- Agent implements graph queries: 2-3 hours
- Agent extends search manager: 2-3 hours
- Human reviews score formulas: 1 hour
- Agent registers agent tools: 1 hour
- Human integration testing: 2-3 hours
- Performance tuning (indexes): 2-3 hours
- **Total: ~10-14 hours (2-3 days)**

---

### Phase 5: Python Service (Optional, 2 Weeks → 1 Week)

**Solo Work:**
- Create FastAPI service
- Move entity extraction to Python
- Implement graph algorithms
- Add reranking service

**Coding Agent Suitability: MEDIUM**

**Why Agents Struggle:**
1. **Polyglot integration** - Node.js ↔ Python communication
2. **New tech stack** - FastAPI, PydanticAI patterns
3. **Algorithm implementation** - NetworkX usage requires understanding
4. **Deployment complexity** - Docker, service discovery

**Agent Strengths:**
- FastAPI route definitions
- Pydantic models
- Basic LangChain/LlamaIndex usage

**Agent Challenges:**
- Cross-language type safety
- Service communication patterns
- Algorithm correctness (community detection)
- Error handling across service boundaries

**Recommended Agent Tasks:**
| Task | Agent Capability | Human Review Needed |
|------|------------------|---------------------|
| FastAPI service skeleton | 90% | Light |
| Pydantic models | 95% | Light |
| LangChain extraction | 75% | Yes - prompt quality |
| NetworkX algorithms | 70% | Yes - correctness |
| Reranking service | 80% | Yes - model selection |
| Docker compose setup | 85% | Yes - networking |

**Time Breakdown:**
- Agent creates FastAPI service: 3-4 hours
- Agent implements extraction: 4-5 hours
- Human refines extraction quality: 2-3 hours
- Agent implements algorithms: 3-4 hours
- Human verifies algorithm correctness: 2-3 hours
- Agent implements reranking: 2-3 hours
- Human sets up deployment: 2-3 hours
- Integration testing: 3-4 hours
- **Total: ~25-35 hours (4-5 days with parallel work)**

**Note:** This phase is optional. Can be deferred or skipped entirely.

---

### Phase 6: Testing & Refinement (1 Week → 2-3 Days)

**Solo Work:**
- Add E2E tests
- Performance benchmarks
- Load testing
- Documentation

**Coding Agent Suitability: HIGH**

**Why Agents Excel:**
1. **Test generation** - Patterns are well-established
2. **Benchmark setup** - Standard libraries (vitest benchmark)
3. **Documentation** - LLMs excel at technical writing
4. **Test cases** - Can generate comprehensive edge cases

**Agent Strengths:**
- E2E test scenarios
- Performance test patterns
- Load testing setup (k6/artillery)
- Documentation generation

**Agent Challenges:**
- Realistic test data generation
- Performance threshold tuning
- Load testing scenarios

**Recommended Agent Tasks:**
| Task | Agent Capability | Human Review Needed |
|------|------------------|---------------------|
| E2E test suite | 90% | Light |
| Benchmark setup | 85% | Light |
| Load test scenarios | 80% | Yes - realism |
| API documentation | 95% | Light |
| Migration guide | 90% | Light |

**Time Breakdown:**
- Agent writes E2E tests: 3-4 hours
- Agent sets up benchmarks: 2-3 hours
- Human reviews test coverage: 1-2 hours
- Agent writes load tests: 2-3 hours
- Agent writes documentation: 2-3 hours
- Human final review: 2 hours
- **Total: ~12-17 hours (2-3 days)**

---

## Parallel Work Opportunities

### Maximum Parallelization (2 Weeks)

**Agent A: Infrastructure & Storage (Parallel)**
- Phase 1: Schema & Storage (2-3 days)
- Phase 4: Graph Search Integration (2-3 days)
**Total: 4-6 days**

**Agent B: Extraction & Crawling (Parallel)**
- Phase 2: Extraction Pipeline (3-4 days)
- Phase 3: Crawler System (3-4 days)
**Total: 6-8 days**

**Agent C: Testing (Dependent on A+B)**
- Phase 6: Testing & Refinement (2-3 days)
**Total: 2-3 days**

**Critical Path:** 8-10 days (Agent B's work blocks Agent C)

### Hybrid Agent/Human Approach (2.5-3 Weeks)

**Week 1:**
- Agent: Phase 1 (Schema)
- Human: Review, plan Phase 2-3

**Week 2:**
- Agent: Phase 2 (Extraction), Phase 3 (Crawler)
- Human: Tuning thresholds, testing with real data

**Week 3:**
- Agent: Phase 4 (Graph Search), Phase 6 (Testing)
- Human: Integration testing, documentation review

---

## Risk Assessment for Coding Agents

### High Risk Areas (Human Oversight Required)

| Area | Risk | Mitigation |
|------|------|------------|
| **Consolidation thresholds** | Agent may choose arbitrary values | Human must test with real data |
| **Extraction prompts** | Over-engineered, inefficient | Human review for token efficiency |
| **Recursive CTE performance** | May not optimize indexes | Human must analyze query plans |
| **Graph algorithms** | Correctness issues | Human verification required |
| **Service communication** | Type safety across languages | Human integration testing |

### Low Risk Areas (Agents Can Work Independently)

| Area | Confidence | Reason |
|------|-----------|--------|
| **Schema generation** | 95% | Well-established patterns |
| **CLI commands** | 95% | Clawdbot patterns exist |
| **Delimiters parsing** | 95% | Deterministic regex |
| **Test scaffolding** | 90% | Standard patterns |
| **Documentation** | 90% | LLM strength |

---

## Recommended Sprint Structure

### Sprint 1: Foundation (Days 1-4)
**Goal:** Working schema and basic extraction

**Day 1-2:**
- Agent: Generate schema, types, migration
- Human: Review schema, test migration on dev database

**Day 3-4:**
- Agent: Build extraction pipeline skeleton, parser
- Human: Refine prompts, test with sample documents

**Deliverable:** Extraction works end-to-end (parsing only, no consolidation)

### Sprint 2: Integration (Days 5-9)
**Goal:** Complete extraction + crawler

**Day 5-7:**
- Agent: Implement consolidation, crawler
- Human: Tune thresholds, test crawler on real URLs

**Day 8-9:**
- Agent: Graph search integration
- Human: Integration testing

**Deliverable:** Full pipeline working (crawl → extract → search)

### Sprint 3: Polish (Days 10-14)
**Goal:** Production-ready

**Day 10-12:**
- Agent: E2E tests, benchmarks
- Human: Performance tuning, edge case handling

**Day 13-14:**
- Agent: Documentation, load tests
- Human: Final review, deployment prep

**Deliverable:** Production-ready feature

---

## Agent-Specific Recommendations

### When to Use Autonomous Agents

**Good candidates:**
- Schema generation (well-defined constraints)
- CLI commands (established patterns)
- Test scaffolding (non-production code)
- Documentation (non-critical path)

**Workflow:**
1. Provide clear requirements in prompt
2. Let agent work independently
3. Review and iterate once

### When to Use Interactive Agents

**Good candidates:**
- Extraction prompts (require iteration)
- Consolidation logic (needs tuning)
- Graph algorithms (correctness verification)

**Workflow:**
1. Start with agent skeleton
2. Human refines critical sections
3. Agent completes remaining work
4. Human reviews and adjusts

### When to Avoid Agents

**Avoid for:**
- Infrastructure changes (deployment, Docker)
- Performance-critical code (requires profiling)
- Security-sensitive code (auth, encryption)
- Complex debugging (requires system understanding)

---

## Summary: Expected Timeline

### Conservative Estimate (Single Agent + Human)
| Phase | Duration | Parallelism |
|-------|----------|-------------|
| Phase 1 | 2-3 days | - |
| Phase 2 | 3-4 days | - |
| Phase 3 | 3-4 days | Can overlap with Phase 2 |
| Phase 4 | 2-3 days | - |
| Phase 5 | 4-5 days | Can be skipped |
| Phase 6 | 2-3 days | - |
| **Total** | **16-22 days** | **~3 weeks** |

### Aggressive Estimate (Multiple Agents)
| Phase | Duration | Parallelism |
|-------|----------|-------------|
| Phase 1 | 2-3 days | Agent A |
| Phase 2+3 | 4-5 days | Agent B (parallel with A) |
| Phase 4 | 2-3 days | Agent A (after Phase 1) |
| Phase 6 | 2-3 days | Agent C (after A+B) |
| **Total** | **10-14 days** | **~2 weeks** |

### Recommended Approach
**2-3 weeks with 1-2 agents working in parallel, including:**
- Human review at phase boundaries
- Performance tuning iterations
- Real-world testing time
- Documentation and deployment prep

**Key Success Factors:**
1. Start with Phase 1 to establish foundation
2. Use agents for pattern-heavy work (scaffolding, parsers, tests)
3. Human-in-the-loop for threshold tuning and prompt quality
4. Parallelize independent phases (2 & 3)
5. Optional Phase 5 can be deferred or skipped
