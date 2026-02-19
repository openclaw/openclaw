# Shift-Left Testing: Requirements Validation Report

## Summary

- **Total ADRs analyzed**: 5
- **Overall testability score**: 64/100
- **Critical issues found**: 7
- **Warnings**: 12
- **Validation date**: 2026-02-12
- **Validator**: qe-requirements-validator (Level 4: Risk Analysis in Design)

### Score Breakdown

| ADR     | Testability | Completeness | Code Accuracy | Security | Overall |
| ------- | :---------: | :----------: | :-----------: | :------: | :-----: |
| ADR-001 |     72      |      75      |      85       |    70    |   72    |
| ADR-002 |     58      |      65      |      68       |    55    |   58    |
| ADR-003 |     78      |      80      |      92       |    65    |   78    |
| ADR-004 |     50      |      45      |      40       |    60    |   50    |
| ADR-005 |     62      |      70      |      75       |   N/A    |   62    |

---

## ADR-001: Cloud.ru FM Integration via Claude Code Proxy

**Testability Score: 72/100**

### Testability Analysis

| Criterion                       | Score | Notes                                                                                   |
| ------------------------------- | :---: | --------------------------------------------------------------------------------------- |
| Automated verification possible |  80   | Health check endpoint is testable; protocol translation verifiable via integration test |
| Success criteria measurable     |  65   | No explicit success metrics (latency, throughput, error rate thresholds)                |
| Acceptance criteria defined     |  70   | Implicit via architecture diagram and config, but not formally stated                   |

**Testable claims:**

- `mergeBackendConfig()` at `cli-backends.ts:95-110` merges user-provided `env` with defaults -- VERIFIED. The function at lines 95-110 performs a spread merge: `env: { ...base.env, ...override.env }`. This is unit-testable.
- `cli-runner.ts:222-228` applies merged env to subprocess -- VERIFIED. Lines 222-228 show `const next = { ...process.env, ...backend.env }` with `clearEnv` deletion. Unit-testable.
- Docker health check at `http://localhost:8082/health` -- testable via integration test.

**Untestable claims:**

- "Full multi-agent architecture available (tool calling, MCP, sessions)" -- no metric or acceptance criteria to verify this statement. Tools are actually disabled per ADR-003 line 82-83.

### Code Reference Accuracy

| Reference                | Claimed                  | Actual                 | Status  |
| ------------------------ | ------------------------ | ---------------------- | :-----: |
| `mergeBackendConfig()`   | `cli-backends.ts:95-110` | Lines 95-110           | CORRECT |
| env application          | `cli-runner.ts:222-228`  | Lines 222-228          | CORRECT |
| `DEFAULT_CLAUDE_BACKEND` | Referenced in text       | Lines 30-53            | CORRECT |
| `clearEnv` behavior      | Referenced in text       | Line 51, lines 224-226 | CORRECT |

### INVEST Criteria

| Criterion       |  Score  | Assessment                                                                      |
| --------------- | :-----: | ------------------------------------------------------------------------------- |
| **Independent** |  PASS   | Can be implemented by deploying Docker + setting env vars, no code changes      |
| **Negotiable**  |  PASS   | Three alternatives documented with scoring                                      |
| **Valuable**    |  PASS   | Business value clear: enables cloud.ru FM via existing Claude Code architecture |
| **Estimable**   | PARTIAL | Docker deployment effort clear, but integration testing effort not estimated    |
| **Small**       |  PASS   | Config-only change, no code modifications to OpenClaw                           |
| **Testable**    | PARTIAL | Health check testable, but no end-to-end acceptance criteria defined            |

### Issues Found

**[CRITICAL-001] Contradictory claim about tool calling availability**

- ADR-001 Consequences line: "Full multi-agent architecture available (tool calling, MCP, sessions)"
- ADR-003 explicitly states tools are DISABLED (`cli-runner.ts:82-83` injects "Tools are disabled in this session").
- These two ADRs directly contradict each other. ADR-001's claim about tool calling is misleading at best, false at worst.
- **Impact**: Stakeholders may expect tool calling to work when it will not.
- **Fix**: ADR-001 should state "Full multi-agent reasoning pipeline available (multi-step reasoning, session persistence). Note: Claude Code tools (file ops, bash) are disabled per ADR-003."

**[WARNING-001] No explicit latency budget or SLA**

- The architecture adds two network hops (OpenClaw -> Claude Code -> Proxy -> cloud.ru FM).
- ADR mentions "~2-5s startup per cold call" in ADR-003 but no target latency for the full chain.
- **Fix**: Add measurable acceptance criteria: e.g., "P95 end-to-end latency < 30s for single-turn, proxy health check < 1s".

**[WARNING-002] `serialize: true` impact not quantified**

- ADR-001 mentions `serialize: true` limits to 1 concurrent request but does not quantify the queueing impact.
- **Fix**: Add load testing acceptance criteria or document expected concurrent user capacity.

**[WARNING-003] `HOST: "0.0.0.0"` in Docker env contradicts localhost-only binding**

- The docker-compose ports section correctly binds `127.0.0.1:8082:8082`, but the `HOST: "0.0.0.0"` environment variable tells the proxy process inside the container to listen on all interfaces.
- While Docker port mapping limits external access, this is a defense-in-depth gap. If the container network mode changes (e.g., `network_mode: host`), the proxy would be exposed.
- **Fix**: Document that `HOST: "0.0.0.0"` is intentional (required for Docker port forwarding) and that the security boundary is the Docker port binding, not the process-level bind.

---

## ADR-002: Wizard Extension -- Cloud.ru FM Auth Choice

**Testability Score: 58/100**

### Testability Analysis

| Criterion                       | Score | Notes                                                                          |
| ------------------------------- | :---: | ------------------------------------------------------------------------------ |
| Automated verification possible |  60   | Type extensions are compiler-verifiable; wizard flow requires integration test |
| Success criteria measurable     |  45   | No acceptance criteria defined; "first-class wizard experience" is subjective  |
| Acceptance criteria defined     |  40   | No explicit pass/fail criteria for wizard flow                                 |

**Testable claims:**

- AuthChoice union type extension: compiler-verifiable (add 3 values, TypeScript will enforce exhaustive matching).
- AUTH_CHOICE_GROUP_DEFS addition: verifiable by checking array length and content.
- `promptAuthConfig` dispatch: verifiable via unit test of the dispatch logic.

**Untestable claims:**

- "first-class cloud.ru FM experience" -- no metric defined.
- "Auto-configures both provider AND claude-cli backend in one flow" -- no acceptance test described.

### Code Reference Accuracy

| Reference                                              | Claimed                                  | Actual                                            |      Status       |
| ------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------- | :---------------: |
| `onboard-types.ts:5-47` AuthChoice                     | 47 members                               | 43 members (lines 5-47)                           | MINOR DISCREPANCY |
| `auth-choice-options.ts:39-165` AUTH_CHOICE_GROUP_DEFS | Array of groups                          | Lines 39-165                                      |      CORRECT      |
| `configure.gateway-auth.ts:46-103` promptAuthConfig    | Dispatches to handlers                   | Lines 46-103                                      |      CORRECT      |
| `configure.gateway-auth.ts:60` dispatch for cloudru-fm | "Add dispatch for cloudru-fm-\* choices" | Line 60 is `if (authChoice === "custom-api-key")` |    INACCURATE     |

**[CRITICAL-002] Incorrect dispatch integration point**

- ADR-002 states: "configure.gateway-auth.ts:60 -- Add dispatch for cloudru-fm-\* choices"
- Line 60 of `configure.gateway-auth.ts` is: `if (authChoice === "custom-api-key") {`
- The actual dispatch does NOT happen in `configure.gateway-auth.ts`. It happens in `auth-choice.apply.ts` via the handler chain pattern (lines 43-55). The `promptAuthConfig` function calls `applyAuthChoice()` which iterates through handlers.
- The correct integration point is to create a NEW handler file `auth-choice.apply.cloudru-fm.ts` and register it in the handlers array in `auth-choice.apply.ts:43-55`.
- **Impact**: An implementer following ADR-002 would modify the wrong file or insert logic in the wrong location.
- **Fix**: Replace integration point 3 with: "`auth-choice.apply.ts:43-55` -- Add `applyAuthChoiceCloudruFm` to the handlers array."

**[CRITICAL-003] Missing integration with handler chain pattern**

- ADR-002 lists integration point 4 as: "`auth-choice.apply.ts` -- Register `applyCloudruFmChoice` handler"
- While this is the correct file, the function naming is inconsistent. The existing pattern uses `applyAuthChoice<Provider>` (e.g., `applyAuthChoiceAnthropic`, `applyAuthChoiceOpenAI`).
- The ADR uses `applyCloudruFmChoice` which breaks the naming convention.
- **Fix**: Rename to `applyAuthChoiceCloudruFm` to match existing convention.

**[WARNING-004] Duplicate `AuthChoiceGroupId` type definition**

- `AuthChoiceGroupId` is defined in BOTH `onboard-types.ts` (lines 48-66) AND `auth-choice-options.ts` (lines 10-30).
- These two definitions ALREADY differ: `auth-choice-options.ts` includes `"litellm"` and `"together"`, while `onboard-types.ts` does NOT.
- ADR-002 only mentions extending `auth-choice-options.ts`, but `onboard-types.ts` also needs updating.
- **Impact**: Adding `"cloudru-fm"` to only one definition will cause type errors or silent mismatches.
- **Fix**: ADR-002 must document that `"cloudru-fm"` needs to be added to BOTH `AuthChoiceGroupId` definitions.

**[WARNING-005] ADR-002 claims AuthChoice has "47 members"**

- Counting the actual `AuthChoice` union type in `onboard-types.ts` (lines 5-47), there are 43 distinct members (including `"skip"`).
- This is a minor factual error but indicates the ADR was not validated against the actual code.

### INVEST Criteria

| Criterion       |  Score  | Assessment                                                                       |
| --------------- | :-----: | -------------------------------------------------------------------------------- |
| **Independent** | PARTIAL | Depends on ADR-001 (proxy) and ADR-004 (proxy lifecycle) for step 4 of wizard    |
| **Negotiable**  |  FAIL   | No alternatives to the wizard approach are discussed                             |
| **Valuable**    |  PASS   | Clear value: simplifies cloud.ru onboarding                                      |
| **Estimable**   |  PASS   | ~150 lines new file + 4 file modifications; effort estimable                     |
| **Small**       |  PASS   | Scope is manageable                                                              |
| **Testable**    | PARTIAL | Type extensions compiler-verifiable, but wizard flow needs integration test spec |

### Domain Events

The three domain events (`CloudruFmProviderConfigured`, `ClaudeCliBackendConfigured`, `ProxyHealthChecked`) are documented but:

- No event schema is defined
- No event bus or handler mechanism is specified
- It is unclear whether these are actual code events or conceptual documentation
- **Fix**: Clarify whether these are actual emitted events or logical milestones. If actual events, provide TypeScript type definitions.

---

## ADR-003: Claude Code as Agentic Execution Engine

**Testability Score: 78/100**

### Testability Analysis

| Criterion                       | Score | Notes                                                                           |
| ------------------------------- | :---: | ------------------------------------------------------------------------------- |
| Automated verification possible |  85   | Existing integration test file confirmed; invariants are code-verifiable        |
| Success criteria measurable     |  70   | Execution flow is deterministic and testable; but quality claims are subjective |
| Acceptance criteria defined     |  65   | DDD invariants serve as implicit acceptance criteria                            |

**Testable claims:**

- `isCliProvider()` routing at `agent-runner.ts:378` -- VERIFIED. Line 378 calls `isCliProvider(providerUsed, cfg)`.
- `resolveCliBackendConfig("claude-cli", cfg)` returns valid config -- VERIFIED. Lines 124-157 of `cli-backends.ts`.
- `clearEnv` removes `ANTHROPIC_API_KEY` -- VERIFIED. Line 51 defines `clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]`, lines 224-226 delete these keys.
- Tools disabled injection -- VERIFIED. Lines 81-84 (not exactly 82-83 as claimed, see below).
- Session ID mapping -- VERIFIED. `resolveSessionIdToSend()` is called at lines 124-127.

### Code Reference Accuracy

| Reference                                      | Claimed                           | Actual                                                    |      Status      |
| ---------------------------------------------- | --------------------------------- | --------------------------------------------------------- | :--------------: |
| `cli-backends.ts:30-53` DEFAULT_CLAUDE_BACKEND | Config object                     | Lines 30-53                                               |     CORRECT      |
| `cli-runner.ts:35-324` runCliAgent             | Full implementation               | Lines 35-324 (with `runClaudeCliAgent` continuing to 362) |     CORRECT      |
| `cli-runner.ts:82-83` Tools disabled           | Injection point                   | Lines 81-84 (4 lines, not 2)                              | MINOR OFF-BY-ONE |
| `agent-runner.ts:378` CLI routing              | `isCliProvider()`                 | Line 378                                                  |     CORRECT      |
| Integration test file                          | `agent-runner.claude-cli.test.ts` | File exists                                               |     CORRECT      |

**[WARNING-006] Tools disabled line reference off-by-one**

- ADR-003 claims `cli-runner.ts:82-83` but the actual code spans lines 81-84:
  ```typescript
  const extraSystemPrompt = [
    // line 81
    params.extraSystemPrompt?.trim(), // line 82
    "Tools are disabled in this session. Do not call tools.", // line 83
  ]; // line 84
  ```
- Lines 82-83 are within the range but the statement starts at line 81.
- **Impact**: Minor, but could confuse an implementer doing a targeted review.

### INVEST Criteria

| Criterion       |  Score  | Assessment                                                                 |
| --------------- | :-----: | -------------------------------------------------------------------------- |
| **Independent** |  PASS   | Uses existing code; depends on ADR-001 only for cloud.ru-specific config   |
| **Negotiable**  | PARTIAL | Alternatives section missing; only mentions "Future ADR" for tool enabling |
| **Valuable**    |  PASS   | Core value proposition clearly articulated with reasoning                  |
| **Estimable**   |  PASS   | Zero code changes; config-only; effort is near-zero                        |
| **Small**       |  PASS   | No code changes needed                                                     |
| **Testable**    |  PASS   | Existing integration test file; DDD invariants provide test anchors        |

### Interface Contracts

The three DDD invariants are well-defined and testable:

1. **Session Identity**: One-to-one mapping, enforced by `resolveSessionIdToSend()` -- verifiable.
2. **Backend Resolution**: `resolveCliBackendConfig` null-check throws -- verifiable.
3. **Environment Isolation**: `clearEnv` + `backend.env` merge -- verifiable.

**[WARNING-007] Missing invariant: subprocess timeout**

- The code uses `runCommandWithTimeout` (line 236) with `params.timeoutMs`, but no invariant documents the expected timeout behavior or default value.
- **Fix**: Add invariant: "CLI subprocess timeout must be bounded. Default: `agents.defaults.timeoutMs` or 120000ms."

---

## ADR-004: Proxy Lifecycle Management

**Testability Score: 50/100**

### Testability Analysis

| Criterion                       | Score | Notes                                                           |
| ------------------------------- | :---: | --------------------------------------------------------------- |
| Automated verification possible |  55   | Health check is testable; Docker lifecycle harder to test in CI |
| Success criteria measurable     |  35   | No SLA for health check latency, no recovery time objectives    |
| Acceptance criteria defined     |  30   | State machine documented but no transition acceptance criteria  |

**Testable claims:**

- `verifyProxyHealth()` function: code sample provided, testable via mock HTTP server.
- State machine transitions: testable if implemented, but no code exists yet.

**Untestable claims:**

- "OpenClaw should verify proxy health before routing to `claude-cli` backend" -- no implementation location specified (says "Add a pre-flight check in `runCliAgent()` or at the `agent-runner.ts` routing layer" -- ambiguous).

### Code Reference Accuracy

| Reference                     | Claimed                      | Actual                                          |    Status    |
| ----------------------------- | ---------------------------- | ----------------------------------------------- | :----------: |
| `docker-compose.yml` template | "in RESEARCH.md section 2.2" | Not verified (RESEARCH.md not in scope)         | UNVERIFIABLE |
| `fetchWithTimeout`            | Used in code sample          | Not verified if this utility exists in codebase | UNVERIFIABLE |

**[CRITICAL-004] No concrete implementation location specified**

- ADR-004 says to add health check "in `runCliAgent()` or at the `agent-runner.ts` routing layer" -- this is ambiguous.
- An implementer cannot determine the correct insertion point.
- **Impact**: Could lead to health check in the wrong layer (per-request vs. routing decision).
- **Fix**: Specify exact location. Recommended: Add health check at the `agent-runner.ts` routing layer (before `runCliAgent` is called) to avoid per-request overhead. Define a caching strategy (e.g., cache health for 30s).

**[CRITICAL-005] State machine has no implementation specification**

- The state machine `UNDEPLOYED -> DEPLOYING -> RUNNING -> HEALTHY -> UNHEALTHY -> RECOVERING -> HEALTHY` is documented visually but:
  - No TypeScript type for the state enum
  - No transition guards defined
  - No error states for deployment failures (e.g., Docker not installed, port conflict)
  - No persistence mechanism for state (in-memory? disk?)
- **Impact**: State machine is untestable without implementation details.
- **Fix**: Add TypeScript enum type, transition guard functions, and specify where state is persisted.

**[WARNING-008] No Docker prerequisite check**

- ADR-004 acknowledges "Requires Docker installed on host" but does not specify what happens when Docker is not available.
- **Fix**: Document graceful degradation: wizard should detect Docker absence and either (a) skip proxy deployment with a warning, or (b) offer manual setup instructions.

**[WARNING-009] No port conflict handling**

- Default port 8082 may conflict with other services.
- **Fix**: Add port availability check to wizard flow. If port is in use, prompt user for alternative.

### INVEST Criteria

| Criterion       |  Score  | Assessment                                                                              |
| --------------- | :-----: | --------------------------------------------------------------------------------------- |
| **Independent** | PARTIAL | Tightly coupled to ADR-001 (proxy config) and ADR-002 (wizard flow)                     |
| **Negotiable**  |  FAIL   | No alternatives discussed (e.g., systemd, Kubernetes, direct process)                   |
| **Valuable**    |  PASS   | Operational reliability is clearly valuable                                             |
| **Estimable**   |  FAIL   | Scope unclear: is this just health check? Or full lifecycle management with monitoring? |
| **Small**       |  FAIL   | Scope too broad: covers deployment, health checks, runtime monitoring, recovery         |
| **Testable**    | PARTIAL | Health check testable; lifecycle management not testable as specified                   |

### Security Assessment

- `.env` in `.gitignore`: documented but no enforcement mechanism (no pre-commit hook specified).
- `127.0.0.1` binding: correctly specified in docker-compose ports.
- "Default Docker security profile": insufficient. Should specify `--no-new-privileges`, `read-only` filesystem, capability drops.
- **Fix**: Add Docker security hardening recommendations: `security_opt: [no-new-privileges:true]`, `read_only: true` (if proxy supports it), `cap_drop: [ALL]`.

---

## ADR-005: Model Mapping and Fallback Strategy

**Testability Score: 62/100**

### Testability Analysis

| Criterion                       | Score | Notes                                                                      |
| ------------------------------- | :---: | -------------------------------------------------------------------------- |
| Automated verification possible |  70   | Mapping tables are directly verifiable; fallback chain testable via config |
| Success criteria measurable     |  55   | Invariants defined but no error rate thresholds                            |
| Acceptance criteria defined     |  50   | Invariants serve as partial acceptance criteria; no performance targets    |

**Testable claims:**

- `CLAUDE_MODEL_ALIASES` at `cli-backends.ts:10-28` -- VERIFIED. Maps Claude model names to normalized tiers.
- `AgentModelListConfig` at `types.agent-defaults.ts:23-26` -- VERIFIED. `{ primary?: string; fallbacks?: string[] }`.
- `runAgentTurnWithFallback()` supports fallback lists -- VERIFIED. Function exists in `agent-runner-execution.ts`.
- Three invariants (SMALL_MODEL = GLM-4.7-Flash, all 3 MODEL envs set, no circular fallbacks) -- testable.

### Code Reference Accuracy

| Reference                                            | Claimed                       | Actual      | Status  |
| ---------------------------------------------------- | ----------------------------- | ----------- | :-----: |
| `cli-backends.ts:10-28` CLAUDE_MODEL_ALIASES         | Model alias map               | Lines 10-28 | CORRECT |
| `types.agent-defaults.ts:23-26` AgentModelListConfig | Type with primary + fallbacks | Lines 23-26 | CORRECT |

**[CRITICAL-006] Fallback chain is OpenClaw-level, not proxy-level**

- ADR-005 describes fallback chain: `GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash -> ERROR`
- However, the fallback mechanism (`runAgentTurnWithFallback`) operates at the OpenClaw model/provider level, NOT at the proxy model level.
- The proxy's `BIG_MODEL`, `MIDDLE_MODEL`, `SMALL_MODEL` are fixed environment variables. To use the fallback chain, OpenClaw would need to switch the entire model tier (e.g., from `opus` to `haiku`), which changes the proxy env mapping.
- But proxy env vars are set at container startup, not per-request. The only way to dynamically fall back is if OpenClaw changes the `--model` argument passed to Claude Code (e.g., from `--model opus` to `--model haiku`), which would trigger the proxy to use the corresponding env var.
- **Impact**: The fallback strategy works ONLY if OpenClaw's fallback list uses Claude model tier names (opus, sonnet, haiku), not cloud.ru model names. This is not documented.
- **Fix**: Explicitly document that fallback list in `agents.defaults.model.fallbacks` must use Claude Code model names (e.g., `["opus", "sonnet", "haiku"]`), and that each name maps through the proxy to the corresponding cloud.ru model.

**[CRITICAL-007] GLM-4.7-FlashX not mentioned in ADR-001 proxy config**

- ADR-005 references `GLM-4.7-FlashX` in the Alternative Mapping and in fallback chains.
- ADR-001's docker-compose only defines `BIG_MODEL`, `MIDDLE_MODEL`, `SMALL_MODEL` (3 tiers).
- There is no mechanism to configure a 4th model (`GLM-4.7-FlashX`) in the proxy. The proxy maps exactly 3 tiers.
- **Impact**: Fallback chain `GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash` is impossible with the proxy's 3-tier mapping. The fallback can only be `BIG -> MIDDLE -> SMALL`, and `GLM-4.7-FlashX` can only be used if it is assigned to the MIDDLE slot.
- **Fix**: Clarify that fallback follows the 3-tier proxy mapping (opus->sonnet->haiku = BIG->MIDDLE->SMALL). Remove references to direct model name fallback that bypasses the proxy tier system. Update wizard presets table to make this explicit.

**[WARNING-010] "Wizard Model Selection" table has inconsistent model names**

- The table uses shortened names (e.g., "GLM-4.7") but ADR-001 uses full IDs (e.g., "zai-org/GLM-4.7").
- **Fix**: Use consistent model identifiers across all ADRs, or explicitly note when using short names vs. full API IDs.

**[WARNING-011] No monitoring for fallback frequency**

- No metric is defined to track how often fallbacks occur, which would indicate model reliability issues.
- **Fix**: Add observability requirement: log/metric for fallback events including reason, source model, target model, and latency impact.

### INVEST Criteria

| Criterion       |  Score  | Assessment                                                                               |
| --------------- | :-----: | ---------------------------------------------------------------------------------------- |
| **Independent** | PARTIAL | Depends on ADR-001 (proxy config) and ADR-002 (wizard presets)                           |
| **Negotiable**  |  PASS   | Primary and alternative mappings provide negotiation room                                |
| **Valuable**    |  PASS   | Resilience and cost optimization clearly valuable                                        |
| **Estimable**   |  PASS   | Config-level changes; effort estimable                                                   |
| **Small**       |  PASS   | Scope is focused on mapping and fallback config                                          |
| **Testable**    | PARTIAL | Mapping testable; fallback testable only with correct understanding of proxy tier system |

---

## Cross-ADR Issues

### Issue X-001: ADR-001 and ADR-003 Contradict on Tool Calling

- **ADR-001** (Consequences, Positive): "Full multi-agent architecture available (tool calling, MCP, sessions)"
- **ADR-003** (Known Limitation): "Tools are disabled in this session. Do not call tools."
- These are fundamentally incompatible statements within the same architecture. ADR-001 creates the impression that tool calling works through the proxy, while ADR-003 explicitly disables it.
- **Severity**: Critical. Misleads stakeholders about system capabilities.
- **Fix**: ADR-001 must qualify the statement. Tool calling protocol translation exists in the proxy, but Claude Code tools are disabled by OpenClaw's system prompt injection.

### Issue X-002: ADR-002 and ADR-004 Overlap on Wizard Proxy Deployment

- ADR-002 wizard flow Step 4 says: "Proxy status -> [check/deploy docker-compose]"
- ADR-004 is entirely about proxy lifecycle management including wizard deployment.
- The boundary between these two ADRs is unclear. Where does the wizard's responsibility end and the lifecycle manager begin?
- **Severity**: Warning. Could lead to duplicate implementations.
- **Fix**: Define clear boundary. ADR-002 should ONLY handle wizard UI and config generation. ADR-004 should OWN all Docker operations (deploy, health check, lifecycle). ADR-002 Step 4 should delegate to ADR-004's `verifyProxyHealth()` and `generateDockerCompose()`.

### Issue X-003: ADR-005 Fallback Model Names vs. ADR-001 Proxy Tier System

- ADR-005 uses cloud.ru model names in fallback chains (e.g., `GLM-4.7 -> GLM-4.7-FlashX`).
- ADR-001 shows the proxy maps Claude tier names (opus/sonnet/haiku) to cloud.ru models.
- The fallback operates at the Claude Code `--model` level, not at the cloud.ru model level.
- **Severity**: Critical. Fallback chain as documented in ADR-005 is not implementable without the proxy tier translation being explicitly accounted for.
- **Fix**: ADR-005 fallback chains should be expressed in Claude Code tier names with annotations showing the proxy mapping.

### Issue X-004: No End-to-End Integration Test Specification

- Five ADRs describe an architecture with 5 components (OpenClaw, Claude Code, Proxy, Docker, cloud.ru FM).
- No ADR defines an end-to-end integration test that validates the full chain works.
- **Severity**: Warning.
- **Fix**: Add an acceptance test specification (could be in ADR-001 or a separate test plan): "Given proxy is running and healthy, when OpenClaw sends a message via claude-cli backend, then a response is returned from cloud.ru FM within 30s with no proxy errors."

### Issue X-005: `AuthChoiceGroupId` Duplicate Definition

- `AuthChoiceGroupId` is defined in BOTH `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-types.ts` (lines 48-66) and `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice-options.ts` (lines 10-30).
- These definitions ALREADY differ (`auth-choice-options.ts` includes `"litellm"` and `"together"`, `onboard-types.ts` does not).
- ADR-002 must add `"cloudru-fm"` to BOTH locations, but only mentions `auth-choice-options.ts`.
- **Severity**: Warning. Could cause type errors or runtime mismatches.
- **Fix**: ADR-002 integration points must list both files for `AuthChoiceGroupId` extension.

---

## Detailed Issue Registry

| ID           | ADR         | Severity | Category      | Summary                                                            |
| ------------ | ----------- | -------- | ------------- | ------------------------------------------------------------------ |
| CRITICAL-001 | ADR-001     | Critical | Accuracy      | Tool calling claim contradicts ADR-003                             |
| CRITICAL-002 | ADR-002     | Critical | Code Accuracy | Wrong dispatch integration point (line 60 is not cloudru dispatch) |
| CRITICAL-003 | ADR-002     | Critical | Conventions   | Handler function naming breaks `applyAuthChoice<Provider>` pattern |
| CRITICAL-004 | ADR-004     | Critical | Completeness  | No concrete implementation location for health check               |
| CRITICAL-005 | ADR-004     | Critical | Testability   | State machine has no implementation specification                  |
| CRITICAL-006 | ADR-005     | Critical | Accuracy      | Fallback operates at tier level, not model level; not documented   |
| CRITICAL-007 | ADR-005     | Critical | Consistency   | GLM-4.7-FlashX not configurable via 3-tier proxy                   |
| WARNING-001  | ADR-001     | Warning  | Testability   | No latency budget or SLA defined                                   |
| WARNING-002  | ADR-001     | Warning  | Testability   | `serialize: true` queueing impact not quantified                   |
| WARNING-003  | ADR-001     | Warning  | Security      | `HOST: "0.0.0.0"` defense-in-depth gap                             |
| WARNING-004  | ADR-002     | Warning  | Code Accuracy | Duplicate `AuthChoiceGroupId` in two files; only one mentioned     |
| WARNING-005  | ADR-002     | Warning  | Accuracy      | AuthChoice claimed "47 members", actual count is 43                |
| WARNING-006  | ADR-003     | Warning  | Code Accuracy | Tools disabled line reference off-by-one (81-84, not 82-83)        |
| WARNING-007  | ADR-003     | Warning  | Completeness  | Missing subprocess timeout invariant                               |
| WARNING-008  | ADR-004     | Warning  | Completeness  | No Docker prerequisite check or graceful degradation               |
| WARNING-009  | ADR-004     | Warning  | Completeness  | No port conflict handling                                          |
| WARNING-010  | ADR-005     | Warning  | Consistency   | Inconsistent model name formats across ADRs                        |
| WARNING-011  | ADR-005     | Warning  | Observability | No fallback frequency monitoring                                   |
| X-001        | ADR-001+003 | Critical | Cross-ADR     | Tool calling contradiction                                         |
| X-002        | ADR-002+004 | Warning  | Cross-ADR     | Overlapping wizard/lifecycle responsibility                        |
| X-003        | ADR-001+005 | Critical | Cross-ADR     | Fallback model names vs. proxy tier mismatch                       |
| X-004        | All         | Warning  | Cross-ADR     | No end-to-end integration test specification                       |
| X-005        | ADR-002     | Warning  | Cross-ADR     | Duplicate AuthChoiceGroupId needs both files updated               |

---

## Recommendations

### Priority 1: Fix Critical Issues (Must-fix before implementation)

1. **ADR-001**: Remove or qualify the "tool calling" claim in the Positive Consequences section. Reference ADR-003's tools-disabled decision explicitly. Suggested text: "Claude Code multi-step reasoning pipeline available (sessions, system prompts, JSON output). Note: Claude Code tool use (file ops, bash) is disabled per ADR-003."

2. **ADR-002**: Correct integration point 3 from `configure.gateway-auth.ts:60` to `auth-choice.apply.ts:43-55` (handler chain array). Rename `applyCloudruFmChoice` to `applyAuthChoiceCloudruFm` to match the existing naming convention. Add integration point for BOTH `AuthChoiceGroupId` definitions.

3. **ADR-004**: Replace ambiguous implementation guidance with a concrete specification:
   - Health check location: `agent-runner-execution.ts`, before `runCliAgent()` call
   - Cache duration: 30 seconds
   - Failure behavior: return `FailoverError` with reason `"proxy-unhealthy"`
   - Add TypeScript state enum and transition guard function signatures

4. **ADR-005**: Rewrite the Fallback Chain section to operate in terms of Claude Code model tiers (opus/sonnet/haiku), with clear annotation showing which cloud.ru model each tier maps to. Remove `GLM-4.7-FlashX` from fallback chains where it is not assigned to a proxy tier slot. Add a note that fallback requires the `agents.defaults.model.fallbacks` config to use Claude Code model names.

### Priority 2: Improve Testability (Should-fix before testing phase)

5. **All ADRs**: Add a "Verification Criteria" or "Acceptance Tests" section with measurable pass/fail criteria. Examples:
   - ADR-001: "Proxy health check returns HTTP 200 within 1 second"
   - ADR-002: "TypeScript compilation succeeds with new AuthChoice values; wizard renders Cloud.ru FM group"
   - ADR-003: "runCliAgent() returns structured JSON response when ANTHROPIC_BASE_URL points to proxy"
   - ADR-004: "verifyProxyHealth() returns `{ ok: true }` when proxy is running, `{ ok: false, error: string }` when not"
   - ADR-005: "When BIG_MODEL request fails, MIDDLE_MODEL is attempted within 5 seconds"

6. **ADR-001**: Add explicit latency budget: "Target P95 end-to-end latency: proxy overhead < 500ms, total response including LLM < 60s."

7. **ADR-005**: Add fallback monitoring requirement: "Each fallback event must log: source model tier, target model tier, failure reason, and time elapsed."

### Priority 3: Security Hardening (Should-fix before deployment)

8. **ADR-001/ADR-004**: Add Docker security hardening to compose template:

   ```yaml
   security_opt:
     - no-new-privileges:true
   cap_drop:
     - ALL
   ```

9. **ADR-004**: Specify a pre-commit hook or CI check to prevent `.env` file commits. Document the `.gitignore` entry explicitly.

10. **ADR-004**: Add Docker absence graceful degradation: wizard detects Docker unavailability and provides manual setup instructions instead of failing silently.

### Priority 4: Consistency Fixes (Nice-to-have)

11. **All ADRs**: Standardize model name format. Use full API IDs (e.g., `zai-org/GLM-4.7`) in technical specifications and short names (e.g., `GLM-4.7`) only in user-facing wizard labels.

12. **ADR-002/ADR-004**: Define clear boundary of responsibility. ADR-002 owns wizard UI and config generation. ADR-004 owns all Docker/proxy operations. ADR-002 Step 4 should delegate to functions defined in ADR-004.

13. **ADR-003**: Fix the line reference from `cli-runner.ts:82-83` to `cli-runner.ts:81-84` for the tools-disabled injection.

---

## Appendix: Verified File References

All referenced source files were verified to exist at the following paths:

| File Reference                                         | Full Path                                                                                                        | Exists |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | :----: |
| `src/agents/cli-backends.ts`                           | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cli-backends.ts`                           |  YES   |
| `src/agents/cli-runner.ts`                             | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cli-runner.ts`                             |  YES   |
| `src/commands/onboard-types.ts`                        | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-types.ts`                        |  YES   |
| `src/commands/auth-choice-options.ts`                  | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice-options.ts`                  |  YES   |
| `src/commands/configure.gateway-auth.ts`               | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/configure.gateway-auth.ts`               |  YES   |
| `src/commands/auth-choice.apply.ts`                    | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice.apply.ts`                    |  YES   |
| `src/commands/auth-choice-prompt.ts`                   | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice-prompt.ts`                   |  YES   |
| `src/commands/onboard-custom.ts`                       | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-custom.ts`                       |  YES   |
| `src/config/types.agent-defaults.ts`                   | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/config/types.agent-defaults.ts`                   |  YES   |
| `src/auto-reply/reply/agent-runner.ts`                 | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/auto-reply/reply/agent-runner.ts`                 |  YES   |
| `src/auto-reply/reply/agent-runner.claude-cli.test.ts` | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/auto-reply/reply/agent-runner.claude-cli.test.ts` |  YES   |
| `src/auto-reply/reply/agent-runner-execution.ts`       | `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/auto-reply/reply/agent-runner-execution.ts`       |  YES   |
