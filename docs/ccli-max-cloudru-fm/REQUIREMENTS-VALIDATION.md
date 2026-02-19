# Requirements Validation Report: Implementation Plan

## Document Metadata

| Field                     | Value                                                                          |
| ------------------------- | ------------------------------------------------------------------------------ |
| **Date**                  | 2026-02-12                                                                     |
| **Validator**             | qe-requirements-validator                                                      |
| **Document Under Review** | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/IMPLEMENTATION-PLAN.md` |
| **Recommendation**        | **CONDITIONAL GO**                                                             |
| **Confidence**            | 85%                                                                            |
| **Blocking Gaps**         | 4                                                                              |
| **Non-Blocking Gaps**     | 9                                                                              |

---

## Executive Summary

The implementation plan is **thorough, well-structured, and substantially complete**. It demonstrates strong coverage of all 5 ADRs, addresses all 7 CRITICAL shift-left findings, all 12 WARNING findings, and all 5 cross-ADR issues (X-001 through X-005). The dependency DAG is sound with no circular dependencies and correct parallel opportunities identified. File references are accurate against the actual codebase.

However, 4 blocking gaps must be resolved before implementation begins:

1. The plan's M2 integration into `configure.gateway-auth.ts` adds a DUAL dispatch (both the handler chain AND a pre-check), but the pre-check invokes a function (`promptCloudruFmSetup`) that is defined in `onboard-cloudru-fm.ts`, not the handler. The handler pattern alone should suffice -- the dual-path introduces an ambiguity about which code path executes when.

2. The `clearEnv` extension in M5 modifies `DEFAULT_CLAUDE_BACKEND` (a global constant), which affects ALL `claude-cli` backends, not just cloudru-fm. This could break existing integrations.

3. No rollback procedure is defined for any milestone. A failed M2 (wizard flow) leaves partially modified files with no documented recovery path.

4. The plan references `model-fallback.ts` and `runWithModelFallback()` (M5) but the health check throws `FailoverError` with reason `"proxy-unhealthy"` -- yet the plan simultaneously says proxy-unhealthy errors should NOT trigger model fallback. This contradiction needs explicit wiring to the existing fallback mechanism.

**Recommendation: CONDITIONAL GO** -- proceed with implementation after addressing the 4 blocking gaps documented below.

---

## 1. Coverage Validation: ADR to Milestone Mapping

### ADR-001: Cloud.ru FM Proxy Integration

| ADR-001 Decision Element                        | Milestone                   | Coverage             | Status |
| ----------------------------------------------- | --------------------------- | -------------------- | ------ |
| Docker compose generation with proxy            | M4                          | Full                 | PASS   |
| CLI backend env override (`ANTHROPIC_BASE_URL`) | M2, M3                      | Full                 | PASS   |
| Proxy health check endpoint                     | M4, M5                      | Full                 | PASS   |
| `mergeBackendConfig()` env merge behavior       | M3 (documented)             | Full                 | PASS   |
| Docker image pinning                            | M3, M4                      | Full                 | PASS   |
| Docker compose `restart: unless-stopped`        | M4                          | Implicit in template | PASS   |
| `serialize: true` concurrency limitation        | M3 (documented as deferred) | Documented           | PASS   |

**Verdict: FULLY COVERED**

### ADR-002: Wizard Cloud.ru FM Auth Choice

| ADR-002 Decision Element                         | Milestone | Coverage               | Status      |
| ------------------------------------------------ | --------- | ---------------------- | ----------- |
| 3 new AuthChoice values                          | M1        | Full                   | PASS        |
| `"cloudru-fm"` AuthChoiceGroupId in BOTH files   | M1        | Full (X-005 addressed) | PASS        |
| AUTH_CHOICE_GROUP_DEFS entry                     | M1        | Full                   | PASS        |
| `buildAuthChoiceOptions` options                 | M1        | Full                   | PASS        |
| Handler file (`auth-choice.apply.cloudru-fm.ts`) | M2        | Full                   | PASS        |
| Handler registration in `auth-choice.apply.ts`   | M2        | Full                   | PASS        |
| Integration in `configure.gateway-auth.ts`       | M2        | Covered but see GAP-01 | CONDITIONAL |
| Docker compose generation from wizard            | M2, M4    | Full                   | PASS        |
| API key to `.env`, NOT `openclaw.json`           | M2        | Full                   | PASS        |
| `.gitignore` entries                             | M2, M6    | Full                   | PASS        |

**Verdict: COVERED with one conditional (GAP-01)**

### ADR-003: Claude Code as Agentic Execution Engine

| ADR-003 Decision Element                     | Milestone                        | Coverage         | Status      |
| -------------------------------------------- | -------------------------------- | ---------------- | ----------- |
| Existing `claude-cli` backend used as-is     | M3 (no changes to core)          | Full             | PASS        |
| Tools disabled via system prompt             | Not modified (existing behavior) | Preserved        | PASS        |
| Session continuity via `--session-id`        | Not modified (existing behavior) | Preserved        | PASS        |
| `clearEnv` env isolation                     | M5 (extended)                    | Full, see GAP-02 | CONDITIONAL |
| Tool calling claim correction (CRITICAL-001) | Appendix A amendment             | Documented       | PASS        |

**Verdict: COVERED with one conditional (GAP-02)**

### ADR-004: Proxy Lifecycle Management

| ADR-004 Decision Element        | Milestone                     | Coverage                  | Status |
| ------------------------------- | ----------------------------- | ------------------------- | ------ |
| Docker compose generation       | M4                            | Full                      | PASS   |
| State machine implementation    | M4 (simplified to stateless)  | Pragmatic resolution      | PASS   |
| Health check function           | M4 (`proxy-health.ts`)        | Full                      | PASS   |
| Runtime health monitoring       | M5 (in `cli-runner.ts`)       | Full                      | PASS   |
| Docker prerequisite check       | M4 (`checkDockerAvailable()`) | Full                      | PASS   |
| Port conflict detection         | M4 (`checkPortAvailable()`)   | Full                      | PASS   |
| Health check caching (30s)      | M4                            | Full                      | PASS   |
| Graceful Docker-absent handling | M4                            | Full (shows instructions) | PASS   |

**Verdict: FULLY COVERED**

### ADR-005: Model Mapping and Fallback Strategy

| ADR-005 Decision Element                     | Milestone                   | Coverage                     | Status |
| -------------------------------------------- | --------------------------- | ---------------------------- | ------ |
| 3 model presets                              | M3 (constants file)         | Full                         | PASS   |
| Fallback chain in Claude tier names          | M3, M5                      | Full (CRITICAL-006 resolved) | PASS   |
| SMALL_MODEL invariant (always GLM-4.7-Flash) | M3 (tested)                 | Full                         | PASS   |
| GLM-4.7-FlashX assigned to MIDDLE slot       | M3 (CRITICAL-007 resolved)  | Full                         | PASS   |
| DISABLE_THINKING=true                        | M4 (in compose template)    | Full                         | PASS   |
| Cloud.ru error classification                | M5 (classifyFailoverReason) | Full                         | PASS   |

**Verdict: FULLY COVERED**

### Summary

| ADR     | Milestones         | Coverage     | Verdict     |
| ------- | ------------------ | ------------ | ----------- |
| ADR-001 | M2, M3, M4         | 100%         | PASS        |
| ADR-002 | M1, M2             | 95% (GAP-01) | CONDITIONAL |
| ADR-003 | M3, M5, Appendix A | 95% (GAP-02) | CONDITIONAL |
| ADR-004 | M4, M5             | 100%         | PASS        |
| ADR-005 | M3, M5             | 100%         | PASS        |

---

## 2. Critical Issue Resolution Verification

### Shift-Left CRITICAL Issues

| Issue ID     | Description                                      | Plan Resolution                                                                                                              | Verified                                                |
| ------------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| CRITICAL-001 | ADR-001/ADR-003 tool calling contradiction       | Appendix A: ADR-001 amendment to qualify the statement                                                                       | YES -- amendment text is specific and correct           |
| CRITICAL-002 | Wrong dispatch integration point in ADR-002      | M2: Correct dual-path integration (`auth-choice.apply.ts:43-55` handler chain + `configure.gateway-auth.ts:59-60` pre-check) | YES with caveat (GAP-01)                                |
| CRITICAL-003 | Handler naming convention violation              | M2: Function named `applyAuthChoiceCloudruFm` matching convention                                                            | YES -- verified against `auth-choice.apply.ts` handlers |
| CRITICAL-004 | No concrete health check implementation location | M5: `cli-runner.ts` after line 76 (backend resolution), before subprocess spawn                                              | YES -- location is specific and accurate                |
| CRITICAL-005 | State machine has no implementation spec         | M4: Simplified to stateless health check with cache (pragmatic)                                                              | YES -- pragmatic and testable                           |
| CRITICAL-006 | Fallback operates at tier level, not model level | M3+M5: Fallback uses Claude tier names (opus/sonnet/haiku), documented mapping table                                         | YES -- mapping table is correct                         |
| CRITICAL-007 | GLM-4.7-FlashX not configurable via 3-tier proxy | M3: FlashX assigned to MIDDLE_MODEL slot, addressable as `claude-cli/sonnet`                                                 | YES -- correctly resolves the constraint                |

### Risk Register Top 3

| Risk                                        | Score                                                                          | Plan Resolution                                                                                                                                                                         | Verified |
| ------------------------------------------- | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| R001: GLM-4.7 tool calling instability (20) | M5: Health check + FailoverError + DISABLE_THINKING=true                       | PARTIAL -- DISABLE_THINKING is in compose template (M4) but no explicit retry logic for tool-call parse failures. Deferred to proxy responsibility. Acceptable for initial integration. |
| R002: Proxy SPOF (16)                       | M4+M5: Pre-flight health check with 30s cache + Docker restart policy          | YES -- health check location confirmed in `cli-runner.ts`, cache mechanism specified                                                                                                    |
| R003: API key exposure (15)                 | M6: Extended clearEnv + .gitignore enforcement + Docker secrets recommendation | YES -- multi-layer defense documented                                                                                                                                                   |

### Cross-ADR Issues

| Issue                                      | Resolution                                                         | Verified |
| ------------------------------------------ | ------------------------------------------------------------------ | -------- |
| X-001: Tool calling contradiction          | ADR-001 amendment (Appendix A)                                     | YES      |
| X-002: ADR-002/ADR-004 overlap             | M2+M4 clear boundary: M2 owns wizard UI, M4 owns Docker operations | YES      |
| X-003: Fallback model names vs proxy tiers | M3+M5: Fallback expressed in tier names                            | YES      |
| X-004: No end-to-end integration test      | M7: 4 integration test suites                                      | YES      |
| X-005: Duplicate AuthChoiceGroupId         | M1: Both definitions updated simultaneously                        | YES      |

---

## 3. SMART Criteria Assessment per Milestone

### M1: Type System Foundation

| Criterion      | Assessment                                                                     | Score |
| -------------- | ------------------------------------------------------------------------------ | :---: |
| **Specific**   | Clearly bounded: 2 files modified, specific line numbers, specific type values |  5/5  |
| **Measurable** | `tsc --noEmit` with zero errors, 5 acceptance criteria                         |  5/5  |
| **Achievable** | S effort, no dependencies, TypeScript type additions are low-risk              |  5/5  |
| **Relevant**   | Foundational -- every subsequent milestone depends on it                       |  5/5  |
| **Time-bound** | Estimated at Day 1-2, effort is S (Small)                                      |  4/5  |

**SMART Score: 24/25 -- PASS**

### M2: Wizard Onboarding Flow

| Criterion      | Assessment                                                                          | Score |
| -------------- | ----------------------------------------------------------------------------------- | :---: |
| **Specific**   | 2 new files, 2 modified files, function signatures specified, flow diagram provided |  5/5  |
| **Measurable** | 5 acceptance criteria with specific config values to verify                         |  5/5  |
| **Achievable** | M effort, follows established patterns (xai handler as reference)                   |  4/5  |
| **Relevant**   | Core user-facing feature -- wizard is the primary onboarding path                   |  5/5  |
| **Time-bound** | Estimated at Day 3-5, effort is M (Medium)                                          |  4/5  |

**SMART Score: 23/25 -- PASS**

Note: Achievable score reduced by 1 because the dual-dispatch pattern (handler chain + `configure.gateway-auth.ts` pre-check) adds complexity. See GAP-01.

### M3: Backend Config and Model Mapping

| Criterion      | Assessment                                               | Score |
| -------------- | -------------------------------------------------------- | :---: |
| **Specific**   | 1 new file, concrete exports with exact model ID strings |  5/5  |
| **Measurable** | 5 acceptance criteria, SMALL_MODEL invariant testable    |  5/5  |
| **Achievable** | S effort, no runtime behavior changes, pure constants    |  5/5  |
| **Relevant**   | Centralizes model IDs, consumed by M2 and M4             |  5/5  |
| **Time-bound** | Estimated at Day 2-3, effort is S (Small)                |  5/5  |

**SMART Score: 25/25 -- PASS**

### M4: Proxy Lifecycle Management

| Criterion      | Assessment                                                                  | Score |
| -------------- | --------------------------------------------------------------------------- | :---: |
| **Specific**   | 2 new files, function signatures provided, Docker compose template detailed |  5/5  |
| **Measurable** | 8 acceptance criteria, each testable                                        |  5/5  |
| **Achievable** | M effort, requires Docker knowledge, HTTP mock for tests                    |  4/5  |
| **Relevant**   | Infrastructure foundation for proxy integration                             |  5/5  |
| **Time-bound** | Estimated at Week 2 Day 1-3, effort is M (Medium)                           |  4/5  |

**SMART Score: 23/25 -- PASS**

### M5: Health Monitoring and Fallback Integration

| Criterion      | Assessment                                                                 | Score |
| -------------- | -------------------------------------------------------------------------- | :---: |
| **Specific**   | 3 files modified, exact insertion points specified, code snippets provided |  5/5  |
| **Measurable** | 6 acceptance criteria, clearEnv count verifiable                           |  5/5  |
| **Achievable** | M effort, modifies core runtime files -- higher risk                       |  3/5  |
| **Relevant**   | Reliability and security -- addresses R002, R007                           |  5/5  |
| **Time-bound** | Estimated at Week 2 Day 3-5, effort is M (Medium)                          |  4/5  |

**SMART Score: 22/25 -- PASS with concern**

Achievable score reduced because: (a) `clearEnv` modification affects global behavior (GAP-02), (b) `FailoverError` for proxy-unhealthy needs careful integration with fallback mechanism (GAP-04), (c) modifying `cli-runner.ts` is high-risk given it handles all CLI agent execution.

### M6: Security Hardening

| Criterion      | Assessment                                                                 | Score |
| -------------- | -------------------------------------------------------------------------- | :---: |
| **Specific**   | 1 new file, 2 modified files, validation function signatures provided      |  5/5  |
| **Measurable** | 6 acceptance criteria with specific test cases                             |  5/5  |
| **Achievable** | S effort, mostly validation utilities with no runtime impact on happy path |  5/5  |
| **Relevant**   | Directly addresses STRIDE threats E-04, S-01, S-02                         |  5/5  |
| **Time-bound** | Estimated at Week 3 Day 1-2, effort is S (Small)                           |  5/5  |

**SMART Score: 25/25 -- PASS**

### M7: Integration Testing and Quality Gates

| Criterion      | Assessment                                                               | Score |
| -------------- | ------------------------------------------------------------------------ | :---: |
| **Specific**   | 4 test suites, specific test scenarios, cross-ADR verification checklist |  5/5  |
| **Measurable** | QCSD quality gates with checkboxes, build/lint/test pass criteria        |  5/5  |
| **Achievable** | L effort, requires mock HTTP server and Docker for integration tests     |  4/5  |
| **Relevant**   | Validates entire integration chain                                       |  5/5  |
| **Time-bound** | Estimated at Week 3 Day 2-5, effort is L (Large)                         |  4/5  |

**SMART Score: 23/25 -- PASS**

### SMART Summary

| Milestone   |    Score    | Verdict           |
| ----------- | :---------: | ----------------- |
| M1          |    24/25    | PASS              |
| M2          |    23/25    | PASS              |
| M3          |    25/25    | PASS              |
| M4          |    23/25    | PASS              |
| M5          |    22/25    | PASS with concern |
| M6          |    25/25    | PASS              |
| M7          |    23/25    | PASS              |
| **Average** | **23.6/25** | **PASS**          |

---

## 4. File Reference Accuracy

### Files to Modify (Verified Against Codebase)

| File Path in Plan                                 | Actual Path Verified                                                                               | Exists |                                       Line References Accurate                                        |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | :----: | :---------------------------------------------------------------------------------------------------: |
| `upstream/src/commands/onboard-types.ts`          | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-types.ts`          |  YES   |         YES -- AuthChoice lines 5-47 (43 members), AuthChoiceGroupId lines 48-66 (17 values)          |
| `upstream/src/commands/auth-choice-options.ts`    | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice-options.ts`    |  YES   |         YES -- AuthChoiceGroupId lines 10-30 (20 values), AUTH_CHOICE_GROUP_DEFS lines 39-165         |
| `upstream/src/commands/auth-choice.apply.ts`      | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice.apply.ts`      |  YES   |                            YES -- handlers array lines 43-55 (11 handlers)                            |
| `upstream/src/commands/configure.gateway-auth.ts` | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/configure.gateway-auth.ts` |  YES   |         YES -- `promptAuthConfig` lines 46-103, `authChoice === "custom-api-key"` at line 60          |
| `upstream/src/agents/cli-backends.ts`             | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cli-backends.ts`             |  YES   | YES -- `clearEnv` at line 51, `DEFAULT_CLAUDE_BACKEND` lines 30-53, `mergeBackendConfig` lines 95-110 |
| `upstream/src/agents/cli-runner.ts`               | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cli-runner.ts`               |  YES   |    YES -- `resolveCliBackendConfig` call at line 72, `backend` at line 76, env build lines 222-228    |

### Files Referenced but Not Modified

| File                                                      |                    Exists                     | Purpose in Plan                                 |
| --------------------------------------------------------- | :-------------------------------------------: | ----------------------------------------------- |
| `upstream/src/agents/pi-embedded-helpers.ts`              |                      YES                      | `classifyFailoverReason()` modification in M5   |
| `upstream/src/agents/model-fallback.ts`                   |                      YES                      | Referenced for fallback mechanism understanding |
| `upstream/src/auto-reply/reply/agent-runner-execution.ts` |                      YES                      | Referenced for `runAgentTurnWithFallback()`     |
| `upstream/src/agents/failover-error.ts`                   | YES (implied by import at `cli-runner.ts:29`) | `FailoverError` class                           |

### Key Line Reference Verification

| Claim in Plan                                          | Actual Code                                                                                        |               Status                |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- | :---------------------------------: |
| M1: "AuthChoice after line 46, before `skip`"          | Line 47 is `"skip";` -- correct insertion point                                                    |               CORRECT               |
| M1: "AuthChoiceGroupId after line 65, before `custom`" | Line 66 is `"custom";` -- correct insertion point                                                  |               CORRECT               |
| M2: "auth-choice.apply.ts handlers array lines 43-55"  | Lines 43-55 contain the handlers array with 11 entries                                             |               CORRECT               |
| M2: "configure.gateway-auth.ts:59-60 pre-check"        | Line 59 is `let next = cfg;`, line 60 is `if (authChoice === "custom-api-key")`                    | CORRECT -- insertion before line 60 |
| M5: "cli-runner.ts after line 76"                      | Line 76 is `const backend = backendResolved.config;` -- correct insertion after backend resolution |               CORRECT               |
| M5: "clearEnv at line 51"                              | Line 51 is `clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],`                             |               CORRECT               |

**File Reference Verdict: ALL VERIFIED ACCURATE**

---

## 5. Dependency DAG Validation

### DAG Structure (from plan)

```
M1 (Type Foundation)
  |
  +--> M2 (Wizard Onboarding)
  |       |
  |       +--> M4 (Proxy Lifecycle)
  |
  +--> M3 (Backend Config + Model Mapping)
          |
          +--> M5 (Health Monitoring + Fallback)
                  |
                  +--> M6 (Security Hardening)
                          |
                          +--> M7 (Integration Testing + Quality Gates)
```

### Circular Dependency Check

No circular dependencies found. The DAG is a valid directed acyclic graph.

### Dependency Accuracy

| Dependency Claim        | Verified  | Notes                                                                                                                                                                                                              |
| ----------------------- | :-------: | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| M2 depends on M1        |    YES    | M2 uses AuthChoice values defined in M1                                                                                                                                                                            |
| M3 depends on M1        |    YES    | M3 constants are referenced by M2 code that uses M1 types                                                                                                                                                          |
| M4 depends on M2 and M3 | PARTIALLY | M4 depends on M3 (constants), but its dependency on M2 is weaker -- M4 creates `proxy-health.ts` and `proxy-docker.ts` which M2 imports. This is actually the reverse: M2 depends on M4, not M4 on M2. See GAP-05. |
| M5 depends on M3 and M4 |    YES    | M5 uses M4's health check and M3's constants                                                                                                                                                                       |
| M6 depends on M4 and M5 |    YES    | M6 validates configs built by M4 and M5                                                                                                                                                                            |
| M7 depends on M1-M6     |    YES    | Integration testing requires all prior milestones                                                                                                                                                                  |

### Critical Path

```
M1 -> M3 -> M5 -> M6 -> M7  (5 milestones, longest path)
```

Estimated time for critical path: S + S + M + S + L = ~13-17 days

### Parallel Opportunities

| Parallel Pair        | Plan Claims                                         |                                                                                                    Verified                                                                                                     |
| -------------------- | --------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: |
| M2 and M3 after M1   | Can run in parallel                                 |                                                                                  YES -- M2 and M3 have no mutual dependencies                                                                                   |
| M6 partially with M5 | Docker security is independent of health check code | PARTIALLY -- M6's `proxy-security.ts` has no dependency on M5, but M6's `cli-backends.ts` URL validation modification does depend on M5's `clearEnv` extension being complete first (both modify the same file) |

### Dependency Concern: M2 <-> M4 Circularity Risk

The plan states "M4 depends on M2" but M2's `onboard-cloudru-fm.ts` imports from M4's `proxy-docker.ts`. This suggests M2 and M4 have a bidirectional dependency. The plan resolves this by specifying that M2 creates shell functions that call M4 utilities, and M4 creates the utilities. However, this means M2 cannot be fully tested until M4 is complete. The practical implication is that M2 and M4 should be developed together, not sequentially.

**Recommendation:** Reorder to M1 -> M3 -> M4 -> M2 -> M5 -> M6 -> M7, or develop M2 and M4 as a single milestone.

---

## 6. Security Gap Analysis

### API Key Handling

| Security Measure                       | Plan Coverage                      | STRIDE Threat | Status                         |
| -------------------------------------- | ---------------------------------- | ------------- | ------------------------------ |
| API key in `.env`, not `openclaw.json` | M2 (wizard writes to `.env`)       | I-01, I-02    | COVERED                        |
| `.gitignore` enforcement               | M2 + M6 (auto-add entries)         | I-01          | COVERED                        |
| Sentinel value for proxy key           | M3 (`"not-a-real-key-proxy-only"`) | R024          | COVERED                        |
| `clearEnv` extension                   | M5 (8 variables)                   | R007          | COVERED (GAP-02 concern)       |
| Docker secrets recommendation          | M6 (documented)                    | I-01          | DOCUMENTED but not implemented |

### Localhost Binding

| Security Measure                        | Plan Coverage             | STRIDE Threat | Status  |
| --------------------------------------- | ------------------------- | ------------- | ------- |
| `127.0.0.1` port binding                | M4 (compose template)     | S-01, R008    | COVERED |
| `HOST: "0.0.0.0"` documentation         | M4 (comment in compose)   | WARNING-003   | COVERED |
| URL validation for `ANTHROPIC_BASE_URL` | M6 (`validateProxyUrl()`) | S-02, T-03    | COVERED |

### Docker Security Profile

| Security Measure                         | Plan Coverage             | STRIDE Threat | Status  |
| ---------------------------------------- | ------------------------- | ------------- | ------- |
| `security_opt: [no-new-privileges:true]` | M4 (compose template)     | E-01          | COVERED |
| `cap_drop: [ALL]`                        | M4 (compose template)     | E-01          | COVERED |
| `read_only: true`                        | M4 (compose template)     | E-01          | COVERED |
| `user: "1000:1000"`                      | M6 (mentioned in compose) | E-01          | COVERED |
| Resource limits (512M, 1 CPU)            | M4 (compose template)     | D-02          | COVERED |
| Pinned image version                     | M3+M4 (`v1.0.0`)          | S-03          | COVERED |

### Remaining STRIDE Gaps Not Addressed

| Threat                                          | Severity | Plan Status                                                              | Assessment                                                                |
| ----------------------------------------------- | -------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------- |
| S-04: Cloud.ru DNS/MITM                         | Medium   | NOT ADDRESSED                                                            | Acceptable for initial integration -- HTTPS provides baseline protection  |
| T-01: Proxy response injection (localhost HTTP) | High     | NOT ADDRESSED                                                            | Acceptable for localhost-only deployment. Document as future improvement. |
| T-04: System prompt injection                   | Medium   | NOT ADDRESSED                                                            | Deferred item in plan. Acceptable -- cross-cutting concern.               |
| R-01: Unaudited proxy request forwarding        | High     | NOT ADDRESSED                                                            | Should be documented as a known limitation                                |
| R-02: Missing config change audit trail         | Medium   | NOT ADDRESSED                                                            | Low priority for initial integration                                      |
| I-03: Sensitive data in model responses         | Medium   | NOT ADDRESSED                                                            | Cross-cutting concern, deferred                                           |
| I-04: System prompt leakage                     | Medium   | NOT ADDRESSED                                                            | Cross-cutting concern, deferred                                           |
| D-01: Rate limit exhaustion                     | High     | PARTIALLY -- cloud.ru error patterns added to `classifyFailoverReason()` | No per-user rate limiting or circuit breaker                              |
| D-03: Model timeout cascade                     | High     | PARTIALLY -- health check prevents dead proxy requests                   | No total fallback timeout budget                                          |
| D-04: Subprocess accumulation                   | Medium   | NOT ADDRESSED                                                            | Existing cleanup in `cli-runner.ts` provides baseline                     |
| E-02: Tool re-enablement via prompt bypass      | Critical | DOCUMENTED in M6 as known limitation                                     | No hard `--no-tools` flag used                                            |
| E-03: System prompt injection / jailbreak       | High     | DEFERRED                                                                 | Acceptable -- documented in deferred items                                |

**Security Gap Verdict:** The plan addresses all CRITICAL-severity STRIDE threats at the infrastructure level (E-01, E-04, I-01, S-01) and defers application-level threats (prompt injection, PII filtering) as cross-cutting concerns. This is an acceptable trade-off for an initial integration.

---

## 7. Missing Requirements Identification

### MUST Fix (Blocking)

#### GAP-01: Dual Dispatch Ambiguity in M2

**Problem:** M2 specifies a dual-path integration:

1. Register `applyAuthChoiceCloudruFm` in the handler array in `auth-choice.apply.ts:43-55`
2. Add a pre-check in `configure.gateway-auth.ts:59-60` that invokes `promptCloudruFmSetup` from `onboard-cloudru-fm.ts`

Looking at the actual code in `configure.gateway-auth.ts`:

```typescript
if (authChoice === "custom-api-key") {
  const customResult = await promptCustomApiConfig({ prompter, runtime, config: next });
  next = customResult.config;
} else if (authChoice !== "skip") {
  const applied = await applyAuthChoice({ authChoice, config: next, ... });
  next = applied.config;
}
```

Any authChoice that is not `"custom-api-key"` or `"skip"` flows into `applyAuthChoice()`, which iterates through the handlers array. If `applyAuthChoiceCloudruFm` is registered in the handlers array, it will be invoked for `cloudru-fm-*` choices WITHOUT the pre-check in `configure.gateway-auth.ts`.

The plan adds a pre-check BEFORE the `custom-api-key` check, creating a different code path for `cloudru-fm-*` that calls `promptCloudruFmSetup` instead of `applyAuthChoiceCloudruFm`. This means:

- The handler array handler (`applyAuthChoiceCloudruFm`) handles **programmatic** invocation
- The pre-check (`promptCloudruFmSetup`) handles **interactive wizard** invocation

This is a reasonable pattern BUT it means the `configure.gateway-auth.ts` pre-check will short-circuit before reaching `applyAuthChoice()`, so the handler in the array will NEVER execute in the wizard flow. If the intent is for both to run, this is a bug. If only the pre-check should run in the wizard, then the handler array registration is for non-interactive mode only -- and this should be explicitly documented.

**Fix Required:** Clarify in the plan which code path executes in which scenario. Either:

- (a) Remove the pre-check and let ALL cloudru-fm choices flow through the handler chain (simpler), OR
- (b) Document that the pre-check is for interactive wizard (Docker setup prompts needed) and the handler is for non-interactive/programmatic use (e.g., `--authChoice cloudru-fm-flash` CLI flag)

#### GAP-02: clearEnv Modification Scope in M5

**Problem:** M5 proposes extending `clearEnv` in `DEFAULT_CLAUDE_BACKEND` from 2 to 8 entries:

```typescript
clearEnv: [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_API_KEY_OLD",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_OPENAI_API_KEY",
  "CLOUDRU_API_KEY",
],
```

This modifies the GLOBAL `DEFAULT_CLAUDE_BACKEND` constant, which affects ALL `claude-cli` backends, not just the cloudru-fm configuration. If a user has a `claude-cli` backend that legitimately uses `OPENAI_API_KEY` or `GOOGLE_API_KEY` (e.g., through a different proxy setup), this change will break their configuration by clearing those environment variables from the subprocess.

**Fix Required:** Either:

- (a) Move the extended `clearEnv` to the cloudru-fm-specific override config in M2 (only applied when cloudru-fm is configured), OR
- (b) Add a note that this is a security-hardening change that applies to ALL `claude-cli` backends, and document the potential regression, OR
- (c) Use the `mergeBackendConfig()` behavior that already does `clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])]))` -- meaning the cloudru-fm override can ADD entries to the base `clearEnv` without modifying the base definition

Option (c) is the least disruptive and most architecturally correct.

#### GAP-03: No Rollback Procedure

**Problem:** No milestone defines a rollback procedure for failed implementation. If M2 partially modifies `auth-choice.apply.ts` and `configure.gateway-auth.ts` but then fails tests, there is no documented recovery path. This is particularly important for milestones that modify existing files (M1, M2, M5).

**Fix Required:** Add a rollback section to each milestone that modifies existing files. For a git-based workflow, this can be as simple as: "Rollback: `git checkout -- <modified files>`". But for milestones that create new files, document: "Rollback: remove created files and revert modified files."

#### GAP-04: FailoverError Proxy-Unhealthy Integration Contradiction

**Problem:** M5 states:

1. The health check throws `FailoverError` with reason `"proxy-unhealthy"` (line 674)
2. "A proxy-unhealthy error should NOT trigger model fallback (switching from opus to sonnet won't help if the proxy is down)"

These are contradictory. `FailoverError` is the MECHANISM that `runWithModelFallback()` uses to trigger fallback. If you throw a `FailoverError`, the fallback mechanism will attempt the next model. The plan acknowledges this contradiction but does not specify HOW the fallback handler should skip backends sharing the same proxy URL.

**Fix Required:** Specify the exact mechanism to prevent proxy-unhealthy errors from triggering model fallback. Options:

- (a) Add a `skipFallback: true` property to the `FailoverError` for `"proxy-unhealthy"` reason, and modify `runWithModelFallback()` to respect it
- (b) Throw a different error type (not `FailoverError`) that is NOT caught by the fallback mechanism
- (c) Add a `proxyRequired: true` flag to fallback candidates so the fallback mechanism skips all candidates with the same proxy dependency

### SHOULD Fix (Non-Blocking)

#### GAP-05: M2/M4 Dependency Direction

**Problem:** The DAG shows M4 depending on M2, but the actual code dependency is bidirectional: M2's `onboard-cloudru-fm.ts` imports from M4's `proxy-docker.ts` and `proxy-health.ts`. This means M2 cannot be fully completed without M4.

**Recommendation:** Reorder milestones to M1 -> M3 -> M4 -> M2 -> M5 -> M6 -> M7, or note that M2 and M4 should be developed as a unit.

#### GAP-06: No CI/CD Integration Plan

**Problem:** The plan mentions `npm test`, `npm run lint`, `npm run build` as quality gates but does not specify CI/CD pipeline integration. No GitHub Actions workflow, no pre-commit hooks, no automated quality gate checks.

**Recommendation:** Add a section to M7 specifying CI/CD integration: test execution in CI, lint in pre-commit, build verification before merge.

#### GAP-07: No Error Handling Specification for Wizard User-Facing Errors

**Problem:** M2 specifies the wizard flow but does not define user-facing error messages for common failure scenarios:

- What does the user see if their cloud.ru API key is invalid?
- What does the user see if Docker is not installed?
- What does the user see if the proxy health check fails after setup?

The wizard "gracefully handles Docker not being installed" but the specific message and recovery guidance is not specified.

**Recommendation:** Add a user-facing error message table to M2 and M4.

#### GAP-08: No Monitoring or Alerting Specification

**Problem:** The plan addresses runtime health checking but defines no monitoring, alerting, or observability requirements. There is no specification for:

- Proxy health check failure rate metrics
- Fallback event frequency logging
- API key usage tracking
- Container restart count alerting

These were identified in the risk analysis (WARNING-011, R-01) and the STRIDE model (R-01, D-02) but are not addressed in the implementation plan.

**Recommendation:** Add a monitoring specification to M5 or M7, even if implementation is deferred.

#### GAP-09: `configure.gateway-auth.ts` Modification Placement

**Problem:** M2 specifies inserting a new `if` block before line 60 in `configure.gateway-auth.ts`. Looking at the actual code:

```typescript
let next = cfg;                          // line 59
if (authChoice === "custom-api-key") {   // line 60
```

The plan's code snippet shows:

```typescript
if (authChoice.startsWith("cloudru-fm-")) {
  // ...
} else if (authChoice === "custom-api-key") {
```

This changes the existing `if` to an `else if`, which is correct syntactically but means cloudru-fm and custom-api-key are mutually exclusive (which they should be). However, this also means the ENTIRE existing `if/else if/else` chain is being restructured, not just "adding a pre-check." The plan should explicitly show the full modified block to avoid errors.

**Recommendation:** Show the complete modified `if/else if/else` chain in M2, not just the insertion snippet.

#### GAP-10: `auth-choice-options.ts` Missing `chutes` AuthChoice

**Problem:** The current `onboard-types.ts` includes `"chutes"` as an AuthChoice (line 11), and `buildAuthChoiceOptions` includes it (line 184), but `AUTH_CHOICE_GROUP_DEFS` does not include a group containing `"chutes"`. This pre-existing inconsistency means `"chutes"` has no group in the grouped wizard view. The plan does not address this.

**Recommendation:** This is a pre-existing issue, not introduced by the plan. No action required, but document it as a known upstream inconsistency.

#### GAP-11: Test File Organization

**Problem:** The plan creates 8 test files in paths like `tests/commands/...` and `tests/agents/...`. However, the existing test file is at `upstream/src/auto-reply/reply/agent-runner.claude-cli.test.ts` -- tests are colocated with source, not in a separate `tests/` directory. The plan does not clarify whether the new test files should be colocated or in a separate directory.

**Recommendation:** Clarify test file placement strategy. If following the existing codebase convention, tests should be colocated (e.g., `upstream/src/commands/auth-choice.apply.cloudru-fm.test.ts`).

#### GAP-12: Docker Compose File Naming

**Problem:** The plan uses `docker-compose.cloudru-proxy.yml` as the filename, but the Docker Compose v2 CLI uses `docker compose` (without hyphen) and the standard filename is `compose.yaml` or `docker-compose.yml`. A non-standard filename like `docker-compose.cloudru-proxy.yml` requires the `-f` flag: `docker compose -f docker-compose.cloudru-proxy.yml up`.

**Recommendation:** Document the exact `docker compose` command the user should run, including the `-f` flag.

#### GAP-13: No Documentation Deliverables Specified

**Problem:** The plan's deferred items section mentions no documentation deliverables. M7 says "Documentation complete" as a quality gate but does not specify what documentation should be produced:

- User-facing setup guide
- Troubleshooting guide
- Architecture documentation update
- CHANGELOG entry

**Recommendation:** Add a documentation deliverables list to M7.

---

## 8. Updated Risk Register

### New Risks Identified During Validation

| Risk ID | Description                                                                                      | Likelihood | Impact | Score | Milestone |
| ------- | ------------------------------------------------------------------------------------------------ | :--------: | :----: | :---: | --------- |
| R026    | Dual dispatch in M2 causes wizard flow to skip handler chain, leaving programmatic path untested |     3      |   3    |   9   | M2        |
| R027    | Extended `clearEnv` in global DEFAULT_CLAUDE_BACKEND breaks non-cloudru-fm `claude-cli` users    |     2      |   4    |   8   | M5        |
| R028    | `FailoverError("proxy-unhealthy")` triggers model fallback to same-proxy backends, wasting time  |     3      |   3    |   9   | M5        |
| R029    | M2/M4 bidirectional dependency causes incomplete module if developed sequentially                |     2      |   3    |   6   | M2/M4     |
| R030    | Test files in non-standard location vs. codebase convention causes confusion                     |     1      |   2    |   2   | M7        |

### Modified Risk Scores (from original register)

| Risk ID | Original Score | Updated Score | Reason                                                                                       |
| ------- | :------------: | :-----------: | -------------------------------------------------------------------------------------------- |
| R002    |       16       |      12       | Plan addresses with pre-flight health check + cache. Residual risk remains for cache window. |
| R005    |       12       |       6       | Plan updates BOTH AuthChoiceGroupId definitions simultaneously (M1).                         |
| R013    |       9        |       4       | Plan pins Docker image to `v1.0.0`.                                                          |
| R024    |       4        |       2       | Sentinel value changed to `"not-a-real-key-proxy-only"`.                                     |

---

## 9. INVEST Criteria Assessment (Milestone Level)

| Criterion       |  M1  |   M2    |  M3  |   M4    |  M5  |  M6  |  M7  |
| --------------- | :--: | :-----: | :--: | :-----: | :--: | :--: | :--: |
| **Independent** | PASS | PARTIAL | PASS | PARTIAL | PASS | PASS | FAIL |
| **Negotiable**  | PASS |  PASS   | PASS |  PASS   | PASS | PASS | PASS |
| **Valuable**    | PASS |  PASS   | PASS |  PASS   | PASS | PASS | PASS |
| **Estimable**   | PASS |  PASS   | PASS |  PASS   | PASS | PASS | PASS |
| **Small**       | PASS |  PASS   | PASS |  PASS   | PASS | PASS | FAIL |
| **Testable**    | PASS |  PASS   | PASS |  PASS   | PASS | PASS | PASS |

Notes:

- M2 PARTIAL on Independent: bidirectional dependency with M4 (GAP-05)
- M4 PARTIAL on Independent: bidirectional dependency with M2
- M7 FAIL on Independent: depends on all other milestones
- M7 FAIL on Small: L effort with 4 test suites, could be split

---

## 10. Final Recommendation

### CONDITIONAL GO

The implementation plan is comprehensive, well-researched, and demonstrates excellent traceability from shift-left findings through to specific code changes. The SPARC methodology is applied consistently, and the dependency DAG is sound. File references have been verified accurate against the actual codebase.

### Conditions for GO

The following 4 blocking gaps MUST be resolved before implementation begins:

| Gap                                                 | Fix                                                                          | Effort | Owner       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- | ------ | ----------- |
| GAP-01: Dual dispatch ambiguity                     | Clarify interactive vs. programmatic paths; document which handler runs when | 30 min | Plan author |
| GAP-02: clearEnv global scope                       | Move extended clearEnv to cloudru-fm override config, not global DEFAULT     | 15 min | Plan author |
| GAP-03: No rollback procedure                       | Add rollback section to each milestone (git revert commands)                 | 30 min | Plan author |
| GAP-04: FailoverError proxy-unhealthy contradiction | Specify mechanism to prevent proxy-unhealthy from triggering model fallback  | 45 min | Plan author |

**Estimated fix time: 2 hours**

### Improvements (SHOULD address before development)

| Gap                                          | Priority | Effort |
| -------------------------------------------- | -------- | ------ |
| GAP-05: M2/M4 dependency direction           | P1       | 15 min |
| GAP-09: Show full modified if/else chain     | P1       | 15 min |
| GAP-11: Test file organization convention    | P1       | 15 min |
| GAP-07: User-facing error messages           | P2       | 1 hour |
| GAP-12: Docker compose command documentation | P2       | 15 min |
| GAP-06: CI/CD integration plan               | P3       | 1 hour |
| GAP-08: Monitoring specification             | P3       | 1 hour |
| GAP-13: Documentation deliverables           | P3       | 30 min |

### Strengths of the Plan

1. **Exhaustive traceability**: Every shift-left finding (CRITICAL-001 through X-005) is tracked to a specific milestone with explicit resolution
2. **Accurate file references**: All line numbers and file paths verified against actual codebase
3. **Security-first approach**: STRIDE threats addressed systematically across M4/M5/M6
4. **Pragmatic simplifications**: State machine simplified to stateless health check (CRITICAL-005) -- correct engineering judgment
5. **ADR amendment recommendations**: Appendix A provides specific text changes to resolve documentation contradictions
6. **Centralized constants**: M3 creates a single source of truth for model IDs (R019 mitigation)
7. **Comprehensive test strategy**: 8 test files covering unit, integration, security, and regression

### Overall Quality Score

| Dimension    |  Score  | Notes                                                      |
| ------------ | :-----: | ---------------------------------------------------------- |
| Coverage     |   95%   | All 5 ADRs covered; 4 minor gaps                           |
| Accuracy     |   98%   | All file references verified correct                       |
| Testability  |   90%   | 8 test suites; missing monitoring tests                    |
| Security     |   85%   | Infrastructure threats covered; application-level deferred |
| Completeness |   82%   | Missing rollback, CI/CD, documentation deliverables        |
| **Overall**  | **90%** | **CONDITIONAL GO**                                         |
