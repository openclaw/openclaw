# QCSD Ideation: Quality Criteria Analysis (HTSM v6.3)

## Metadata

| Field                         | Value                                                    |
| ----------------------------- | -------------------------------------------------------- |
| **Analysis Framework**        | HTSM v6.3 (Heuristic Test Strategy Model)                |
| **Analyst**                   | qe-quality-criteria-recommender                          |
| **Date**                      | 2026-02-12                                               |
| **Scope**                     | ADR-001 through ADR-005, Shift-left reports (01, 03)     |
| **System Under Analysis**     | OpenClaw + Claude Code + claude-code-proxy + cloud.ru FM |
| **Overall Testability Score** | 64/100 (from requirements validation report)             |

---

## Executive Summary

This analysis evaluates all 10 HTSM v6.3 quality criteria categories against 5 Architecture Decision Records that define the integration of OpenClaw (AI gateway) with cloud.ru Foundation Models via claude-code-proxy and Claude Code as the agentic execution engine.

**Key findings**:

- 3 categories at P0 (Capability, Reliability, Security) -- blocking concerns identified
- 2 categories at P1 (Performance, Development) -- significant gaps to address
- 3 categories at P2 (Usability, Compatibility, Installability) -- moderate concerns
- 2 categories at P3 (Charisma, Scalability) -- acceptable for initial deployment

**Critical quality gaps**: The system's capability claims are internally contradictory (tool calling stated as available in ADR-001 but disabled in ADR-003). Reliability depends entirely on a single Docker container with no proven health monitoring. Security relies on defense-in-depth layers that are not all correctly configured.

---

## Category 1: Capability

**HTSM Question**: Can the system perform its required functions?

| Attribute             | Value                                                        |
| --------------------- | ------------------------------------------------------------ |
| **Priority**          | P0 -- System cannot deliver value without correct capability |
| **Weight**            | 25%                                                          |
| **Testability Score** | 58/100                                                       |

### Evidence

**Evidence 1: Proxy Protocol Translation (Direct)**

- Source: ADR-001, lines 19-23, 27-29
- Claude Code speaks Anthropic API protocol. Cloud.ru FM speaks OpenAI-compatible protocol. The proxy must translate between them including model names, auth headers, message formats, and tool calling formats.
- Evidence Type: Direct (ADR-001, docker-compose config at lines 52-72)
- The proxy's translation covers request headers (`x-api-key` to `Authorization: Bearer`), endpoints (`/messages` to `/v1/chat/completions`), and model mapping (`claude-opus-4-6` to `zai-org/GLM-4.7`).

**Evidence 2: Tool Calling Contradiction (Direct)**

- Source: ADR-001 line 103 vs ADR-003 lines 69-79
- ADR-001 positive consequences claim: "Full multi-agent architecture available (tool calling, MCP, sessions)". ADR-003 explicitly states tools are disabled: `cli-runner.ts:82-83` injects "Tools are disabled in this session. Do not call tools."
- Evidence Type: Direct (shift-left report CRITICAL-001, X-001)
- These two ADRs directly contradict. Stakeholders reading ADR-001 would expect tool calling to work.

**Evidence 3: Model Fallback Chain Implementation Gap (Direct)**

- Source: ADR-005 lines 57-63, shift-left report CRITICAL-006, CRITICAL-007
- The fallback chain references `GLM-4.7-FlashX` which is not configurable in the proxy's 3-tier mapping (BIG/MIDDLE/SMALL). Fallback operates at Claude Code tier level (opus/sonnet/haiku), not at cloud.ru model level, but this is not documented.
- Evidence Type: Direct (ADR-005 fallback chain, ADR-001 docker-compose env)

**Evidence 4: Wizard Configuration Flow (Direct)**

- Source: ADR-002 lines 70-79
- 5-step wizard flow: select provider, select model, enter API key, check proxy status, auto-configure. Creates both the cloud.ru provider config and the claude-cli backend override.
- Evidence Type: Direct (ADR-002 wizard flow specification)

**Evidence 5: Session Persistence (Direct)**

- Source: ADR-003 lines 63-65
- `sessionMode: "always"` with `--session-id` and `--resume` flags provide conversation continuity across messages.
- Evidence Type: Direct (ADR-003, cli-backends.ts:30-53)

### Quality Implication

If the proxy translation is not fully faithful, every user request could fail or produce garbled output. The tool calling contradiction means capability is systematically overstated. The fallback chain may not work as documented because `GLM-4.7-FlashX` cannot be addressed through the 3-tier proxy mapping. These are not theoretical -- they are structural gaps identified through code-level analysis.

### Business Impact

- **Overstated capability**: Stakeholders approving the architecture based on ADR-001's "full multi-agent architecture" claim would discover that tool calling, MCP, and file operations are all disabled. Decision reversal or re-scoping would be required.
- **Fallback failure**: When the primary model fails (GLM-4.7 tool calling instability rated at risk score 20 in the risk analysis), the documented fallback chain cannot execute as designed. Users would hit ERROR instead of graceful degradation.
- **Estimated impact**: 40-60% of complex multi-step requests may fail if GLM-4.7 tool calling instability triggers without a working fallback path.

### Recommended Test Focus

1. End-to-end protocol translation conformance test (Anthropic request -> proxy -> OpenAI request -> cloud.ru mock -> response chain)
2. Fallback chain integration test using Claude Code tier names (opus -> sonnet -> haiku)
3. Verify wizard generates valid, complete configuration for all 3 model choices
4. Session create/resume cycle with at least 10 turns through the proxy

---

## Category 2: Reliability

**HTSM Question**: Will the system resist failure under specified conditions?

| Attribute             | Value                                                              |
| --------------------- | ------------------------------------------------------------------ |
| **Priority**          | P0 -- Single point of failure architecture with no proven recovery |
| **Weight**            | 20%                                                                |
| **Testability Score** | 52/100                                                             |

### Evidence

**Evidence 1: Single Point of Failure (Direct)**

- Source: ADR-001 line 110, Risk analysis R002 (score 16, CRITICAL)
- "Single point of failure (proxy crash = no LLM)". All LLM requests flow through one Docker container. If it crashes, ALL users are affected simultaneously.
- Evidence Type: Direct (ADR-001 negative consequences, risk register R002)

**Evidence 2: Docker Restart Policy (Direct)**

- Source: ADR-001 line 66
- `restart: unless-stopped` in docker-compose. Docker health check configured with 30s interval, 10s timeout, 3 retries.
- Evidence Type: Direct (ADR-001 docker-compose)
- Limitation: Health check only verifies the process responds, not that protocol translation is functional.

**Evidence 3: Health Check Implementation Gap (Direct)**

- Source: ADR-004 lines 66-70, shift-left report CRITICAL-004
- "OpenClaw should verify proxy health before routing to `claude-cli` backend" -- but no implementation location is specified. The guidance says "Add a pre-flight check in `runCliAgent()` or at the `agent-runner.ts` routing layer" which is ambiguous.
- Evidence Type: Direct (ADR-004, shift-left CRITICAL-004)

**Evidence 4: State Machine Without Implementation (Direct)**

- Source: ADR-004 lines 18-25, shift-left report CRITICAL-005
- State machine `UNDEPLOYED -> DEPLOYING -> RUNNING -> HEALTHY -> UNHEALTHY -> RECOVERING` is documented visually but has no TypeScript type, no transition guards, no error states (Docker not installed, port conflict), and no persistence mechanism.
- Evidence Type: Direct (ADR-004, shift-left CRITICAL-005)

**Evidence 5: GLM-4.7 Tool Calling Instability (Direct)**

- Source: ADR-001 line 30, risk analysis R001 (score 20, CRITICAL)
- GLM-4.7 has documented tool calling instabilities (sglang issue #15721). This is the highest-scored risk in the entire analysis. Claude Code's internal reasoning pipeline relies on tool_use format communication with the model.
- Evidence Type: Direct (ADR-001, sglang #15721 reference)

**Evidence 6: Subprocess Timeout (Inferred)**

- Source: ADR-003, shift-left WARNING-007
- `runCommandWithTimeout` is used but no invariant documents the default timeout or expected timeout behavior. A hung proxy or slow cloud.ru response could block the serialized queue indefinitely.
- Evidence Type: Inferred (shift-left warning, no explicit ADR coverage)

### Quality Implication

The architecture has a single point of failure (proxy) with a health monitoring design that exists only on paper (ADR-004 state machine). The highest-scored risk in the entire system (R001, GLM-4.7 tool calling, score 20) directly impacts reliability of every request. There is no circuit breaker, no automatic failover to an alternative backend, and no user-visible degradation signal.

### Business Impact

- **Total outage duration**: If the proxy crashes and Docker restart takes 10-30s, ALL users experience a complete outage during that window. With `serialize: true`, a queue of pending requests will timeout or pile up.
- **GLM-4.7 failure rate**: Risk analysis estimates medium probability for tool calling failures. If 10-20% of requests trigger GLM-4.7 instabilities, and the fallback chain is broken (per Capability findings), the effective reliability drops to 80-90% at best.
- **Recovery time**: No documented RTO (Recovery Time Objective). Docker `restart: unless-stopped` provides automatic recovery, but no SLA for recovery duration.

### Recommended Test Focus

1. Chaos test: kill proxy container during active request, measure time to recovery and verify user gets a meaningful error
2. Load test: sustained 15 req/s for 5 minutes, verify proxy container memory and response times
3. Timeout test: mock cloud.ru with 120s delay, verify subprocess timeout fires and queue is not permanently blocked
4. Health check integration test: verify the (yet to be implemented) health check prevents requests from reaching a dead proxy

---

## Category 3: Security

**HTSM Question**: Is the system protected against unauthorized use and data exposure?

| Attribute             | Value                                                 |
| --------------------- | ----------------------------------------------------- |
| **Priority**          | P0 -- API key exposure rated CRITICAL (risk score 15) |
| **Weight**            | 20%                                                   |
| **Testability Score** | 55/100                                                |

### Evidence

**Evidence 1: API Key Exposure Chain (Direct)**

- Source: ADR-001 lines 59, 84-85; risk analysis R003 (score 15, CRITICAL)
- The cloud.ru API key flows through: (1) `.env` file on disk, (2) Docker compose environment variable `OPENAI_API_KEY`, (3) `ANTHROPIC_API_KEY` replacement value in openclaw.json, (4) process environment of Claude Code subprocess.
- Evidence Type: Direct (ADR-001 config, risk register R003)

**Evidence 2: `HOST: "0.0.0.0"` Defense-in-Depth Gap (Direct)**

- Source: ADR-001 line 64; shift-left WARNING-003; risk analysis R008 (score 10, HIGH)
- Docker compose sets `HOST: "0.0.0.0"` inside the container while port mapping is `127.0.0.1:8082:8082`. If Docker network mode changes (e.g., `network_mode: host`), the proxy becomes externally accessible with no authentication.
- Evidence Type: Direct (ADR-001 docker-compose, risk analysis R008)

**Evidence 3: `clearEnv` Incomplete Coverage (Direct)**

- Source: ADR-003 line 107; risk analysis R007 (score 12, HIGH)
- `clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]` only clears 2 variables. Host process may have `OPENAI_API_KEY`, `GOOGLE_API_KEY`, `AWS_SECRET_ACCESS_KEY` etc. that leak into every Claude Code subprocess environment.
- Evidence Type: Direct (cli-backends.ts:51, risk register R007)

**Evidence 4: `--dangerously-skip-permissions` Flag (Direct)**

- Source: ADR-003 line 49; risk analysis R012 (score 10, HIGH)
- Claude Code subprocess runs with `--dangerously-skip-permissions` which bypasses permission prompts for ALL tool execution. Tools are disabled via system prompt text injection ("Tools are disabled"), but this is a text-level control that the model could ignore. Combined with GLM-4.7 attention loss issues, the "tools disabled" instruction could be dropped.
- Evidence Type: Direct (cli-backends.ts:32, risk register R012)

**Evidence 5: `.env` File Git Exposure (Direct)**

- Source: ADR-004 line 90
- ".env file -- MUST be in .gitignore" -- documented as a security requirement but no enforcement mechanism (no pre-commit hook specified, no automated scanning).
- Evidence Type: Direct (ADR-004 security considerations)

**Evidence 6: Proxy Has No Authentication (Inferred)**

- Source: Risk analysis R008
- The proxy accepts any request on port 8082 without authentication. If the port is exposed (due to Docker networking misconfiguration), anyone can use the cloud.ru API key for unlimited LLM queries.
- Evidence Type: Inferred (no ADR discusses proxy authentication)

### Quality Implication

The security model relies on multiple independent layers (localhost binding, .env isolation, clearEnv, tools disabled prompt) but each layer has identified gaps. The `--dangerously-skip-permissions` flag combined with a text-only tool disablement creates a defense that can fail if the model ignores system prompt instructions. The proxy has zero authentication, making network security the only barrier to API key abuse.

### Business Impact

- **API key compromise**: Cloud.ru API key allows unlimited model usage at the owner's expense. Full access to all models configured in the account.
- **Unauthorized tool execution**: If GLM-4.7 ignores the "tools disabled" instruction (risk R012), arbitrary file system and network operations could execute with the OpenClaw process permissions. This is a remote code execution vector.
- **Environment variable leakage**: Unrelated API keys (OpenAI, Google, AWS) in the host environment are exposed to Claude Code subprocesses without clear justification.

### Recommended Test Focus

1. Network scan: verify port 8082 is only accessible from 127.0.0.1, not from any external interface
2. Environment audit: spawn Claude Code subprocess, dump its environment, verify only expected variables are present
3. Tool execution test: craft prompts that attempt to trigger tool calling despite "tools disabled" instruction, verify no execution occurs
4. Git scan: verify `.env` and `docker-compose.cloudru-proxy.yml` are in `.gitignore` and not committed
5. Pre-commit hook test: stage a file containing API key patterns, verify commit is blocked

---

## Category 4: Performance

**HTSM Question**: Are speed and responsiveness adequate for the use case?

| Attribute             | Value                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| **Priority**          | P1 -- serialize:true creates a fundamental bottleneck; no latency budget defined |
| **Weight**            | 12%                                                                              |
| **Testability Score** | 48/100                                                                           |

### Evidence

**Evidence 1: `serialize: true` Bottleneck (Direct)**

- Source: ADR-001 line 113; ADR-003 line 95; risk analysis R004 (score 12, HIGH)
- `cli-backends.ts:52` sets `serialize: true`. In `cli-runner.ts:177-178`, this means all requests queue behind a single key. With 10-30s per GLM-4.7 response, 5 concurrent users means the 5th user waits 50-150 seconds.
- Evidence Type: Direct (cli-backends.ts:52, shift-left WARNING-002)

**Evidence 2: Cold Start Latency (Direct)**

- Source: ADR-003 line 94; risk analysis R015 (score 8, MEDIUM)
- "~2-5s startup per cold call" for Claude Code subprocess. Combined with model response time (5-30s) and proxy latency, total end-to-end could reach 35+ seconds.
- Evidence Type: Direct (ADR-003 negative consequences)

**Evidence 3: No Streaming to End User (Direct)**

- Source: ADR-003 line 97; risk analysis R020 (score 8, MEDIUM)
- "No streaming to end user (batch response only)". `runCliAgent()` waits for complete subprocess output. User sees nothing until the entire response is generated.
- Evidence Type: Direct (ADR-003 negative consequences)

**Evidence 4: No Latency Budget or SLA (Inferred)**

- Source: Shift-left report WARNING-001
- No ADR defines target latency. No P50/P95/P99 response time goals. No throughput targets. The architecture adds two network hops (OpenClaw -> Claude Code -> Proxy -> cloud.ru) but does not quantify the expected overhead.
- Evidence Type: Inferred (absence across all ADRs, shift-left WARNING-001)

**Evidence 5: Rate Limit (Direct)**

- Source: ADR-001 line 122; risk analysis R014 (score 6, MEDIUM)
- Cloud.ru FM API has a 15 req/s rate limit. While `serialize: true` limits concurrency, burst scenarios or multiple instances could exhaust this limit.
- Evidence Type: Direct (ADR-001 risk table)

### Quality Implication

The `serialize: true` setting is architecturally incompatible with multi-user deployment. Even with a single user, the cumulative latency (cold start + proxy overhead + model response + no streaming) creates a poor experience compared to direct API integration. No latency budget means there is no way to objectively assess whether performance is "good enough."

### Business Impact

- **User abandonment**: Messaging platform users (Telegram, WhatsApp) expect responses within 5-10 seconds. 35+ second response times with no streaming or typing indicator will drive abandonment.
- **Concurrency ceiling**: With `serialize: true`, the system supports effectively 1 concurrent user. Every additional user adds 10-30 seconds to queue wait time.
- **No measurable SLA**: Without defined targets, performance testing cannot produce pass/fail results. Quality assurance has no acceptance criteria.

### Recommended Test Focus

1. Baseline latency measurement: P50/P95/P99 for single-user cold start and warm start scenarios
2. Queue saturation test: 5 concurrent requests with `serialize: true`, measure wait times
3. `serialize: false` viability test: verify proxy handles 3 concurrent requests without corruption
4. End-to-end latency breakdown: measure each hop (OpenClaw -> subprocess spawn -> proxy -> cloud.ru -> response parse)
5. Rate limit behavior test: mock cloud.ru returning 429, verify backoff and retry

---

## Category 5: Development (Testability/Maintainability)

**HTSM Question**: Is the system testable and maintainable for ongoing development?

| Attribute             | Value                                                                         |
| --------------------- | ----------------------------------------------------------------------------- |
| **Priority**          | P1 -- ADR-004 scored 50/100 testability; multiple code reference inaccuracies |
| **Weight**            | 8%                                                                            |
| **Testability Score** | 64/100 (aggregate from requirements validation)                               |

### Evidence

**Evidence 1: Code Reference Accuracy Varies (Direct)**

- Source: Shift-left report code reference tables
- ADR-001 and ADR-003 have high code reference accuracy (all CORRECT or MINOR). ADR-002 has an INACCURATE reference (`configure.gateway-auth.ts:60` is the wrong integration point). ADR-004 has UNVERIFIABLE references.
- Evidence Type: Direct (shift-left report code accuracy tables)

**Evidence 2: ADR-004 Testability Score Lowest (Direct)**

- Source: Shift-left report ADR-004 section, score 50/100
- ADR-004 has the lowest testability: state machine has no implementation spec, health check location is ambiguous, Docker lifecycle is not test-automatable in CI.
- Evidence Type: Direct (shift-left report testability scores)

**Evidence 3: Existing Integration Test Confirmed (Direct)**

- Source: ADR-003 line 115; shift-left report verified file references
- `agent-runner.claude-cli.test.ts` exists and provides a test anchor for the CLI agent execution path.
- Evidence Type: Direct (file existence verified in shift-left appendix)

**Evidence 4: DDD Invariants as Test Anchors (Direct)**

- Source: ADR-003 lines 100-107
- Three invariants are well-defined: session identity mapping, backend resolution null-check, and environment isolation via clearEnv. These are directly testable.
- Evidence Type: Direct (ADR-003 invariants section)

**Evidence 5: Cross-ADR Inconsistencies (Direct)**

- Source: Shift-left report X-001 through X-005
- 5 cross-ADR issues identified: tool calling contradiction (X-001), wizard/lifecycle overlap (X-002), fallback model name mismatch (X-003), no end-to-end test spec (X-004), duplicate type definition (X-005).
- Evidence Type: Direct (shift-left cross-ADR issues)

**Evidence 6: Handler Naming Convention Broken (Direct)**

- Source: Shift-left report CRITICAL-003
- ADR-002 uses `applyCloudruFmChoice` instead of `applyAuthChoiceCloudruFm`, breaking the established `applyAuthChoice<Provider>` pattern used throughout the codebase.
- Evidence Type: Direct (shift-left CRITICAL-003)

### Quality Implication

The development quality is uneven: ADR-001 and ADR-003 are well-referenced and testable, while ADR-002 and ADR-004 have significant gaps. The 5 cross-ADR inconsistencies indicate the ADRs were written somewhat independently without a final consistency review. ADR-004's low testability (50/100) means the proxy lifecycle component will be the hardest to test and maintain.

### Business Impact

- **Implementation risk**: An implementer following ADR-002 verbatim would modify the wrong file at the wrong line (`configure.gateway-auth.ts:60`) and use the wrong naming convention. This costs debugging time.
- **Maintenance burden**: 5 files must be modified for the wizard extension, model IDs are hardcoded in multiple locations, and the `AuthChoiceGroupId` type is duplicated across two files that already diverge.
- **Test gap**: No end-to-end integration test is specified anywhere across 5 ADRs. The testing strategy must be constructed from scratch.

### Recommended Test Focus

1. Compile-time verification: `tsc --noEmit` after all type extensions
2. Exhaustive dispatch test: every `AuthChoice` value must route to a handler
3. Code reference regression test: verify ADR-referenced line numbers are still accurate after implementation
4. Cross-ADR consistency check: automated test that tool calling claims match actual runtime behavior

---

## Category 6: Usability

**HTSM Question**: Is the system easy to use for its intended audience?

| Attribute             | Value                                                      |
| --------------------- | ---------------------------------------------------------- |
| **Priority**          | P2 -- Wizard is the primary user touchpoint for onboarding |
| **Weight**            | 5%                                                         |
| **Testability Score** | 45/100                                                     |

### Justification for Inclusion

Included because the wizard (ADR-002) is the primary user-facing component and the first touchpoint for cloud.ru FM onboarding. Poor usability here directly impacts adoption.

### Evidence

**Evidence 1: 5-Step Wizard Flow (Direct)**

- Source: ADR-002 lines 70-79
- The wizard has a 5-step flow: select provider, select model, enter API key, check proxy, auto-configure. The GLM-4.7-Flash (Free) option is the default, which reduces friction.
- Evidence Type: Direct (ADR-002 wizard flow)

**Evidence 2: No Acceptance Criteria for Wizard UX (Direct)**

- Source: Shift-left report ADR-002 testability, score 45 for "success criteria measurable"
- "First-class wizard experience" has no metric. "Auto-configures both provider AND claude-cli backend in one flow" has no acceptance test.
- Evidence Type: Direct (shift-left ADR-002 analysis)

**Evidence 3: 20+ Auth Provider Groups (Direct)**

- Source: ADR-002 line 12
- The wizard already supports 18+ auth provider groups. Adding cloudru-fm increases cognitive load. The array position affects discoverability.
- Evidence Type: Direct (ADR-002 context section)

**Evidence 4: Proxy Deployment Adds Wizard Complexity (Direct)**

- Source: ADR-002 line 109; ADR-004 lines 82-86
- Step 4 (proxy deployment check) introduces Docker as a dependency within an otherwise config-only wizard flow. Users without Docker face a dead end.
- Evidence Type: Direct (ADR-002 negative consequences, ADR-004 negative consequences)

### Quality Implication

The wizard flow is well-structured but adds Docker as a hidden dependency that only surfaces at step 4 (after the user has already selected cloud.ru FM and entered their API key). No graceful degradation is specified for Docker absence. The growing provider list (20+ groups) needs filtering/search but none is discussed.

### Business Impact

- **Onboarding abandonment**: Users who reach step 4 and discover they need Docker may abandon the wizard with a partially configured system.
- **Support burden**: "First-class experience" without metrics means support tickets for wizard confusion cannot be tracked or resolved systematically.

### Recommended Test Focus

1. Wizard happy-path test: complete flow for each of the 3 model choices, verify correct config output
2. Docker absence test: run wizard without Docker installed, verify user gets clear guidance at step 4 (not a crash)
3. Wizard regression test: verify all 18+ existing auth providers still work after cloudru-fm addition

---

## Category 7: Charisma

**HTSM Question**: Does the system make a good first impression and inspire confidence?

| Attribute             | Value                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| **Priority**          | P3 -- Important for developer adoption but secondary to functional correctness |
| **Weight**            | 2%                                                                             |
| **Testability Score** | 35/100                                                                         |

### Justification for Inclusion

Included because the system targets developers who will evaluate it against alternatives (direct API, OpenCode CLI). First impression through the wizard and initial response quality determines continued usage.

### Evidence

**Evidence 1: Default Free Tier (Direct)**

- Source: ADR-005 line 83; ADR-002 line 102
- GLM-4.7-Flash is the default model and is free tier. Zero cost barrier to entry is a strong charisma factor.
- Evidence Type: Direct (ADR-005 positive consequences, ADR-002 positive consequences)

**Evidence 2: No Streaming Creates Poor First Response (Direct)**

- Source: ADR-003 line 97; risk analysis R020
- First interaction has 35+ second wait with no feedback. Modern LLM interfaces stream tokens. The batch-response approach feels archaic.
- Evidence Type: Direct (ADR-003 negative consequences)

**Evidence 3: Sentinel Value Confusion (Direct)**

- Source: Risk analysis R024 (score 4, LOW)
- `ANTHROPIC_API_KEY: "cloudru-proxy-key"` in config looks like a real credential. New users may be confused about what this is and whether they need an Anthropic key.
- Evidence Type: Direct (ADR-001 config, risk register R024)

### Quality Implication

The free tier default is an excellent charisma decision. However, the long response latency without streaming undermines the "task quality HIGHER than model quality" value proposition because users cannot see the quality until after a long wait. The sentinel value adds unnecessary confusion during setup.

### Business Impact

- **Competitive positioning**: 35+ second response times with no streaming put the system at a disadvantage against direct API integrations that stream tokens within 1-2 seconds.
- **Zero-cost entry**: Free tier default is a strong adoption driver. Estimated 70%+ of trial users will start with GLM-4.7-Flash.

### Recommended Test Focus

1. Time-to-first-response measurement: from user message to first visible output
2. Wizard completion rate: track how many users complete the full wizard flow vs abandon
3. Sentinel value clarity: verify wizard output explains the proxy key is not a real credential

---

## Category 8: Scalability

**HTSM Question**: Can the system grow beyond the initial deployment constraints?

| Attribute             | Value                                                                       |
| --------------------- | --------------------------------------------------------------------------- |
| **Priority**          | P3 -- Not a concern for initial single-user deployment; critical for growth |
| **Weight**            | 3%                                                                          |
| **Testability Score** | 30/100                                                                      |

### Justification for Inclusion

Included because `serialize: true` is an explicit scalability ceiling documented in the ADRs. Even modest growth (2-3 concurrent users) will expose this bottleneck.

### Evidence

**Evidence 1: `serialize: true` is a Hard Ceiling (Direct)**

- Source: ADR-001 line 113; ADR-003 line 95; risk analysis R004
- Exactly 1 request can be processed at a time. Every additional concurrent user adds the full response time (10-30s) to queue wait.
- Evidence Type: Direct (cli-backends.ts:52, risk register R004)

**Evidence 2: Single Proxy Instance (Direct)**

- Source: ADR-001 line 111
- "Proxy does not support multi-provider routing". There is no discussion of running multiple proxy instances or load balancing between them.
- Evidence Type: Direct (ADR-001 negative consequences)

**Evidence 3: Cloud.ru Rate Limit (Direct)**

- Source: ADR-001 line 122
- 15 req/s rate limit. Even with `serialize: false`, the external API has a hard throughput cap.
- Evidence Type: Direct (ADR-001 risk table)

### Quality Implication

The system is architecturally limited to 1 concurrent user. Scaling requires removing `serialize: true` (untested), deploying multiple proxy instances (not designed for), and operating within cloud.ru's 15 req/s rate limit. None of these paths are documented.

### Business Impact

- **User capacity**: With serialize=true and 15s average response time, maximum throughput is 4 requests/minute or 240 requests/hour.
- **Growth path**: No documented scaling strategy means growth will require architectural rework.

### Recommended Test Focus

1. Concurrency test: `serialize: false` with 3 concurrent requests through the proxy
2. Multi-proxy test: 2 proxy instances behind a load balancer, verify correct behavior
3. Rate limit saturation test: approach 15 req/s, verify graceful degradation

---

## Category 9: Compatibility

**HTSM Question**: Does the system work correctly with existing components?

| Attribute             | Value                                                                        |
| --------------------- | ---------------------------------------------------------------------------- |
| **Priority**          | P2 -- Integration with existing OpenClaw plugin ecosystem and auth providers |
| **Weight**            | 3%                                                                           |
| **Testability Score** | 60/100                                                                       |

### Justification for Inclusion

Included because the integration touches existing type systems (`AuthChoice`, `AuthChoiceGroupId`) that are used across multiple files and have an existing duplicate-definition problem.

### Evidence

**Evidence 1: AuthChoiceGroupId Duplicate Type (Direct)**

- Source: Shift-left report WARNING-004, X-005
- `AuthChoiceGroupId` is defined in both `onboard-types.ts` and `auth-choice-options.ts` with existing differences (`litellm`, `together` appear in one but not the other). Adding `cloudru-fm` to only one will cause type errors.
- Evidence Type: Direct (shift-left WARNING-004, cross-ADR X-005)

**Evidence 2: `mergeBackendConfig()` Shallow Merge (Direct)**

- Source: Risk analysis R011 (score 8, MEDIUM)
- `args` override replaces the entire array. If a cloudru-fm config override includes partial args, critical flags (`-p`, `--output-format json`) are lost.
- Evidence Type: Direct (cli-backends.ts:95-110, risk register R011)

**Evidence 3: Existing `claude-cli` Backend Used Unmodified (Direct)**

- Source: ADR-001 line 102; ADR-003 line 86
- "Zero changes to OpenClaw core -- uses existing `claude-cli` backend". The integration is env-override-only, preserving compatibility with all existing OpenClaw features.
- Evidence Type: Direct (ADR-001 and ADR-003 positive consequences)

**Evidence 4: Model Naming Inconsistency (Direct)**

- Source: Shift-left WARNING-010
- ADR-005 uses short names (`GLM-4.7`) while ADR-001 uses full IDs (`zai-org/GLM-4.7`). This inconsistency could cause confusion when values are compared across ADR boundaries.
- Evidence Type: Direct (shift-left WARNING-010)

### Quality Implication

The env-override approach is minimally invasive and preserves existing OpenClaw compatibility. However, the type system changes required for the wizard (ADR-002) touch a pre-existing tech debt issue (duplicate type definitions) that could cause regression across the entire wizard for all providers.

### Business Impact

- **Regression risk**: Type system changes that break exhaustive matching could affect all 18+ existing auth provider groups, not just cloud.ru FM.
- **Config compatibility**: Shallow merge behavior means manual config editing (common for advanced users) could silently break critical subprocess flags.

### Recommended Test Focus

1. Regression test: all existing auth providers still function after cloudru-fm type additions
2. `mergeBackendConfig()` test: verify critical flags preserved across all merge scenarios
3. Type compilation test: `tsc --noEmit` with both `AuthChoiceGroupId` definitions extended

---

## Category 10: Installability

**HTSM Question**: Can the system be installed and configured correctly?

| Attribute             | Value                                                                   |
| --------------------- | ----------------------------------------------------------------------- |
| **Priority**          | P2 -- Docker dependency and proxy setup are the primary friction points |
| **Weight**            | 2%                                                                      |
| **Testability Score** | 42/100                                                                  |

### Justification for Inclusion

Included because the installation requires Docker (a non-trivial dependency), a multi-step wizard, and a Docker compose deployment. This is significantly more complex than a typical config-only integration.

### Evidence

**Evidence 1: Docker Prerequisite (Direct)**

- Source: ADR-004 line 84; risk analysis R017 (score 6, MEDIUM)
- "Requires Docker installed on host". No check for Docker availability before starting the wizard. No graceful degradation path.
- Evidence Type: Direct (ADR-004 negative consequences, risk register R017)

**Evidence 2: Port Conflict (Direct)**

- Source: Shift-left WARNING-009
- Default port 8082 may conflict with other services. No port availability check in the wizard.
- Evidence Type: Direct (shift-left WARNING-009)

**Evidence 3: Docker Compose Generation (Direct)**

- Source: ADR-004 lines 29-39
- Wizard generates `docker-compose.cloudru-proxy.yml` with template variables. File is workspace-specific, not portable.
- Evidence Type: Direct (ADR-004 section 1)

**Evidence 4: Proxy Image `:latest` Tag (Direct)**

- Source: ADR-001 line 55; risk analysis R013 (score 9, MEDIUM)
- `image: legard/claude-code-proxy:latest` means any Docker pull gets an unpredictable version. No version pinning in the wizard output.
- Evidence Type: Direct (ADR-001 docker-compose, risk register R013)

**Evidence 5: No Rollback on Partial Failure (Inferred)**

- Source: Risk analysis R017
- If Docker deployment fails at step 4, the wizard has already written provider config (steps 1-3). No rollback mechanism exists. User is left with a broken partial configuration.
- Evidence Type: Inferred (risk register R017, no ADR coverage of rollback)

### Quality Implication

The installation path has multiple failure points (Docker not installed, port conflict, image pull failure, proxy health check failure) with no rollback mechanism. Users who fail at step 4 or 5 must manually clean up partial configurations. The `:latest` tag means the installation is not reproducible.

### Business Impact

- **Failed installations**: Users without Docker (estimated 20-30% of developer machines) will hit a dead end at step 4.
- **Non-reproducible setup**: `:latest` tag means two users installing on different days may get different proxy versions with different behaviors.
- **Support burden**: Partial configuration failures require manual JSON editing to fix, generating support tickets.

### Recommended Test Focus

1. Docker absence test: verify wizard detects Docker unavailability before step 4
2. Port conflict test: occupy port 8082, verify wizard detects and offers alternative
3. Image pull failure test: mock Docker registry unavailability, verify meaningful error
4. Full install-to-first-message test: from zero config to successful LLM response

---

## Cross-Category Summary Matrix

| #   | Category           | Priority | Weight | Testability | Top Risk                                   | Key Finding                                                                                         |
| --- | ------------------ | -------- | ------ | ----------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| 1   | **Capability**     | P0       | 25%    | 58/100      | Tool calling contradiction (CRITICAL-001)  | ADR-001 overstates system capability; fallback chain not implementable as documented                |
| 2   | **Reliability**    | P0       | 20%    | 52/100      | Proxy SPOF (R002, score 16)                | Single Docker container with no runtime health monitoring; GLM-4.7 instability (R001, score 20)     |
| 3   | **Security**       | P0       | 20%    | 55/100      | API key exposure chain (R003, score 15)    | Multiple defense layers, each with gaps; no proxy authentication; dangerously-skip-permissions flag |
| 4   | **Performance**    | P1       | 12%    | 48/100      | serialize:true bottleneck (R004, score 12) | 1 concurrent user ceiling; 35+ sec response time; no streaming; no latency budget                   |
| 5   | **Development**    | P1       | 8%     | 64/100      | ADR-004 testability (50/100)               | Uneven ADR quality; cross-ADR contradictions; wrong integration point in ADR-002                    |
| 6   | **Usability**      | P2       | 5%     | 45/100      | Docker dead-end in wizard                  | 5-step wizard well-designed but Docker dependency surfaces too late                                 |
| 7   | **Charisma**       | P3       | 2%     | 35/100      | 35+ sec first response                     | Free tier excellent; batch-response-only undermines first impression                                |
| 8   | **Scalability**    | P3       | 3%     | 30/100      | serialize:true ceiling                     | Architecturally limited to 1 concurrent user; no documented scaling path                            |
| 9   | **Compatibility**  | P2       | 3%     | 60/100      | Duplicate AuthChoiceGroupId                | Env-override approach preserves existing compatibility; type system changes carry regression risk   |
| 10  | **Installability** | P2       | 2%     | 42/100      | Docker prerequisite with no check          | Multiple failure points with no rollback; non-reproducible due to :latest tag                       |

---

## Aggregate Risk Heatmap

```
                    Testability
              Low (<50)    Medium (50-70)    High (>70)
           +--------------+-----------------+----------+
  P0       | Reliability  | Capability      |          |
  (Block)  | Security     |                 |          |
           +--------------+-----------------+----------+
  P1       | Performance  | Development     |          |
  (Should) |              |                 |          |
           +--------------+-----------------+----------+
  P2       | Usability    | Compatibility   |          |
  (Could)  | Installabil. |                 |          |
           +--------------+-----------------+----------+
  P3       | Charisma     |                 |          |
  (Won't)  | Scalability  |                 |          |
           +--------------+-----------------+----------+
```

**Interpretation**: The P0 categories (Reliability, Security) have LOW testability, meaning the highest-priority quality concerns are also the hardest to verify. This is the most dangerous quadrant and requires immediate attention before implementation begins.

---

## Top 10 Test Recommendations (Priority Ordered)

| #   | Category       | Test                                                             | Priority | Effort | Risks Addressed            |
| --- | -------------- | ---------------------------------------------------------------- | -------- | ------ | -------------------------- |
| 1   | Security       | Network scan: verify proxy only accessible on 127.0.0.1          | P0       | 1h     | R003, R008                 |
| 2   | Reliability    | Chaos test: kill proxy during active request, verify recovery    | P0       | 4h     | R001, R002                 |
| 3   | Capability     | End-to-end protocol translation conformance test                 | P0       | 8h     | R006, CRITICAL-006         |
| 4   | Security       | Environment variable audit for subprocess                        | P0       | 2h     | R007, R012                 |
| 5   | Performance    | Baseline latency: P50/P95/P99 single-user with breakdown per hop | P1       | 4h     | R015, WARNING-001          |
| 6   | Capability     | Fallback chain integration test using Claude Code tier names     | P1       | 4h     | CRITICAL-006, CRITICAL-007 |
| 7   | Development    | `tsc --noEmit` compilation after all type extensions             | P1       | 1h     | R005, X-005                |
| 8   | Installability | Wizard with Docker absent: verify graceful handling              | P2       | 2h     | R017, WARNING-008          |
| 9   | Performance    | Concurrency test: serialize:false with 3 concurrent requests     | P2       | 4h     | R004                       |
| 10  | Usability      | Wizard regression: all 18+ existing providers still work         | P2       | 2h     | R005, R021                 |

---

## Quality Gates

### Gate 1: Pre-Implementation (P0 blockers)

- [ ] ADR-001 tool calling claim corrected or qualified
- [ ] ADR-005 fallback chain rewritten using Claude Code tier names
- [ ] ADR-002 integration point corrected from line 60 to auth-choice.apply.ts:43-55
- [ ] ADR-004 health check implementation location specified concretely

### Gate 2: Pre-Deployment (P1 should-fix)

- [ ] Proxy health check implemented and tested
- [ ] Docker image pinned to specific version (not `:latest`)
- [ ] `clearEnv` extended to cover common sensitive variable patterns
- [ ] Latency budget defined: P95 proxy overhead < 500ms, P95 total < 60s
- [ ] `serialize: false` tested or concurrency limitation documented prominently

### Gate 3: Pre-Multi-User (P2 could-fix)

- [ ] Docker prerequisite check in wizard
- [ ] Port conflict detection
- [ ] Wizard regression tests for all existing providers
- [ ] Fallback monitoring metrics implemented
- [ ] End-to-end integration test automated

---

## Evidence Traceability Matrix

| Evidence ID        | Source Document  | Category Used In         | Evidence Type |
| ------------------ | ---------------- | ------------------------ | ------------- |
| ADR-001:19-23      | ADR-001          | Capability               | Direct        |
| ADR-001:55         | ADR-001          | Installability           | Direct        |
| ADR-001:59         | ADR-001          | Security                 | Direct        |
| ADR-001:64         | ADR-001          | Security                 | Direct        |
| ADR-001:66         | ADR-001          | Reliability              | Direct        |
| ADR-001:103        | ADR-001          | Capability               | Direct        |
| ADR-001:110        | ADR-001          | Reliability              | Direct        |
| ADR-001:111        | ADR-001          | Scalability              | Direct        |
| ADR-001:113        | ADR-001          | Performance, Scalability | Direct        |
| ADR-001:122        | ADR-001          | Performance, Scalability | Direct        |
| ADR-002:12         | ADR-002          | Usability                | Direct        |
| ADR-002:70-79      | ADR-002          | Capability, Usability    | Direct        |
| ADR-002:102        | ADR-002          | Charisma                 | Direct        |
| ADR-002:109        | ADR-002          | Usability                | Direct        |
| ADR-003:49         | ADR-003          | Security                 | Direct        |
| ADR-003:63-65      | ADR-003          | Capability               | Direct        |
| ADR-003:69-79      | ADR-003          | Capability, Security     | Direct        |
| ADR-003:94         | ADR-003          | Performance              | Direct        |
| ADR-003:95         | ADR-003          | Performance, Scalability | Direct        |
| ADR-003:97         | ADR-003          | Performance, Charisma    | Direct        |
| ADR-003:100-107    | ADR-003          | Development              | Direct        |
| ADR-003:115        | ADR-003          | Development              | Direct        |
| ADR-004:18-25      | ADR-004          | Reliability              | Direct        |
| ADR-004:29-39      | ADR-004          | Installability           | Direct        |
| ADR-004:66-70      | ADR-004          | Reliability              | Direct        |
| ADR-004:84         | ADR-004          | Installability           | Direct        |
| ADR-004:90         | ADR-004          | Security                 | Direct        |
| ADR-005:57-63      | ADR-005          | Capability               | Direct        |
| ADR-005:83         | ADR-005          | Charisma                 | Direct        |
| SL-01:CRITICAL-001 | Shift-left 01    | Capability               | Direct        |
| SL-01:CRITICAL-002 | Shift-left 01    | Development              | Direct        |
| SL-01:CRITICAL-003 | Shift-left 01    | Development              | Direct        |
| SL-01:CRITICAL-004 | Shift-left 01    | Reliability              | Direct        |
| SL-01:CRITICAL-006 | Shift-left 01    | Capability               | Direct        |
| SL-01:CRITICAL-007 | Shift-left 01    | Capability               | Direct        |
| SL-01:WARNING-001  | Shift-left 01    | Performance              | Direct        |
| SL-01:WARNING-002  | Shift-left 01    | Performance              | Direct        |
| SL-01:WARNING-003  | Shift-left 01    | Security                 | Direct        |
| SL-01:WARNING-004  | Shift-left 01    | Compatibility            | Direct        |
| SL-01:WARNING-009  | Shift-left 01    | Installability           | Direct        |
| SL-01:WARNING-010  | Shift-left 01    | Compatibility            | Direct        |
| SL-01:X-001        | Shift-left 01    | Capability               | Direct        |
| SL-01:X-005        | Shift-left 01    | Compatibility            | Direct        |
| RA:R001            | Risk Analysis 03 | Reliability              | Direct        |
| RA:R002            | Risk Analysis 03 | Reliability              | Direct        |
| RA:R003            | Risk Analysis 03 | Security                 | Direct        |
| RA:R004            | Risk Analysis 03 | Performance, Scalability | Direct        |
| RA:R007            | Risk Analysis 03 | Security                 | Direct        |
| RA:R008            | Risk Analysis 03 | Security                 | Direct        |
| RA:R011            | Risk Analysis 03 | Compatibility            | Direct        |
| RA:R012            | Risk Analysis 03 | Security                 | Direct        |
| RA:R013            | Risk Analysis 03 | Installability           | Direct        |
| RA:R015            | Risk Analysis 03 | Performance              | Direct        |
| RA:R017            | Risk Analysis 03 | Installability           | Direct        |
| RA:R020            | Risk Analysis 03 | Charisma, Performance    | Direct        |
| RA:R024            | Risk Analysis 03 | Charisma                 | Direct        |

---

## Appendix: Source Documents Analyzed

| #   | Document      | Path                                                                                                     | Used For                                                    |
| --- | ------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1   | ADR-001       | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/adr/ADR-001-cloudru-fm-proxy-integration.md`      | All categories                                              |
| 2   | ADR-002       | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/adr/ADR-002-wizard-cloudru-auth-choice.md`        | Capability, Usability, Compatibility, Development           |
| 3   | ADR-003       | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/adr/ADR-003-claude-code-agentic-engine.md`        | Capability, Reliability, Security, Performance, Development |
| 4   | ADR-004       | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/adr/ADR-004-proxy-lifecycle-management.md`        | Reliability, Security, Installability                       |
| 5   | ADR-005       | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/adr/ADR-005-model-mapping-fallback-strategy.md`   | Capability, Charisma, Scalability                           |
| 6   | Shift-left 01 | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/shift-left-testing/01-requirements-validation.md` | All categories                                              |
| 7   | Shift-left 03 | `/home/user/ceo-vibe-coding/src/openclaw-extended/docs/shift-left-testing/03-risk-analysis.md`           | All categories                                              |

---

_Analysis generated by qe-quality-criteria-recommender using HTSM v6.3 framework. All evidence is traced to source documents with line-level references where available. Evidence types are classified as Direct (with file reference), Inferred (derived from absence or combination of sources), or Claimed (stated without verification)._
