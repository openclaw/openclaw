# ADR Quality Readiness Checklist

**Purpose:** Standardized 8-category, 29-criteria framework for evaluating system testability and NFR compliance during architecture review (Phase 3) and NFR assessment.

**When to Use:**

- System-level test design (Phase 3): Identify testability gaps in architecture
- NFR assessment workflow: Structured evaluation with evidence
- Gate decisions: Quantifiable criteria (X/29 met = PASS/CONCERNS/FAIL)

**How to Use:**

1. For each criterion, assess status: ✅ Covered / ⚠️ Gap / ⬜ Not Assessed
2. Document gap description if ⚠️
3. Describe risk if criterion unmet
4. Map to test scenarios (what tests validate this criterion)

---

## 1. Testability & Automation

**Question:** Can we verify this effectively without manual toil?

| #   | Criterion                                                                                                                                  | Risk if Unmet                                  | Typical Test Scenarios (P0-P2)                                                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1.1 | **Isolation:** Can the service be tested with all downstream dependencies (DBs, APIs, Queues) mocked or stubbed?                           | Flaky tests; inability to test in isolation    | P1: Service runs with mocked DB, P1: Service runs with mocked API, P2: Integration tests with real deps |
| 1.2 | **Headless Interaction:** Is 100% of the business logic accessible via API (REST/gRPC) to bypass the UI for testing?                       | Slow, brittle UI-based automation              | P0: All core logic callable via API, P1: No UI dependency for critical paths                            |
| 1.3 | **State Control:** Do we have "Seeding APIs" or scripts to inject specific data states (e.g., "User with expired subscription") instantly? | Long setup times; inability to test edge cases | P0: Seed baseline data, P0: Inject edge case data states, P1: Cleanup after tests                       |
| 1.4 | **Sample Requests:** Are there valid and invalid cURL/JSON sample requests provided in the design doc for QA to build upon?                | Ambiguity on how to consume the service        | P1: Valid request succeeds, P1: Invalid request fails with clear error                                  |

**Common Gaps:**

- No mock endpoints for external services (Athena, Milvus, third-party APIs)
- Business logic tightly coupled to UI (requires E2E tests for everything)
- No seeding APIs (manual database setup required)
- ADR has architecture diagrams but no sample API requests

**Mitigation Examples:**

- 1.1 (Isolation): Provide mock endpoints, dependency injection, interface abstractions
- 1.2 (Headless): Expose all business logic via REST/GraphQL APIs
- 1.3 (State Control): Implement `/api/test-data` seeding endpoints (dev/staging only)
- 1.4 (Sample Requests): Add "Example API Calls" section to ADR with cURL commands

---

## 2. Test Data Strategy

**Question:** How do we fuel our tests safely?

| #   | Criterion                                                                                                                             | Risk if Unmet                                | Typical Test Scenarios (P0-P2)                                                                 |
| --- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 2.1 | **Segregation:** Does the design support multi-tenancy or specific headers (e.g., x-test-user) to keep test data out of prod metrics? | Skewed business analytics; data pollution    | P0: Multi-tenant isolation (customer A ≠ customer B), P1: Test data excluded from prod metrics |
| 2.2 | **Generation:** Can we use synthetic data, or do we rely on scrubbing production data (GDPR/PII risk)?                                | Privacy violations; dependency on stale data | P0: Faker-based synthetic data, P1: No production data in tests                                |
| 2.3 | **Teardown:** Is there a mechanism to "reset" the environment or clean up data after destructive tests?                               | Environment rot; subsequent test failures    | P0: Automated cleanup after tests, P2: Environment reset script                                |

**Common Gaps:**

- No `customer_id` scoping in queries (cross-tenant data leakage risk)
- Reliance on production data dumps (GDPR/PII violations)
- No cleanup mechanism (tests leave data behind, polluting environment)

**Mitigation Examples:**

- 2.1 (Segregation): Enforce `customer_id` in all queries, add test-specific headers
- 2.2 (Generation): Use Faker library, create synthetic data generators, prohibit prod dumps
- 2.3 (Teardown): Auto-cleanup hooks in test framework, isolated test customer IDs

---

## 3. Scalability & Availability

**Question:** Can it grow, and will it stay up?

| #   | Criterion                                                                                                                   | Risk if Unmet                                     | Typical Test Scenarios (P0-P2)                                                                       |
| --- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 3.1 | **Statelessness:** Is the service stateless? If not, how is session state replicated across instances?                      | Inability to auto-scale horizontally              | P1: Service restart mid-request → no data loss, P2: Horizontal scaling under load                    |
| 3.2 | **Bottlenecks:** Have we identified the weakest link (e.g., database connections, API rate limits) under load?              | System crash during peak traffic                  | P2: Load test identifies bottleneck, P2: Connection pool exhaustion handled                          |
| 3.3 | **SLA Definitions:** What is the target Availability (e.g., 99.9%) and does the architecture support redundancy to meet it? | Breach of contract; customer churn                | P1: Availability target defined, P2: Redundancy validated (multi-region/zone)                        |
| 3.4 | **Circuit Breakers:** If a dependency fails, does this service fail fast or hang?                                           | Cascading failures taking down the whole platform | P1: Circuit breaker opens on 5 failures, P1: Auto-reset after recovery, P2: Timeout prevents hanging |

**Common Gaps:**

- Stateful session management (can't scale horizontally)
- No load testing, bottlenecks unknown
- SLA undefined or unrealistic (99.99% without redundancy)
- No circuit breakers (cascading failures)

**Mitigation Examples:**

- 3.1 (Statelessness): Externalize session to Redis/JWT, design for horizontal scaling
- 3.2 (Bottlenecks): Load test with k6, monitor connection pools, identify weak links
- 3.3 (SLA): Define realistic SLA (99.9% = 43 min/month downtime), add redundancy
- 3.4 (Circuit Breakers): Implement circuit breakers (Hystrix pattern), fail fast on errors

---

## 4. Disaster Recovery (DR)

**Question:** What happens when the worst-case scenario occurs?

| #   | Criterion                                                                                                            | Risk if Unmet                                  | Typical Test Scenarios (P0-P2)                                          |
| --- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------- |
| 4.1 | **RTO/RPO:** What is the Recovery Time Objective (how long to restore) and Recovery Point Objective (max data loss)? | Extended outages; data loss liability          | P2: RTO defined and tested, P2: RPO validated (backup frequency)        |
| 4.2 | **Failover:** Is region/zone failover automated or manual? Has it been practiced?                                    | "Heroics" required during outages; human error | P2: Automated failover works, P2: Manual failover documented and tested |
| 4.3 | **Backups:** Are backups immutable and tested for restoration integrity?                                             | Ransomware vulnerability; corrupted backups    | P2: Backup restore succeeds, P2: Backup immutability validated          |

**Common Gaps:**

- RTO/RPO undefined (no recovery plan)
- Failover never tested (manual process, prone to errors)
- Backups exist but restoration never validated (untested backups = no backups)

**Mitigation Examples:**

- 4.1 (RTO/RPO): Define RTO (e.g., 4 hours) and RPO (e.g., 1 hour), document recovery procedures
- 4.2 (Failover): Automate multi-region failover, practice failover drills quarterly
- 4.3 (Backups): Implement immutable backups (S3 versioning), test restore monthly

---

## 5. Security

**Question:** Is the design safe by default?

| #   | Criterion                                                                                                        | Risk if Unmet                            | Typical Test Scenarios (P0-P2)                                                                                   |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 5.1 | **AuthN/AuthZ:** Does it implement standard protocols (OAuth2/OIDC)? Are permissions granular (Least Privilege)? | Unauthorized access; data leaks          | P0: OAuth flow works, P0: Expired token rejected, P0: Insufficient permissions return 403, P1: Scope enforcement |
| 5.2 | **Encryption:** Is data encrypted at rest (DB) and in transit (TLS)?                                             | Compliance violations; data theft        | P1: Milvus data-at-rest encrypted, P1: TLS 1.2+ enforced, P2: Certificate rotation works                         |
| 5.3 | **Secrets:** Are API keys/passwords stored in a Vault (not in code or config files)?                             | Credentials leaked in git history        | P1: No hardcoded secrets in code, P1: Secrets loaded from AWS Secrets Manager                                    |
| 5.4 | **Input Validation:** Are inputs sanitized against Injection attacks (SQLi, XSS)?                                | System compromise via malicious payloads | P1: SQL injection sanitized, P1: XSS escaped, P2: Command injection prevented                                    |

**Common Gaps:**

- Weak authentication (no OAuth, hardcoded API keys)
- No encryption at rest (plaintext in database)
- Secrets in git (API keys, passwords in config files)
- No input validation (vulnerable to SQLi, XSS, command injection)

**Mitigation Examples:**

- 5.1 (AuthN/AuthZ): Implement OAuth 2.1/OIDC, enforce least privilege, validate scopes
- 5.2 (Encryption): Enable TDE (Transparent Data Encryption), enforce TLS 1.2+
- 5.3 (Secrets): Migrate to AWS Secrets Manager/Vault, scan git history for leaks
- 5.4 (Input Validation): Sanitize all inputs, use parameterized queries, escape outputs

---

## 6. Monitorability, Debuggability & Manageability

**Question:** Can we operate and fix this in production?

| #   | Criterion                                                                                            | Risk if Unmet                                      | Typical Test Scenarios (P0-P2)                                                                    |
| --- | ---------------------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| 6.1 | **Tracing:** Does the service propagate W3C Trace Context / Correlation IDs for distributed tracing? | Impossible to debug errors across microservices    | P2: W3C Trace Context propagated (EventBridge → Lambda → Service), P2: Correlation ID in all logs |
| 6.2 | **Logs:** Can log levels (INFO vs DEBUG) be toggled dynamically without a redeploy?                  | Inability to diagnose issues in real-time          | P2: Log level toggle works without redeploy, P2: Logs structured (JSON format)                    |
| 6.3 | **Metrics:** Does it expose RED metrics (Rate, Errors, Duration) for Prometheus/Datadog?             | Flying blind regarding system health               | P2: /metrics endpoint exposes RED metrics, P2: Prometheus/Datadog scrapes successfully            |
| 6.4 | **Config:** Is configuration externalized? Can we change behavior without a code build?              | Rigid system; full deploys needed for minor tweaks | P2: Config change without code build, P2: Feature flags toggle behavior                           |

**Common Gaps:**

- No distributed tracing (can't debug across microservices)
- Static log levels (requires redeploy to enable DEBUG)
- No metrics endpoint (blind to system health)
- Configuration hardcoded (requires full deploy for minor changes)

**Mitigation Examples:**

- 6.1 (Tracing): Implement W3C Trace Context, add correlation IDs to all logs
- 6.2 (Logs): Use dynamic log levels (environment variable), structured logging (JSON)
- 6.3 (Metrics): Expose /metrics endpoint, track RED metrics (Rate, Errors, Duration)
- 6.4 (Config): Externalize config (AWS SSM/AppConfig), use feature flags (LaunchDarkly)

---

## 7. QoS (Quality of Service) & QoE (Quality of Experience)

**Question:** How does it perform, and how does it feel?

| #   | Criterion                                                                                            | Risk if Unmet                                          | Typical Test Scenarios (P0-P2)                                                                  |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------- |
| 7.1 | **Latency (QoS):** What are the P95 and P99 latency targets?                                         | Slow API responses affecting throughput                | P3: P95 latency <Xs (load test), P3: P99 latency <Ys (load test)                                |
| 7.2 | **Throttling (QoS):** Is there Rate Limiting to prevent "noisy neighbors" or DDoS?                   | Service degradation for all users due to one bad actor | P2: Rate limiting enforced, P2: 429 returned when limit exceeded                                |
| 7.3 | **Perceived Performance (QoE):** Does the UI show optimistic updates or skeletons while loading?     | App feels sluggish to the user                         | P2: Skeleton/spinner shown while loading (E2E), P2: Optimistic updates (E2E)                    |
| 7.4 | **Degradation (QoE):** If the service is slow, does it show a friendly message or a raw stack trace? | Poor user trust; frustration                           | P2: Friendly error message shown (not stack trace), P1: Error boundary catches exceptions (E2E) |

**Common Gaps:**

- Latency targets undefined (no SLOs)
- No rate limiting (vulnerable to DDoS, noisy neighbors)
- Poor perceived performance (blank screen while loading)
- Raw error messages (stack traces exposed to users)

**Mitigation Examples:**

- 7.1 (Latency): Define SLOs (P95 <2s, P99 <5s), load test to validate
- 7.2 (Throttling): Implement rate limiting (per-user, per-IP), return 429 with Retry-After
- 7.3 (Perceived Performance): Add skeleton screens, optimistic updates, progressive loading
- 7.4 (Degradation): Implement error boundaries, show friendly messages, log stack traces server-side

---

## 8. Deployability

**Question:** How easily can we ship this?

| #   | Criterion                                                                                  | Risk if Unmet                                          | Typical Test Scenarios (P0-P2)                                                 |
| --- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------ |
| 8.1 | **Zero Downtime:** Does the design support Blue/Green or Canary deployments?               | Maintenance windows required (downtime)                | P2: Blue/Green deployment works, P2: Canary deployment gradual rollout         |
| 8.2 | **Backward Compatibility:** Can we deploy the DB changes separately from the Code changes? | "Lock-step" deployments; high risk of breaking changes | P2: DB migration before code deploy, P2: Code handles old and new schema       |
| 8.3 | **Rollback:** Is there an automated rollback trigger if Health Checks fail post-deploy?    | Prolonged outages after a bad deploy                   | P2: Health check fails → automated rollback, P2: Rollback completes within RTO |

**Common Gaps:**

- No zero-downtime strategy (requires maintenance window)
- Tight coupling between DB and code (lock-step deployments)
- No automated rollback (manual intervention required)

**Mitigation Examples:**

- 8.1 (Zero Downtime): Implement Blue/Green or Canary deployments, use feature flags
- 8.2 (Backward Compatibility): Separate DB migrations from code deploys, support N-1 schema
- 8.3 (Rollback): Automate rollback on health check failures, test rollback procedures

---

## Usage in Test Design Workflow

**System-Level Mode (Phase 3):**

**In test-design-architecture.md:**

- Add "NFR Testability Requirements" section after ASRs
- Use 8 categories with checkboxes (29 criteria)
- For each criterion: Status (⬜ Not Assessed, ⚠️ Gap, ✅ Covered), Gap description, Risk if unmet
- Example:

```markdown
## NFR Testability Requirements

**Based on ADR Quality Readiness Checklist**

### 1. Testability & Automation

Can we verify this effectively without manual toil?

| Criterion                                                        | Status          | Gap/Requirement                      | Risk if Unmet                           |
| ---------------------------------------------------------------- | --------------- | ------------------------------------ | --------------------------------------- |
| ⬜ Isolation: Can service be tested with downstream deps mocked? | ⚠️ Gap          | No mock endpoints for Athena queries | Flaky tests; can't test in isolation    |
| ⬜ Headless: 100% business logic accessible via API?             | ✅ Covered      | All MCP tools are REST APIs          | N/A                                     |
| ⬜ State Control: Seeding APIs to inject data states?            | ⚠️ Gap          | Need `/api/test-data` endpoints      | Long setup times; can't test edge cases |
| ⬜ Sample Requests: Valid/invalid cURL/JSON samples provided?    | ⬜ Not Assessed | Pending ADR Tool schemas finalized   | Ambiguity on how to consume service     |

**Actions Required:**

- [ ] Backend: Implement mock endpoints for Athena (R-002 blocker)
- [ ] Backend: Implement `/api/test-data` seeding APIs (R-002 blocker)
- [ ] PM: Finalize ADR Tool schemas with sample requests (Q4)
```

**In test-design-qa.md:**

- Map each criterion to test scenarios
- Add "NFR Test Coverage Plan" section with P0/P1/P2 priority for each category
- Reference Architecture doc gaps
- Example:

```markdown
## NFR Test Coverage Plan

**Based on ADR Quality Readiness Checklist**

### 1. Testability & Automation (4 criteria)

**Prerequisites from Architecture doc:**

- [ ] R-002: Test data seeding APIs implemented (blocker)
- [ ] Mock endpoints available for Athena queries

| Criterion                       | Test Scenarios                                                       | Priority | Test Count | Owner            |
| ------------------------------- | -------------------------------------------------------------------- | -------- | ---------- | ---------------- |
| Isolation: Mock downstream deps | Mock Athena queries, Mock Milvus, Service runs isolated              | P1       | 3          | Backend Dev + QA |
| Headless: API-accessible logic  | All MCP tools callable via REST, No UI dependency for business logic | P0       | 5          | QA               |
| State Control: Seeding APIs     | Create test customer, Seed 1000 transactions, Inject edge cases      | P0       | 4          | QA               |
| Sample Requests: cURL examples  | Valid request succeeds, Invalid request fails with clear error       | P1       | 2          | QA               |

**Detailed Test Scenarios:**

- [ ] Isolation: Service runs with Athena mocked (returns fixture data)
- [ ] Isolation: Service runs with Milvus mocked (returns ANN fixture)
- [ ] State Control: Seed test customer with 1000 baseline transactions
- [ ] State Control: Inject edge case (expired subscription user)
```

---

## Usage in NFR Assessment Workflow

**Output Structure:**

```markdown
# NFR Assessment: {Feature Name}

**Based on ADR Quality Readiness Checklist (8 categories, 29 criteria)**

## Assessment Summary

| Category                      | Status      | Criteria Met | Evidence                               | Next Action          |
| ----------------------------- | ----------- | ------------ | -------------------------------------- | -------------------- |
| 1. Testability & Automation   | ⚠️ CONCERNS | 2/4          | Mock endpoints missing                 | Implement R-002      |
| 2. Test Data Strategy         | ✅ PASS     | 3/3          | Faker + auto-cleanup                   | None                 |
| 3. Scalability & Availability | ⚠️ CONCERNS | 1/4          | SLA undefined                          | Define SLA           |
| 4. Disaster Recovery          | ⚠️ CONCERNS | 0/3          | No RTO/RPO defined                     | Define recovery plan |
| 5. Security                   | ✅ PASS     | 4/4          | OAuth 2.1 + TLS + Vault + Sanitization | None                 |
| 6. Monitorability             | ⚠️ CONCERNS | 2/4          | No metrics endpoint                    | Add /metrics         |
| 7. QoS & QoE                  | ⚠️ CONCERNS | 1/4          | Latency targets undefined              | Define SLOs          |
| 8. Deployability              | ✅ PASS     | 3/3          | Blue/Green + DB migrations + Rollback  | None                 |

**Overall:** 14/29 criteria met (48%) → ⚠️ CONCERNS

**Gate Decision:** CONCERNS (requires mitigation plan before GA)

---

## Detailed Assessment

### 1. Testability & Automation (2/4 criteria met)

**Question:** Can we verify this effectively without manual toil?

| Criterion                    | Status | Evidence                 | Gap/Action                 |
| ---------------------------- | ------ | ------------------------ | -------------------------- |
| ⬜ Isolation: Mock deps      | ⚠️     | No Athena mock           | Implement mock endpoints   |
| ⬜ Headless: API-accessible  | ✅     | All MCP tools are REST   | N/A                        |
| ⬜ State Control: Seeding    | ⚠️     | `/api/test-data` pending | Pre-implementation blocker |
| ⬜ Sample Requests: Examples | ⬜     | Pending schemas          | Finalize ADR Tools         |

**Overall Status:** ⚠️ CONCERNS (2/4 criteria met)

**Next Actions:**

- [ ] Backend: Implement Athena mock endpoints (pre-implementation)
- [ ] Backend: Implement `/api/test-data` (pre-implementation)
- [ ] PM: Finalize sample requests (implementation phase)

{Repeat for all 8 categories}
```

---

## Benefits

**For test-design workflow:**

- ✅ Standard NFR structure (same 8 categories every project)
- ✅ Clear testability requirements for Architecture team
- ✅ Direct mapping: criterion → requirement → test scenario
- ✅ Comprehensive coverage (29 criteria = no blind spots)

**For nfr-assess workflow:**

- ✅ Structured assessment (not ad-hoc)
- ✅ Quantifiable (X/29 criteria met)
- ✅ Evidence-based (each criterion has evidence field)
- ✅ Actionable (gaps → next actions with owners)

**For Architecture teams:**

- ✅ Clear checklist (29 yes/no questions)
- ✅ Risk-aware (each criterion has "risk if unmet")
- ✅ Scoped work (only implement what's needed, not everything)

**For QA teams:**

- ✅ Comprehensive test coverage (29 criteria → test scenarios)
- ✅ Clear priorities (P0 for security/isolation, P1 for monitoring, etc.)
- ✅ No ambiguity (each criterion has specific test scenarios)
