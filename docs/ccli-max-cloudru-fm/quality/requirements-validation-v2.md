# Requirements Validation Report V2

## Document Metadata

| Field              | Value                         |
| ------------------ | ----------------------------- |
| **Date**           | 2026-02-13                    |
| **Validated Plan** | IMPLEMENTATION-PLAN-V2.md     |
| **ADRs Analyzed**  | ADR-006 through ADR-013       |
| **Method**         | INVEST + SMART + Gap Analysis |
| **Step**           | 5 of pipeline                 |

---

## Executive Summary

| Metric                      | Value                                     |
| --------------------------- | ----------------------------------------- |
| Total Requirements Analyzed | ~120 across 8 ADRs                        |
| Coverage Rate               | ~72%                                      |
| CRITICAL Gaps               | 6                                         |
| HIGH Gaps                   | 25                                        |
| MEDIUM Gaps                 | 28                                        |
| LOW Gaps                    | 9                                         |
| Vague Acceptance Criteria   | 22                                        |
| **Verdict**                 | **NEEDS ITERATION before implementation** |

---

## CRITICAL Gaps (Must Fix Before Implementation)

| ID        | ADR     | Gap                                                                                                                                                                                     | Risk                                           |
| --------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| GAP-008-1 | 008/009 | **TenantId type conflict** — ADR-008 defines string, ADR-009 defines interface with platform/userId/chatId. Plan says "branded TenantIdString" but doesn't resolve which structure wins | Data model inconsistency across ALL contexts   |
| GAP-008-2 | 007/008 | **AccessTier mismatch** — ADR-007 has 3 tiers (restricted/standard/full), ADR-008 has 4 (free/standard/premium/admin). Plan mentions tier-mapper.ts but no canonical mapping            | Authorization logic will be inconsistent       |
| GAP-007-1 | 007     | **Kill switch admin API missing** — ADR-007 defines curl examples for activation, but plan has no admin HTTP endpoint                                                                   | Cannot disable compromised tools in production |
| GAP-009-1 | 009     | **Session ID collision** — ADR-009 defines resolveMultiTenantSessionId() deterministic derivation, not implemented in session module                                                    | Two users could get same session               |
| GAP-011-5 | 011     | **Export bundle leaks secrets** — ADR security constraint requires stripping secrets on /config export, plan has no secret detection                                                    | API keys in exported configs                   |
| GAP-013-9 | 013     | **Credential isolation unenforced** — ADR invariant: API keys NEVER in openclaw.json, only env vars. Plan has config-validator.ts but no key detection regex                            | Secrets committed to repos                     |

---

## HIGH Gaps (Fix Before Phase Starts)

### Phase 1 (Infrastructure)

| ID        | ADR | Gap                                                                         |
| --------- | --- | --------------------------------------------------------------------------- |
| GAP-008-5 | 008 | GDPR purge cascading delete + retention policy not defined                  |
| GAP-008-6 | 008 | Session suspension/resume from PostgreSQL cold storage lacks implementation |
| GAP-008-7 | 008 | Symlink traversal via fs.realpathSync not in path-validator spec            |
| GAP-009-4 | 009 | Worker STUCK state detection algorithm missing from worker-health.ts        |
| GAP-009-7 | 009 | Upstream rate limiter shared state (Redis?) not specified                   |
| GAP-009-8 | 009 | Fair scheduling algorithm (weighted fair queuing) not specified             |

### Phase 2 (Integration)

| ID        | ADR | Gap                                                                    |
| --------- | --- | ---------------------------------------------------------------------- |
| GAP-006-2 | 006 | Webhook delivery failure detection + long-polling fallback not in plan |
| GAP-006-7 | 006 | Timeout config (10s) + 3 retries resilience spec missing               |
| GAP-007-2 | 007 | CloudruAgentAsMCPTool wrapper (agent-as-tool) not in ai-fabric         |
| GAP-007-3 | 007 | MCP server fault isolation invariant has no test plan                  |
| GAP-007-5 | 007 | Audit completeness monitoring/alerting not defined                     |
| GAP-007-7 | 007 | MCP response output sanitization (prompt injection defense) missing    |
| GAP-010-1 | 010 | StreamParser graceful degradation on parse failure untested            |
| GAP-010-7 | 010 | MAX 30 RPS shared rate pool with adaptive backoff missing              |
| GAP-013-1 | 013 | Cold start 10-30s UX (user notification, timeout) undefined            |
| GAP-013-5 | 013 | MCP tool name collision → namespaced fallback not implemented          |

### Phase 3 (Features)

| ID        | ADR | Gap                                                             |
| --------- | --- | --------------------------------------------------------------- |
| GAP-011-1 | 011 | Auto-learning from "No, I meant..." corrections not implemented |
| GAP-011-2 | 011 | CLAUDE.md version history + rollback mechanism missing          |
| GAP-011-4 | 011 | MCP server health check before tool registration missing        |
| GAP-011-7 | 011 | Stable rule IDs across edits (remove rule 3 doesn't renumber 4) |
| GAP-012-2 | 012 | Circular dependency detection (topological sort) missing        |
| GAP-012-3 | 012 | Event bus error isolation (handler crash doesn't kill bus)      |

---

## MEDIUM Gaps (Fix During Phase)

| ID         | ADR | Gap                                                                   |
| ---------- | --- | --------------------------------------------------------------------- |
| GAP-006-1  | 006 | Mock adapter test helpers (simulateMessage, simulateCallback) missing |
| GAP-006-5  | 006 | Sticker/voice format conversion for cross-platform                    |
| GAP-006-6  | 006 | Raw platform payload preservation in metadata                         |
| GAP-007-4  | 007 | Tier escalation requires new session (sandbox immutability)           |
| GAP-007-6  | 007 | gVisor sandboxing support (production isolation)                      |
| GAP-008-3  | 008 | Workspace cleanup cron job scheduler                                  |
| GAP-008-4  | 008 | PostgreSQL partition rotation for audit log                           |
| GAP-008-8  | 008 | Messenger command routing integration point                           |
| GAP-009-3  | 009 | Worker recycling after maxRequestsPerWorker                           |
| GAP-009-5  | 009 | Prometheus metrics export endpoint                                    |
| GAP-009-6  | 009 | Warm worker pre-spawning (minWorkers)                                 |
| GAP-009-9  | 009 | Graceful pool shutdown with queue draining                            |
| GAP-010-2  | 010 | Platform-specific flush interval tuning logic                         |
| GAP-010-3  | 010 | Long message split at paragraph/sentence/word boundaries              |
| GAP-010-6  | 010 | 7 domain events emission in streaming pipeline                        |
| GAP-011-3  | 011 | Memory usage pattern classification (5 types)                         |
| GAP-011-6  | 011 | Import conflict resolution UI/API (keep/replace/merge)                |
| GAP-011-8  | 011 | 20+ slash command grammar spec for parser                             |
| GAP-011-10 | 011 | Training command rate limit (10/min per tenant)                       |
| GAP-012-1  | 012 | Plugin health check aggregation per-plugin status map                 |
| GAP-012-4  | 012 | Service disposal on scope cleanup                                     |
| GAP-012-7  | 012 | Independent versioning strategy (SemVer per module)                   |
| GAP-012-8  | 012 | DomainEvent exhaustive typed union (12 event types)                   |
| GAP-013-2  | 013 | Cloud.ru auth type switching (api_key vs access_key)                  |
| GAP-013-4  | 013 | Agent System member role/weight management                            |
| GAP-013-6  | 013 | Circuit breaker failure threshold config (3 consecutive)              |
| GAP-013-8  | 013 | SSE OpenAI-format parsing spec for sse-parser.ts                      |
| GAP-013-10 | 013 | RAG index status polling (indexing → ready)                           |

---

## Vague Acceptance Criteria Needing Tightening

| Current Criterion                         | Suggested Improvement                                                                |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| "isHealthy() returns true"                | "Health check returns true when <5% error rate and circuit breaker closed"           |
| "Tier resolution adds 5-15ms latency"     | "Performance test validates p95 < 15ms for tier resolution"                          |
| "Sandbox violation terminates subprocess" | "Sandbox escape detected via cgroup OOM or path traversal, kill signal within 100ms" |
| "Cold start latency 200-500ms"            | "Regression test: first request cold start < 500ms p99"                              |
| "Workspace provisioned"                   | "Workspace dir exists, CLAUDE.md written, quota recorded, returns within 200ms"      |
| "P95 response time 15-35s"                | "Load test: 8 concurrent users, sustained 5min, p95 < 35s"                           |
| "Throughput 16-32 req/min"                | "Sustained 10min load test achieves >= 16 req/min"                                   |
| "Queue wait < 5s for acquire"             | "Acquire timeout SLA: 5s for free tier, 2s for premium"                              |
| "Immediate UX improvement"                | "Typing indicator within 500ms, first text chunk within 3s"                          |
| "Graceful degradation"                    | "Streaming fallback success rate >= 99.9% when parser fails"                         |
| "Zero-infrastructure training"            | "CLAUDE.md write latency < 100ms, no external ML service"                            |
| "Instant effect"                          | "Next message reads updated CLAUDE.md, lag < 1s"                                     |
| "Zero required internal deps"             | "depcheck passes for each @openclaw/\* package (except core)"                        |
| "Interface stability"                     | "Major version bump on any breaking change to types.ts exports"                      |
| "DI performance overhead"                 | "Singleton resolve < 0.01ms, transient < 0.1ms"                                      |
| "Elastic scaling"                         | "Cloud.ru agents scale 0→N, cold start tolerance < 30s"                              |
| "Cost optimization"                       | "minInstances=0 + GLM free tier = $0 baseline monthly cost"                          |
| "Network dependency fallback"             | "Local-only execution within 5s when Cloud.ru unreachable"                           |
| "32 KB CLAUDE.md limit"                   | "Validator rejects > 32768 bytes with user-friendly error"                           |
| "Max 50 rules per section"                | "addRule() throws RuleLimitExceeded when section.rules.length >= 50"                 |
| "Max 100 knowledge docs"                  | "upload() throws DocLimitExceeded when tenant doc count >= 100"                      |
| "Max 10 MCP servers"                      | "register() throws ServerLimitExceeded when server count >= 10"                      |

---

## Recommended Actions

### Before Implementation Starts (Block P0)

1. **Resolve TenantId**: Decide branded string vs interface. Recommendation: branded string `TenantIdString` derived from `{platform}:{userId}:{chatId}` — satisfies both ADRs
2. **Resolve AccessTier**: Define canonical 4-tier (`free|standard|premium|admin`) with mapping function to 3-tier (`restricted|standard|full`) for MCP sandbox
3. **Add credential validator**: Regex scan for API key patterns in config files at startup
4. **Add secret stripping**: `configPorter.export()` must strip values matching `/^sk-/`, `/KEY=/`, env var references

### Before Phase 2 Starts (Block P2)

5. **Add admin API skeleton**: `/api/admin/kill-switch`, `/api/admin/audit-status`
6. **Add MCP output sanitizer**: Strip tool_result content that matches prompt injection patterns
7. **Define fair scheduling algorithm**: Weighted deficit round-robin across tenants
8. **Define upstream rate limiter**: Redis-backed sliding window shared across workers

### Before Phase 3 Starts (Block P3)

9. **Add CLAUDE.md versioning**: Copy-on-write to history directory before each mutation
10. **Define auto-learn patterns**: Regex patterns for correction detection + memory store
11. **Add topological sort**: For DI container circular dependency detection

---

## Scoring Summary

| Category                                | Score                   |
| --------------------------------------- | ----------------------- |
| Coverage (requirements in plan / total) | 72/100                  |
| INVEST (milestone quality)              | 68/100                  |
| SMART (acceptance criteria quality)     | 55/100                  |
| Testability                             | 62/100                  |
| Security Coverage                       | 58/100                  |
| **Overall Readiness**                   | **63/100 — NEEDS WORK** |

**Threshold for implementation: 75/100. Gap: 12 points.**

Fixing the 6 CRITICAL gaps (+8 points) and tightening 10 vague criteria (+4 points) would bring the score to 75/100 = READY.
