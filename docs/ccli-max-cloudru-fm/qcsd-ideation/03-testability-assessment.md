# QCSD Ideation: Testability Assessment

## 10 Principles of Testability -- ADR Set Analysis

**Assessment date**: 2026-02-12
**Scope**: ADR-001 through ADR-005 (OpenClaw + Claude Code + cloud.ru FM proxy integration)
**Assessor**: qe-requirements-validator (QCSD Ideation Phase)
**Input artifacts**:

- 5 ADRs (`/src/openclaw-extended/docs/adr/ADR-001` through `ADR-005`)
- Requirements Validation Report (`/src/openclaw-extended/docs/shift-left-testing/01-requirements-validation.md`)
- Acceptance Test Suite (`/tests/adr-acceptance.test.ts`)

---

## Overall Testability Scorecard

| #   | Principle              | Score  | Verdict      |
| --- | ---------------------- | :----: | ------------ |
| 1   | Controllability        |   72   | ADEQUATE     |
| 2   | Observability          |   45   | WEAK         |
| 3   | Isolability            |   68   | ADEQUATE     |
| 4   | Separation of Concerns |   58   | MARGINAL     |
| 5   | Understandability      |   65   | ADEQUATE     |
| 6   | Automatability         |   60   | MARGINAL     |
| 7   | Heterogeneity          |   74   | ADEQUATE     |
| 8   | Restorability          |   52   | MARGINAL     |
| 9   | Simplicity             |   55   | MARGINAL     |
| 10  | Communication          |   62   | MARGINAL     |
|     | **OVERALL**            | **61** | **MARGINAL** |

**Verdict thresholds**: 0-39 = POOR, 40-59 = MARGINAL, 60-74 = ADEQUATE, 75-89 = GOOD, 90-100 = EXCELLENT

---

## Principle 1: Controllability (72/100)

> Can we set the system into a required state for testing?

### What works

**Proxy environment variables are programmatically configurable (Score: 85)**

ADR-001 defines the proxy entirely via Docker environment variables (`OPENAI_API_KEY`, `OPENAI_BASE_URL`, `BIG_MODEL`, `MIDDLE_MODEL`, `SMALL_MODEL`, `HOST`, `PORT`). These can be set in docker-compose, in `.env` files, or injected directly via `docker run -e`. The test suite in `/tests/adr-acceptance.test.ts` already demonstrates this by constructing `generateDockerCompose()` with parameterized values (lines 252-280).

**Claude Code backend config is injectable (Score: 80)**

ADR-001 and ADR-003 show that `mergeBackendConfig()` (at `cli-backends.ts:95-110`) accepts an override object. The test suite confirms this works: env vars like `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` can be injected per test (test lines 409-453). The `clearEnv` mechanism (lines 1008-1067) is also fully controllable.

**Mock cloud.ru FM responses are feasible (Score: 75)**

The proxy sits between Claude Code and cloud.ru FM. Because the proxy reads `OPENAI_BASE_URL` from env, we can point it at a mock HTTP server during testing rather than the real cloud.ru endpoint. This is not documented in any ADR but is architecturally straightforward.

**Test API keys can be injected (Score: 80)**

The `CLOUDRU_API_KEY` is read from `.env` and passed to the proxy as `OPENAI_API_KEY`. For testing, a dummy key can be used when the proxy targets a mock backend. The existing test suite already uses dummy values like `"cloudru-proxy-key"` (test line 789).

### What does not work

**Proxy state machine has no programmatic state injection (Score: 50)**

ADR-004 defines a state machine (`UNDEPLOYED -> DEPLOYING -> RUNNING -> HEALTHY -> UNHEALTHY -> RECOVERING`), but there is no mechanism to force the proxy into a specific state. The test suite builds a `ProxyLifecycle` class (test lines 205-246) as a test-local implementation, but this does not exist in the actual codebase. To test recovery scenarios, you must actually crash the proxy container and wait for Docker to restart it -- no shortcut exists.

**Docker container state cannot be pre-seeded (Score: 55)**

There is no snapshot/restore mechanism for the proxy Docker container. Each test requiring a running proxy must go through the full lifecycle: pull image, start container, wait for health check. This slows integration tests and makes state-dependent tests fragile.

### Controllability recommendations

1. Add a `POST /admin/state` endpoint (or similar) to the proxy for test environments that allows forcing internal state (e.g., simulate unhealthy, simulate model timeout).
2. Document a "test mode" for the proxy that accepts any API key and returns canned responses, eliminating the need for cloud.ru credentials during CI.
3. Implement the `ProxyLifecycle` class from the test suite as a real module in the codebase, with a `forceState()` method for testing.

---

## Principle 2: Observability (45/100)

> Can we observe and verify system behavior during and after testing?

### What works

**Proxy health endpoint exists (Score: 75)**

ADR-001 and ADR-004 define a `/health` endpoint on the proxy (port 8082). The test suite verifies this via `verifyProxyHealth()` (test lines 292-311). Health can be checked programmatically and the return type (`{ ok: boolean; status?: number; error?: string }`) is well-defined.

**CLI backend output is structured JSON (Score: 70)**

ADR-003 documents that Claude Code runs with `--output-format json`, producing parseable output. The test suite validates this structure exists in the default backend config (test line 80).

### What does not work

**No logging or tracing specification (Score: 25)**

None of the 5 ADRs specify:

- Structured log format for the proxy
- Request/response logging for protocol translation
- Trace IDs for correlating requests across OpenClaw -> Claude Code -> Proxy -> cloud.ru FM
- Log levels or verbosity controls

This is a critical observability gap. When a request fails, there is no documented way to determine WHERE in the 4-component chain the failure occurred.

**No model mapping decision logging (Score: 20)**

ADR-005 defines model mapping (Claude tier names to cloud.ru model IDs) but does not specify any logging of the mapping decision. When the proxy receives an `opus` request and maps it to `zai-org/GLM-4.7`, there is no documented log entry. When a fallback occurs (CRITICAL-006 in the requirements validation report notes this operates at the tier level), no metric or log is emitted.

**No request flow tracing (Score: 30)**

The 4-layer architecture (OpenClaw -> Claude Code subprocess -> Proxy -> cloud.ru FM API) has no correlation mechanism. If a user reports a slow response, there is no way to determine whether the latency came from:

- OpenClaw message processing
- Claude Code subprocess startup (~2-5s cold start per ADR-003)
- Proxy protocol translation
- cloud.ru FM model inference
- Network between any two layers

**No error classification (Score: 35)**

ADR-005 mentions fallback triggers ("timeout, 5xx, tool call error") but does not define error categories, error codes, or structured error responses. The proxy's error behavior is completely unspecified -- we do not know whether it returns a 502 vs 500 vs a timeout, or what the response body contains.

### Observability recommendations

1. **Add an ADR-level observability specification**: Define structured JSON logging for the proxy with fields: `timestamp`, `requestId`, `claudeModel`, `cloudruModel`, `action` (map/fallback/error), `latencyMs`, `statusCode`.
2. **Add trace ID propagation**: OpenClaw should generate a `X-Request-ID` header, Claude Code should pass it to the proxy, proxy should pass it to cloud.ru FM. All logs should include this ID.
3. **Add fallback event logging** (per WARNING-011 in requirements validation): Each fallback event must log source tier, target tier, failure reason, and elapsed time.
4. **Define proxy error response schema**: `{ error: string; code: string; claudeModel: string; cloudruModel: string; retryable: boolean }`.

---

## Principle 3: Isolability (68/100)

> Can we test components independently without requiring the full stack?

### What works

**Proxy can be tested without cloud.ru (Score: 80)**

By setting `OPENAI_BASE_URL` to a local mock server (e.g., WireMock or a simple Express server), the proxy can be tested in complete isolation from cloud.ru. The proxy only needs HTTP connectivity to its configured upstream URL. This is architecturally enabled but not documented.

**Wizard types can be tested without Docker (Score: 85)**

ADR-002 defines TypeScript type extensions (`AuthChoice`, `AuthChoiceGroupId`, `AUTH_CHOICE_GROUP_DEFS`). These are compiler-verifiable without running any Docker containers or network services. The test suite demonstrates this with pure unit tests (test lines 662-742) that test type membership, group definition structure, and dispatch routing -- all without any I/O.

**CLI backend config merging is testable in isolation (Score: 90)**

The `mergeBackendConfig()` function is a pure function (no side effects, no I/O). The test suite demonstrates 7 unit tests (test lines 456-537) covering deep merge, key conflict resolution, clearEnv union, and no-op override. This is the most isolable component in the entire architecture.

**Model preset resolution is testable in isolation (Score: 85)**

`resolveModelPreset()` is a pure lookup function tested with 12+ unit tests (test lines 1374-1505). It requires no external dependencies.

### What does not work

**Claude Code subprocess cannot be tested without the proxy (Score: 45)**

ADR-003 describes `runCliAgent()` spawning a subprocess with `ANTHROPIC_BASE_URL=http://localhost:8082`. Without a running proxy (or mock), the subprocess will fail with a connection error. There is no "dry run" or "offline" mode for Claude Code that would allow testing the subprocess lifecycle without network access.

**Health check integration requires running Docker (Score: 40)**

ADR-004's `verifyProxyHealth()` function can be unit-tested with a mock fetch (as the test suite does at lines 1193-1238), but the actual integration test -- "does Docker restart policy recover the proxy?" -- requires a running Docker daemon. CI environments without Docker cannot run this test.

**Wizard Docker deployment step is not isolable (Score: 35)**

ADR-002 Step 4 ("Proxy status -> [check/deploy docker-compose]") requires Docker. The wizard cannot be fully tested in a headless CI environment without Docker. There is no mock/stub for the Docker deployment step documented in any ADR.

### Isolability recommendations

1. **Define a mock proxy specification**: A lightweight HTTP server that responds to the same endpoints as claude-code-proxy (`/health`, Anthropic API protocol) with configurable canned responses. This allows Claude Code subprocess tests without Docker.
2. **Separate wizard config generation from Docker operations**: ADR-002 should clearly separate the pure config generation (testable without Docker) from the Docker deployment step (requires Docker). Tests should be able to validate config output without triggering deployment.
3. **Document a "proxy stub" for CI**: A simple Node.js/Python HTTP server that can replace the Docker proxy for integration tests. Include it in the test infrastructure.

---

## Principle 4: Separation of Concerns (58/100)

> Are concerns cleanly separated so that changes in one area don't break tests in another?

### What works

**Proxy config is separated from app config (Score: 70)**

ADR-001 places proxy configuration in Docker environment variables (docker-compose.yml) while app configuration lives in openclaw.json. The proxy does not read openclaw.json, and OpenClaw does not read docker-compose.yml. This is a clean separation verified by the architecture diagram: `OpenClaw -> Claude Code -> Proxy -> cloud.ru FM`.

**Model alias resolution is separate from model mapping (Score: 65)**

ADR-005 separates two concerns: (1) Claude Code model alias resolution (`CLAUDE_MODEL_ALIASES` maps `claude-opus-4-6` to `opus`) and (2) proxy tier-to-model mapping (`BIG_MODEL` env maps `opus` to `zai-org/GLM-4.7`). These are in different components (OpenClaw/Claude Code vs. proxy).

### What does not work

**Auth choice and backend config are entangled (Score: 45)**

ADR-002 wizard flow Step 5 sets BOTH `models.providers.cloudru-fm` (provider config) AND `agents.defaults.cliBackends.claude-cli.env` (backend config) in a single function (`applyCloudruFmConfig`). The test suite demonstrates this coupling (test lines 760-796): one function produces both provider and backend config. If the backend config format changes, the auth handler must also change. These should be separate handlers with separate tests.

**Wizard flow overlaps with proxy lifecycle (Score: 40)**

The requirements validation report identifies this as X-002: ADR-002 Step 4 overlaps with ADR-004's proxy lifecycle management. Both ADRs claim responsibility for proxy health checking and Docker deployment. This creates ambiguity about which module owns the Docker interaction, making it unclear where to place tests.

**Fallback logic crosses proxy and OpenClaw boundaries (Score: 45)**

The requirements validation report identifies this as CRITICAL-006 and X-003: ADR-005's fallback chain (`GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash`) uses cloud.ru model names, but the actual fallback mechanism operates at the Claude Code tier level (opus -> sonnet -> haiku) in OpenClaw's `runAgentTurnWithFallback()`. This means fallback logic is split across two components with no clear interface contract between them.

**State machine spans wizard and runtime (Score: 50)**

ADR-004's proxy state machine (`UNDEPLOYED -> DEPLOYING -> ... -> HEALTHY`) covers both wizard-time operations (initial deployment) and runtime operations (health monitoring, recovery). These are fundamentally different concerns:

- Wizard-time: runs once during setup, user-interactive
- Runtime: runs continuously, automated

They should be separate state machines with separate tests.

### Separation of concerns recommendations

1. **Split `applyCloudruFmConfig` into two functions**: `applyCloudruFmProvider()` (sets models.providers) and `applyClaudCliProxy()` (sets cliBackends.env). Each should be independently testable.
2. **Define a clear interface contract for fallback**: Create a `FallbackTierMap` type that maps fallback tier names to proxy tier names. Document this as the contract between OpenClaw's fallback mechanism and the proxy's tier system.
3. **Split ADR-004 state machine**: One for deployment lifecycle (wizard-time, transitions: UNDEPLOYED -> DEPLOYED) and one for runtime health (transitions: HEALTHY -> UNHEALTHY -> RECOVERING).
4. **Define ownership boundaries**: ADR-002 owns wizard UI and config generation. ADR-004 owns all Docker/proxy operations. Create explicit function signatures at the boundary.

---

## Principle 5: Understandability (65/100)

> Is the system easy enough to understand that testers can write correct tests?

### What works

**ADR clarity and structure (Score: 75)**

All 5 ADRs follow a consistent format: Status, Date, Bounded Context, Context/Problem, Decision, Consequences, References. Each ADR includes code samples, configuration examples, and architecture diagrams. The DDD bounded context annotations help testers understand the domain model.

**Code reference accuracy (Score: 70)**

The requirements validation report verified all file references against the actual codebase. Of 12 code references checked, 10 were correct, 1 had a minor line-number discrepancy (ADR-003 `cli-runner.ts:82-83` is actually lines 81-84), and 1 was inaccurate (ADR-002 `configure.gateway-auth.ts:60` is not the correct integration point). Overall code reference accuracy is strong.

**DDD value objects and invariants (Score: 72)**

ADR-003 defines 3 testable invariants (Session Identity, Backend Resolution, Environment Isolation). ADR-005 defines 3 invariants (SMALL_MODEL always GLM-4.7-Flash, all 3 MODEL envs set, no circular fallbacks). These are concrete, verifiable constraints that testers can directly translate to assertions.

### What does not work

**Architecture diagram lacks detail (Score: 50)**

ADR-001's architecture diagram is a simple text diagram:

```
OpenClaw -> Claude Code -> proxy -> cloud.ru FM
```

This does not show: network protocols, port bindings, authentication handshakes, error propagation paths, or timeout boundaries. A tester cannot derive a complete test plan from this diagram alone.

**Contradictory claims reduce trust (Score: 40)**

CRITICAL-001 from the requirements validation report: ADR-001 claims "Full multi-agent architecture available (tool calling, MCP, sessions)" while ADR-003 explicitly disables tools. This contradiction undermines tester confidence in the ADR set. If one claim is provably false, which others might also be false?

**Unclear fallback semantics (Score: 45)**

ADR-005's fallback chain uses cloud.ru model names (`GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash`) but CRITICAL-006 and CRITICAL-007 show this is not implementable as written. The fallback operates at the Claude Code tier level, and `GLM-4.7-FlashX` is not a separately addressable model in the 3-tier proxy system. A tester would write incorrect fallback tests based on ADR-005 as written.

### Understandability recommendations

1. **Create a detailed architecture diagram**: Show all network boundaries, ports, protocols (Anthropic API vs OpenAI API), authentication headers, and timeout values. Use a diagram format that shows error propagation.
2. **Resolve the tool calling contradiction**: Fix ADR-001 as recommended in CRITICAL-001. This restores trust in the ADR set.
3. **Rewrite fallback chains in tier language**: Express fallback as `opus -> sonnet -> haiku` with annotations showing proxy mapping. This matches the actual mechanism and enables correct test authoring.

---

## Principle 6: Automatability (60/100)

> Can we automate the testing of this system in CI/CD?

### What works

**Unit tests are fully automatable (Score: 90)**

The test suite in `/tests/adr-acceptance.test.ts` contains 100+ unit tests using Vitest. All pure-function tests (mergeBackendConfig, resolveModelPreset, validateFallbackChain, buildExtraSystemPrompt, routeAuthChoice) can run in any CI environment without external dependencies. These are already automated and require only `npm test`.

**Type-level tests are compiler-automatable (Score: 85)**

ADR-002's type extensions (AuthChoice, AuthChoiceGroupId) can be validated by TypeScript compilation. A CI pipeline that runs `npm run build` will catch type-level regressions. No special infrastructure needed.

**Health check tests are automatable with mocks (Score: 75)**

The `verifyProxyHealth()` function accepts an injected `fetchFn` parameter (test line 294), allowing full automation without a running proxy. The mock-based tests cover success (200), degraded (503), and connection refused scenarios.

### What does not work

**Docker-dependent tests require Docker in CI (Score: 45)**

ADR-004's proxy lifecycle tests require Docker. Many CI environments (GitHub Actions standard runners, GitLab CI without Docker-in-Docker) do not have Docker available by default. The ADRs do not specify a Docker-free testing alternative.

Required CI infrastructure for Docker tests:

- Docker daemon running in CI
- Docker Compose installed
- Network access to pull `legard/claude-code-proxy:latest` image
- Port 8082 available

**End-to-end tests require cloud.ru API credentials (Score: 30)**

True end-to-end testing (OpenClaw -> Claude Code -> Proxy -> cloud.ru FM) requires a valid `CLOUDRU_API_KEY` with quota. This is not available in open-source CI pipelines and is costly in private CI. No ADR defines a mock endpoint or test account.

**Claude Code subprocess tests require Claude Code binary (Score: 35)**

ADR-003's execution flow requires the `claude` CLI binary installed. This is not a standard CI dependency. Installing Claude Code in CI adds complexity and potential licensing/authentication issues.

### Automatability recommendations

1. **Define a 3-tier test strategy**:
   - **Tier 1 (CI-fast)**: Pure unit tests + type checks. No Docker, no network. Run on every commit. (~100 tests, <10s)
   - **Tier 2 (CI-integration)**: Mock proxy server + health checks. Requires Node.js HTTP server, no Docker. Run on PR. (~20 tests, <30s)
   - **Tier 3 (CI-e2e)**: Docker proxy + mock cloud.ru backend. Requires Docker. Run on merge to main. (~10 tests, <5min)
   - **Tier 4 (Staging)**: Full stack with real cloud.ru API. Requires credentials. Run manually or on release. (~5 tests, <10min)
2. **Create a mock cloud.ru FM server**: A simple HTTP server implementing the OpenAI-compatible `/v1/chat/completions` endpoint with canned responses. Include in the repository under `/tests/fixtures/mock-cloudru-server.ts`.
3. **Define CI environment requirements** in a new ADR section: Docker version, Node.js version, required env vars for each test tier.

---

## Principle 7: Heterogeneity (74/100)

> Does the system support testing with diverse inputs, configurations, and failure modes?

### What works

**Multiple model presets are testable (Score: 85)**

ADR-005 defines 3 wizard presets (GLM-4.7 Full, GLM-4.7-Flash Free, Qwen3-Coder-480B). Each produces a different `ModelPreset` with different `BIG_MODEL`, `MIDDLE_MODEL`, `SMALL_MODEL` values. The test suite validates all 3 presets (test lines 1374-1428) and verifies the invariant that SMALL_MODEL is always GLM-4.7-Flash across all presets (test lines 1492-1505). This enables parametric testing across model configurations.

**Multiple auth flows are testable (Score: 75)**

ADR-002 defines 3 auth choices (`cloudru-fm-glm47`, `cloudru-fm-flash`, `cloudru-fm-qwen`). The test suite validates dispatch routing for all 3 (test lines 711-742). The wizard flow produces different config outputs per choice, enabling data-driven test generation.

**Multiple failure modes are partially testable (Score: 65)**

The test suite covers:

- Health check success (200), degraded (503), and connection refused
- State machine transitions including invalid transitions (test lines 1296-1306)
- Fallback chain validation including circular detection
- Unknown preset handling (test lines 1430-1440)

### What does not work

**GLM-4.7 tool calling instabilities are not testable (Score: 50)**

ADR-005 documents 5 known GLM-4.7 issues (streaming tool call parse crash, tool call simulation in text, RLHF refusals, attention loss, thinking mode conflicts) but provides no test fixtures or mock responses that reproduce these failures. A tester cannot simulate "tool call simulation in text" without knowing the exact response format.

**Rate limiting is not testable (Score: 40)**

ADR-001 mentions a 15 req/s rate limit from cloud.ru but provides no mechanism to test rate-limit behavior. There is no mock that returns HTTP 429, no configuration for rate-limit thresholds, and no documented retry behavior.

**Streaming timeout is not testable (Score: 45)**

ADR-001 mentions `REQUEST_TIMEOUT` as a proxy env variable for streaming timeout, but this variable does not appear in the docker-compose template (ADR-001 lines 52-72). There is no test for what happens when the proxy times out mid-stream.

### Heterogeneity recommendations

1. **Create failure fixture library**: Mock HTTP responses for each known GLM-4.7 failure mode:
   - `fixtures/glm47-tool-call-crash.json` (malformed tool_use block in streaming SSE)
   - `fixtures/glm47-refusal.json` (RLHF refusal response)
   - `fixtures/cloudru-rate-limit-429.json` (rate limit exceeded)
   - `fixtures/cloudru-timeout.json` (no response within timeout)
2. **Add `REQUEST_TIMEOUT` to docker-compose template**: Make it configurable and testable.
3. **Define rate-limit test scenario**: "Given proxy receives 20 requests within 1 second, then requests 16-20 should receive HTTP 429 or be queued."

---

## Principle 8: Restorability (52/100)

> Can the system be restored to a known state after failure?

### What works

**Docker restart policy handles transient crashes (Score: 70)**

ADR-001 and ADR-004 specify `restart: unless-stopped` in docker-compose. The test suite validates this appears in generated compose output (test line 895-897). Docker's restart policy provides automatic recovery from proxy crashes without manual intervention.

**State machine models recovery path (Score: 65)**

The `ProxyLifecycle` class in the test suite (test lines 205-246) models the full recovery path: `HEALTHY -> UNHEALTHY -> RECOVERING -> HEALTHY`. The test suite includes a dedicated "failure-recovery lifecycle" test (test lines 1324-1333) and "restart recovery" test (test lines 1335-1367).

### What does not work

**No session recovery after proxy crash (Score: 35)**

ADR-003 documents session continuity via `--session-id` and `--resume`. However, if the proxy crashes mid-conversation:

- Claude Code's subprocess may hang waiting for a response
- The `runCommandWithTimeout` (per WARNING-007) may eventually time out
- The session state in Claude Code may be corrupted (partial response stored)
- There is no documented recovery procedure for this scenario

No ADR specifies: "After proxy restart, does Claude Code's next request to a resumed session work correctly?"

**No fallback chain restoration (Score: 40)**

ADR-005's fallback chain state is implicit -- there is no documented persistence of "which fallback stage are we on?" If OpenClaw falls back from opus to sonnet for a conversation, and then the proxy restarts, does the next message resume at the sonnet fallback or reset to opus? This is undefined.

**No configuration rollback (Score: 30)**

If the wizard applies a malformed configuration (e.g., invalid API key, wrong model ID), there is no documented rollback mechanism. The wizard writes directly to openclaw.json. There is no backup, no "undo", and no validation step between config generation and application.

**No proxy state persistence (Score: 25)**

The `ProxyLifecycle` state machine in the test suite is in-memory only. If OpenClaw restarts, the proxy state is unknown until the next health check. There is no file or database storing the last known proxy state.

### Restorability recommendations

1. **Define session recovery behavior**: "After proxy restart, the next request with `--resume <session-id>` must either succeed (if Claude Code session is intact) or return a clear error indicating session loss."
2. **Add configuration backup**: Before `applyCloudruFmConfig()` writes to openclaw.json, save a `.openclaw.json.bak` backup. Document how to restore.
3. **Persist proxy state**: Write last known health check result and timestamp to a file (e.g., `.proxy-state.json`). On OpenClaw startup, read this file and validate against a fresh health check.
4. **Define fallback state reset policy**: "Fallback state is per-request, not per-session. Each new message starts at the primary model tier."

---

## Principle 9: Simplicity (55/100)

> Is the system simple enough to test without excessive setup or configuration?

### What works

**Minimal config for free tier (Score: 75)**

ADR-005's "GLM-4.7-Flash (Free)" preset uses the same model for all 3 tiers. This means a tester only needs one model to validate the entire pipeline. The free tier eliminates cost concerns for testing.

**Pure function testing is simple (Score: 85)**

`mergeBackendConfig()`, `resolveModelPreset()`, `validateFallbackChain()`, `generateDockerCompose()` are all pure functions. Testing them requires zero setup, zero teardown, zero external dependencies. The test suite demonstrates this simplicity.

### What does not work

**4-layer architecture has high setup complexity (Score: 35)**

Testing the full architecture requires:

1. OpenClaw running (Node.js process with config)
2. Claude Code binary installed and configured
3. Docker daemon running
4. Proxy Docker container running
5. Network connectivity between all layers
6. Valid API credentials (or mock backend)

This is 6 prerequisites for a single end-to-end test. Each adds a failure mode that is not related to the system under test.

**Configuration surface area is large (Score: 45)**

Across the 5 ADRs, the total configuration surface includes:

- 7 Docker environment variables (ADR-001)
- 3 wizard auth choices (ADR-002)
- 5 CLI backend config fields overridden (ADR-001/003)
- 5 proxy lifecycle states (ADR-004)
- 3 model presets with 3 models each = 9 model assignments (ADR-005)
- 2 fallback chains (ADR-005)
- 5 GLM-4.7 mitigations (ADR-005)

Total: ~39 configuration points. This makes exhaustive configuration testing impractical.

**Error messages are not specified (Score: 40)**

None of the 5 ADRs define specific error messages for failure scenarios. When the proxy is unreachable, what does OpenClaw show the user? When a model is unavailable, what error does the proxy return? Without defined error messages, testers cannot write assertions for error scenarios.

**`serialize: true` makes concurrent testing impossible (Score: 30)**

ADR-001 and ADR-003 both note that the default backend uses `serialize: true`, limiting to 1 concurrent request globally. This means:

- Load tests are meaningless (only 1 request at a time)
- Concurrent test execution will queue, making test suites slow
- Realistic multi-user scenarios cannot be tested

### Simplicity recommendations

1. **Define a "test profile"** that reduces setup to 1 command: `docker-compose -f docker-compose.test.yml up` that starts both the proxy and a mock cloud.ru backend.
2. **Define error message catalog**: For each failure mode, specify the exact error message string. This enables assertion-based testing.
3. **Add a `serialize: false` test configuration**: For load testing, provide a backend config override that allows concurrent requests.
4. **Reduce configuration surface**: Identify which of the 39 configuration points are independent. Group them into "configuration profiles" (e.g., "free", "standard", "enterprise") that reduce the combinatorial space.

---

## Principle 10: Communication (62/100)

> Are test requirements clearly communicated in the ADRs and supporting documents?

### What works

**DDD invariants serve as implicit acceptance criteria (Score: 72)**

ADR-003 defines 3 invariants and ADR-005 defines 3 invariants. Each is a concrete, testable statement:

- "Every OpenClaw conversation maps to exactly one Claude Code session ID" (ADR-003)
- "SMALL_MODEL must always be GLM-4.7-Flash" (ADR-005)
- "Model fallback list must terminate (no circular fallbacks)" (ADR-005)

The test suite translates these directly to assertions. These serve as de facto acceptance criteria.

**Test scenarios already documented in test suite (Score: 75)**

The `/tests/adr-acceptance.test.ts` file contains 100+ test cases organized by ADR. This IS the test specification. It covers:

- 7 merge semantics tests
- 4 health check tests
- 12 state machine transition tests
- 9 model preset tests
- 8 fallback chain tests
- 6 cross-ADR integration tests

### What does not work

**No ADR has formal acceptance criteria (Score: 35)**

None of the 5 ADRs include an "Acceptance Criteria" or "Verification Criteria" section. The requirements validation report recommends adding these (Priority 2, item 5), but they do not exist yet. Testers must infer acceptance criteria from the Decision and Consequences sections.

**Edge cases are not identified in ADRs (Score: 40)**

The ADRs do not document edge cases such as:

- What happens when `CLOUDRU_API_KEY` is empty?
- What happens when the proxy port is already in use?
- What happens when Docker is not installed?
- What happens when `BIG_MODEL` env is set to an invalid model ID?
- What happens when the cloud.ru API returns a non-JSON response?

Some of these are identified in the requirements validation report (WARNING-008, WARNING-009) but not in the ADRs themselves.

**No non-functional requirements specified (Score: 30)**

None of the ADRs specify:

- Performance targets (latency, throughput)
- Reliability targets (uptime SLA, MTTR)
- Scalability limits (max concurrent users, max sessions)
- Resource limits (memory, CPU, disk for proxy container)

The requirements validation report notes this gap (WARNING-001, WARNING-002) and recommends specific targets, but they are absent from the ADRs.

**Test data requirements not documented (Score: 45)**

No ADR specifies what test data is needed:

- Sample user messages for different scenarios
- Expected cloud.ru FM response formats
- Mock API key values for testing
- Sample session IDs for resume testing

### Communication recommendations

1. **Add "Acceptance Criteria" section to each ADR**: Use Given/When/Then format. Example for ADR-001: "Given proxy is running and healthy, when Claude Code sends a /messages request, then the proxy returns a valid response from cloud.ru FM within 30 seconds."
2. **Add "Edge Cases" section to each ADR**: List 3-5 edge cases per ADR with expected behavior.
3. **Define non-functional requirements**: Add a cross-cutting NFR table: P95 latency < 30s, proxy health check < 1s, MTTR after crash < 60s, max concurrent sessions = 1 (due to serialize:true).
4. **Create a test data specification**: Document required mock data, test API keys, and sample messages in a test data catalog.

---

## Testability Blockers

Issues that **prevent** effective testing if not resolved:

| ID   | Blocker                                                                                             | ADR(s)           | Impact                                                           | Resolution                                                                |
| ---- | --------------------------------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------- |
| TB-1 | No observability specification: no logging, no tracing, no error classification                     | All              | Cannot diagnose test failures in the 4-layer architecture        | Add structured logging and trace ID propagation spec                      |
| TB-2 | Fallback chain documented with wrong abstraction level (cloud.ru model names vs. Claude tier names) | ADR-005          | Testers will write incorrect fallback tests based on ADR-005     | Rewrite fallback chains using Claude tier names (opus/sonnet/haiku)       |
| TB-3 | `serialize: true` prevents concurrent/load testing                                                  | ADR-001, ADR-003 | Cannot validate multi-user scenarios                             | Define test config with `serialize: false` and document expected behavior |
| TB-4 | Tool calling contradiction between ADR-001 and ADR-003                                              | ADR-001, ADR-003 | Testers may write tool-calling tests that are guaranteed to fail | Resolve contradiction per CRITICAL-001                                    |
| TB-5 | No mock cloud.ru FM server specification                                                            | All              | End-to-end test automation requires real API credentials         | Define and implement mock server                                          |
| TB-6 | GLM-4.7-FlashX not configurable in 3-tier proxy                                                     | ADR-005          | Fallback chain referencing FlashX is untestable                  | Remove FlashX from fallback chains or add 4th tier support                |

---

## Testability Enablers

Architectural features that **help** testing:

| ID    | Enabler                                                                | ADR(s)           | Benefit                                                     |
| ----- | ---------------------------------------------------------------------- | ---------------- | ----------------------------------------------------------- |
| TE-1  | `mergeBackendConfig()` is a pure function with injectable overrides    | ADR-001, ADR-003 | Enables isolated unit testing of backend config             |
| TE-2  | `verifyProxyHealth()` accepts injected `fetchFn`                       | ADR-004          | Enables mock-based health check testing without Docker      |
| TE-3  | Proxy configured entirely via environment variables                    | ADR-001, ADR-004 | Enables parameterized testing with different model mappings |
| TE-4  | `OPENAI_BASE_URL` is configurable per proxy instance                   | ADR-001          | Enables pointing proxy at mock backend for isolated testing |
| TE-5  | TypeScript type system enforces AuthChoice correctness at compile time | ADR-002          | Compiler catches invalid auth choice additions              |
| TE-6  | Docker health check endpoint defined at `/health`                      | ADR-001, ADR-004 | Standard health check is automatable                        |
| TE-7  | DDD invariants provide concrete testable contracts                     | ADR-003, ADR-005 | Direct translation from invariant to test assertion         |
| TE-8  | Existing acceptance test suite with 100+ tests                         | Test file        | Baseline test infrastructure already exists                 |
| TE-9  | `generateDockerCompose()` is a pure template function                  | ADR-004          | Template output can be validated without Docker             |
| TE-10 | `resolveModelPreset()` is a pure lookup function                       | ADR-005          | Model preset logic is testable in complete isolation        |

---

## Missing Test Infrastructure

| Priority | Missing Component                                           | Purpose                                                |  Effort  |
| :------: | ----------------------------------------------------------- | ------------------------------------------------------ | :------: |
|    P0    | Mock cloud.ru FM HTTP server                                | Enable proxy testing without real cloud.ru credentials | 1-2 days |
|    P0    | Structured logging specification                            | Enable failure diagnosis in multi-layer tests          |  1 day   |
|    P1    | Docker Compose test profile (`docker-compose.test.yml`)     | One-command integration test environment               | 0.5 day  |
|    P1    | Failure fixture library (GLM-4.7 error responses)           | Enable heterogeneous failure mode testing              |  1 day   |
|    P1    | CI pipeline definition with 4-tier test strategy            | Automate all test levels appropriately                 |  1 day   |
|    P2    | Proxy "test mode" admin endpoint (`POST /admin/state`)      | Enable state injection for lifecycle tests             | 2-3 days |
|    P2    | Configuration backup/rollback mechanism                     | Enable restore-after-failure testing                   |  1 day   |
|    P2    | Test data catalog (sample messages, mock keys, session IDs) | Standardize test inputs across all test levels         | 0.5 day  |
|    P3    | Performance benchmark harness                               | Validate latency/throughput NFRs when defined          | 2-3 days |
|    P3    | Proxy error response schema validation                      | Validate error format consistency                      | 0.5 day  |

---

## Recommended Test Environment Setup

### Tier 1: Unit Tests (No external dependencies)

```bash
# Run with: npm test
# Environment: Any Node.js 18+ CI runner
# Dependencies: vitest, typescript
# Coverage: mergeBackendConfig, resolveModelPreset, validateFallbackChain,
#           generateDockerCompose, verifyProxyHealth (mocked), routeAuthChoice,
#           buildExtraSystemPrompt, ProxyLifecycle state machine
# Expected tests: ~100+
# Expected duration: <10 seconds
```

### Tier 2: Integration Tests with Mock Proxy (Node.js only)

```
Required components:
  1. Mock cloud.ru FM server (Express/Fastify, port 3999)
     - GET /health -> 200
     - POST /v1/chat/completions -> canned response
     - POST /v1/chat/completions?fail=true -> 500
     - POST /v1/chat/completions?timeout=true -> 30s delay
  2. Test config:
     OPENAI_BASE_URL=http://localhost:3999
     OPENAI_API_KEY=test-key-12345
     BIG_MODEL=test-big
     MIDDLE_MODEL=test-middle
     SMALL_MODEL=test-small

Test scenarios:
  - Proxy starts and /health returns 200
  - Anthropic API request translates to OpenAI API request
  - Model tier mapping opus->BIG_MODEL, sonnet->MIDDLE_MODEL, haiku->SMALL_MODEL
  - 5xx from mock triggers fallback
  - Connection refused from mock returns structured error
```

### Tier 3: Docker Integration Tests

```
Required components:
  1. Docker daemon
  2. docker-compose with:
     - claude-code-proxy (legard/claude-code-proxy:latest)
     - mock-cloudru-fm (custom image or shared Node.js server)
  3. Port 8082 available

Test scenarios:
  - Docker container starts within 30 seconds
  - /health endpoint returns 200 after startup
  - Container recovers after kill -9 (restart policy)
  - Health check fails when mock backend is down
  - HEALTHY -> UNHEALTHY -> RECOVERING -> HEALTHY lifecycle
```

### Tier 4: Staging/E2E Tests (Real cloud.ru API)

```
Required components:
  1. Docker daemon
  2. Valid CLOUDRU_API_KEY with quota
  3. Network access to https://foundation-models.api.cloud.ru/v1/
  4. Claude Code binary installed

Test scenarios:
  - Full chain: OpenClaw -> Claude Code -> Proxy -> cloud.ru FM -> response
  - GLM-4.7-Flash (free tier) responds within 60 seconds
  - Session resume works across 2 consecutive messages
  - Rate limit handling (if applicable)

Environment variables:
  CLOUDRU_API_KEY=<real-key>
  PROXY_PORT=8082
  TEST_TIMEOUT=120000
```

---

## Relationship to Previous Analyses

This testability assessment builds on findings from:

1. **Requirements Validation Report** (`01-requirements-validation.md`):
   - 7 critical issues and 12 warnings directly inform testability blockers
   - CRITICAL-001 (tool calling contradiction) -> TB-4
   - CRITICAL-006/007 (fallback abstraction mismatch) -> TB-2, TB-6
   - WARNING-001/002 (no SLA/load metrics) -> Principle 10 gaps
   - X-004 (no e2e test spec) -> Automatability gap

2. **Acceptance Test Suite** (`adr-acceptance.test.ts`):
   - 100+ existing tests validate Principles 1, 3, 6, 7 (Controllability, Isolability, Automatability, Heterogeneity)
   - Test suite design (mock injection, pure functions) demonstrates TE-1 through TE-10 enablers
   - Test gaps (no observability tests, no error message assertions, no performance tests) directly correlate with Principles 2, 9, 10 weaknesses

---

## Summary and Next Steps

The ADR set scores **61/100** on overall testability -- MARGINAL. The strongest areas are Controllability (72) and Heterogeneity (74), driven by the pure-function architecture of config merging and model presets. The weakest area is Observability (45), due to the complete absence of logging, tracing, and error classification specifications across all 5 ADRs.

**Top 3 actions to improve testability**:

1. **Add observability specification** (addresses Principle 2, TB-1): Define structured logging, trace IDs, and error response schemas. This is the single highest-impact improvement because it enables failure diagnosis in the 4-layer architecture.

2. **Build mock cloud.ru FM server** (addresses Principles 3, 6, TB-5): This unlocks automated integration testing without real credentials and removes the most significant barrier to CI/CD automation.

3. **Resolve ADR contradictions and abstraction mismatches** (addresses Principles 5, 10, TB-2, TB-4, TB-6): Fix the tool calling contradiction, rewrite fallback chains in tier language, and remove references to non-configurable models. This allows testers to write correct tests from ADR specifications.
