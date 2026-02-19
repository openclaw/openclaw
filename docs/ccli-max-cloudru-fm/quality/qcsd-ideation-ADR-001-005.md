# QCSD Ideation Report: ADR-001 through ADR-005

## Quality Criteria Session Document -- OpenClaw + Cloud.ru FM Integration

**Date**: 2026-02-13
**Analyst**: QA QCSD Ideation Specialist
**Scope**: ADR-001 (Proxy Integration), ADR-002 (Wizard Auth Choice), ADR-003 (Agentic Engine), ADR-004 (Proxy Lifecycle), ADR-005 (Model Mapping & Fallback)
**Method**: HTSM v6.3 Quality Criteria Decomposition, Risk Storming, Testability Assessment

---

## Table of Contents

1. [HTSM v6.3 Analysis per ADR](#1-htsm-v63-analysis-per-adr)
2. [Risk Storming per ADR](#2-risk-storming-per-adr)
3. [Testability Assessment per ADR](#3-testability-assessment-per-adr)
4. [Quality Criteria Matrix](#4-quality-criteria-matrix)
5. [Missing Quality Scenarios](#5-missing-quality-scenarios)
6. [Cross-ADR Interactions](#6-cross-adr-interactions)

---

# 1. HTSM v6.3 Analysis per ADR

## 1.1 ADR-001: Cloud.ru FM Proxy Integration

### Functionality

| Criterion                      | Threshold                                                                                                     | Rationale                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Protocol translation accuracy  | 100% of Anthropic `/messages` requests translated to OpenAI `/v1/chat/completions` without data loss          | Any translation error silently corrupts the model interaction. Zero tolerance.                                  |
| Tool calling format fidelity   | Anthropic `tool_use` blocks round-trip to OpenAI `function_calling` and back with 100% structural equivalence | Tool calling is the backbone of agentic reasoning. Lossy translation destroys multi-step plans.                 |
| Model name mapping correctness | All 3 tiers (opus/sonnet/haiku) resolve to valid cloud.ru model IDs with zero lookup failures                 | A mismap causes a 404 from cloud.ru, which is indistinguishable from a service outage at the Claude Code level. |
| Streaming fidelity             | SSE events delivered in-order with no dropped chunks for responses up to 32K tokens                           | Dropped SSE chunks cause truncated responses visible to end users.                                              |
| localhost binding enforcement  | Proxy listens ONLY on 127.0.0.1:8082; zero external connections accepted                                      | Externally exposed proxy = unauthenticated access to the cloud.ru API key.                                      |

### Reliability

| Criterion                      | Threshold                                                                                                   | Rationale                                                                                    |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Container restart recovery     | Proxy recovers to HEALTHY within 15s of an OOM kill or segfault                                             | Docker `restart: unless-stopped` must be validated under crash scenarios.                    |
| Health check endpoint accuracy | `/health` returns 200 only when proxy can reach cloud.ru FM API; returns 503 otherwise                      | A false-positive health check masks upstream outages.                                        |
| Request timeout handling       | Proxy returns structured error (not hang) for cloud.ru responses exceeding `REQUEST_TIMEOUT` (default 120s) | Hanging proxy ties up the serialized Claude Code subprocess indefinitely.                    |
| Concurrent request safety      | Proxy handles at least 5 overlapping requests without race conditions or response cross-contamination       | Even though OpenClaw serializes, external tooling or debugging may send concurrent requests. |

### Performance

| Criterion                    | Threshold                                                      | Rationale                                                   |
| ---------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------- |
| Translation latency overhead | < 50ms added to each request/response cycle (p99)              | Proxy must not be a bottleneck; cloud.ru latency dominates. |
| Memory footprint             | < 256MB RSS under sustained 5 req/s load                       | Proxy runs alongside OpenClaw; cannot starve the host.      |
| Cold start time              | Container ready to serve within 5s of `docker-compose up`      | Wizard health check fires at 5s; proxy must be ready.       |
| Streaming throughput         | Proxy forwards SSE events within 10ms of receipt from cloud.ru | Buffered SSE adds perceptible latency for long responses.   |

### Security

| Criterion                        | Threshold                                                                          | Rationale                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| API key non-exposure             | `CLOUDRU_API_KEY` never appears in proxy logs, response headers, or error messages | Key leakage in logs is a common production incident.        |
| TLS to cloud.ru                  | All outbound connections use TLS 1.2+ with certificate validation                  | Downgrade or MitM to cloud.ru endpoint exposes all traffic. |
| Input sanitization               | Proxy rejects malformed Anthropic API payloads with 400, not proxy crash           | Malformed requests must not cause proxy undefined behavior. |
| No debug endpoints in production | `/debug`, `/metrics`, `/env` endpoints are disabled or auth-gated                  | Debug endpoints expose internal state and API keys.         |

### Maintainability

| Criterion                     | Threshold                                                                     | Rationale                                                           |
| ----------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Proxy image version pinning   | `docker-compose.yml` uses a pinned tag (not `:latest`) in production          | `:latest` may introduce breaking changes silently on pull.          |
| Configuration externalization | All model IDs, URLs, and keys configurable via env vars without image rebuild | Hardcoded values require rebuilding the proxy image for any change. |
| Log structured output         | Proxy emits JSON logs with `level`, `timestamp`, `requestId` fields           | Unstructured logs are ungreppable in production incidents.          |

---

## 1.2 ADR-002: Wizard Cloud.ru Auth Choice

### Functionality

| Criterion                      | Threshold                                                                                                                                  | Rationale                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| AuthChoice type completeness   | All 3 new values (`cloudru-fm-glm47`, `cloudru-fm-flash`, `cloudru-fm-qwen`) compile without type errors and pass exhaustive switch checks | Missing a union member causes silent fallthrough in dispatch logic.   |
| Wizard flow completion         | User can complete the 5-step flow (provider -> model -> key -> proxy -> verify) in under 120s with zero errors on happy path               | UX friction causes wizard abandonment.                                |
| Config output correctness      | `applyCloudruFmConfig()` produces a JSON blob that passes OpenClaw config schema validation                                                | Invalid config output causes startup failures after wizard completes. |
| Proxy health check integration | `verifyProxyHealth()` correctly distinguishes: proxy running + healthy, proxy running + unhealthy, proxy not running                       | Ambiguous health status leads to misconfigured deployments.           |
| Docker compose generation      | `generateDockerCompose()` produces a valid YAML file that passes `docker-compose config --quiet` validation                                | Malformed YAML causes `docker-compose up` failure.                    |

### Reliability

| Criterion                 | Threshold                                                                     | Rationale                                                                             |
| ------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| Wizard idempotency        | Running the wizard twice with the same inputs produces the same config output | Re-running the wizard must not corrupt existing config.                               |
| Partial wizard recovery   | If the user cancels at Step 4, Steps 1-3 inputs are recoverable on re-run     | Losing partial progress forces full re-entry of credentials.                          |
| Invalid API key detection | Wizard detects and reports invalid cloud.ru API key before writing config     | Writing an invalid key causes all subsequent requests to fail with opaque 401 errors. |

### Performance

| Criterion            | Threshold                                                             | Rationale                                           |
| -------------------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| Wizard step latency  | Each interactive step responds within 200ms (excluding network calls) | Sluggish wizard feels broken.                       |
| Health check timeout | `verifyProxyHealth()` times out at 5s and reports failure, not hang   | Hanging health check blocks the entire wizard flow. |

### Security

| Criterion                   | Threshold                                                                  | Rationale                                                       |
| --------------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| API key masking in terminal | Wizard masks API key input (shows `****` or similar)                       | Shoulder-surfing risk during onboarding.                        |
| API key storage location    | Key written ONLY to `.env` file, never to `openclaw.json` or stdout        | `openclaw.json` may be committed to git; `.env` is gitignored.  |
| Docker compose .gitignore   | Generated `docker-compose.cloudru-proxy.yml` is auto-added to `.gitignore` | Accidental commit of compose file leaks infrastructure details. |

### Maintainability

| Criterion                  | Threshold                                                                              | Rationale                                                    |
| -------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Model ID update path       | Changing a cloud.ru model ID requires editing exactly 1 file (`onboard-cloudru-fm.ts`) | Scattered model IDs cause inconsistency.                     |
| Wizard pattern conformance | New wizard code follows the exact same patterns as `onboard-custom.ts`                 | Divergent patterns increase cognitive load for contributors. |

---

## 1.3 ADR-003: Claude Code as Agentic Execution Engine

### Functionality

| Criterion                       | Threshold                                                                                   | Rationale                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Subprocess spawn success rate   | `runCliAgent()` successfully spawns Claude Code subprocess on 99.5%+ of calls               | Failed spawns produce no response to the user.              |
| JSON output parsing reliability | 100% of Claude Code JSON outputs parse without error for well-formed responses              | Parse failures drop the entire response.                    |
| Session continuity              | `--session-id` resumes previous conversation state with 100% fidelity across messages       | Session loss causes context amnesia mid-conversation.       |
| Tool disablement enforcement    | Claude Code never executes file/bash/search tools during OpenClaw sessions                  | Tool execution in user sessions is a security escalation.   |
| System prompt injection         | `--append-system-prompt` content appears in Claude Code's effective prompt 100% of the time | Missing system prompt changes model behavior unpredictably. |

### Reliability

| Criterion                             | Threshold                                                                                           | Rationale                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Subprocess timeout handling           | Claude Code subprocess killed after configurable timeout (default 300s) with error returned to user | Runaway subprocess consumes resources indefinitely.                  |
| stderr/stdout isolation               | stderr from Claude Code never leaks into the JSON response delivered to the user                    | Debug logs in user responses are confusing and may expose internals. |
| Serialization correctness             | `serialize: true` prevents overlapping subprocess executions with zero race conditions              | Concurrent subprocess spawns may corrupt session state.              |
| Graceful degradation on proxy failure | When proxy returns 5xx, Claude Code subprocess exits with parseable error (not hang)                | Unparseable failure modes require manual intervention.               |

### Performance

| Criterion                                     | Threshold                                                        | Rationale                                                |
| --------------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Cold start latency                            | Claude Code subprocess ready to process input within 3s of spawn | Users expect sub-5s first response.                      |
| Warm session latency                          | `--resume` session loads in < 1s                                 | Returning users expect near-instant context restoration. |
| End-to-end latency (user message to response) | < 30s for typical conversational turns (p90)                     | Beyond 30s, users assume the system is broken.           |
| Memory per subprocess                         | < 512MB RSS per Claude Code instance                             | Memory must not scale linearly with concurrent users.    |

### Security

| Criterion                                | Threshold                                                                                     | Rationale                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Environment isolation via clearEnv       | `ANTHROPIC_API_KEY` from host environment never leaks to subprocess when `clearEnv` is active | Key leakage between backends is a credential exposure.        |
| `--dangerously-skip-permissions` scoping | Permission skip applies ONLY to the OpenClaw-controlled workspace, not system-wide            | Overly broad permission skip enables arbitrary system access. |
| Session ID collision prevention          | Session IDs are unique per user/conversation with zero collision probability                  | Session collision merges two users' conversation histories.   |

### Maintainability

| Criterion                             | Threshold                                                                   | Rationale                                                  |
| ------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------- |
| Claude Code CLI version compatibility | Integration works with Claude Code versions N and N-1 (backward-compatible) | Upstream CLI updates must not break the integration.       |
| Output format stability               | JSON output schema changes are detected by integration tests                | Silent schema drift causes parsing failures in production. |

---

## 1.4 ADR-004: Proxy Lifecycle Management

### Functionality

| Criterion                        | Threshold                                                                                                                  | Rationale                                                  |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| State machine completeness       | All transitions in `UNDEPLOYED -> DEPLOYING -> RUNNING -> HEALTHY` and `UNHEALTHY -> RECOVERING -> HEALTHY` fire correctly | Missing transitions leave proxy in undefined state.        |
| Docker compose template validity | Generated YAML passes `docker-compose config` for Docker Compose v2.20+                                                    | Version-incompatible YAML causes deployment failure.       |
| Health check pre-flight gate     | No Claude Code request is routed while proxy status is `UNHEALTHY` or `STOPPED`                                            | Routing to a dead proxy wastes the request timeout budget. |
| Fallback on proxy failure        | When proxy is `UNHEALTHY`, system falls back to direct API call or queues request per ADR specification                    | Silent request drop is unacceptable.                       |

### Reliability

| Criterion                      | Threshold                                                               | Rationale                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Auto-restart MTTR              | Proxy recovers from crash to HEALTHY in < 15s via Docker restart policy | Measured as time from container exit to next successful `/health` response. |
| Health check interval adequacy | 30s health check interval detects failure within 60s (2 missed checks)  | Excessively long intervals mask outages.                                    |
| Deployment idempotency         | Running `docker-compose up -d` twice produces the same running state    | Re-deployment must not orphan containers or duplicate ports.                |

### Performance

| Criterion                 | Threshold                                                              | Rationale                                                         |
| ------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Health check latency      | Pre-flight health check completes in < 100ms for cached status         | Uncached health check on every request adds unacceptable latency. |
| Container image pull time | `legard/claude-code-proxy:latest` pulls in < 30s on 100Mbps connection | First-time wizard deployment must not stall.                      |

### Security

| Criterion                 | Threshold                                                                                       | Rationale                                                                 |
| ------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| .env file permissions     | `.env` file created with mode 0600 (owner read/write only)                                      | World-readable `.env` exposes the API key to other users on shared hosts. |
| .env in .gitignore        | `.env` and `docker-compose.cloudru-proxy.yml` present in `.gitignore` before wizard writes them | Writing secrets before gitignore entry risks accidental commit.           |
| Container privilege scope | Proxy container runs without `--privileged` and with default seccomp profile                    | Privileged containers can escape to the host.                             |

### Maintainability

| Criterion                      | Threshold                                                             | Rationale                                                         |
| ------------------------------ | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Proxy image update path        | Clear documented procedure to update proxy image version              | Stale proxy image accumulates unpatched vulnerabilities.          |
| Health check endpoint contract | `/health` endpoint returns JSON with `status` field, versioned schema | Unversioned health check responses break monitoring integrations. |

---

## 1.5 ADR-005: Model Mapping and Fallback Strategy

### Functionality

| Criterion                  | Threshold                                                                                                                                      | Rationale                                                          |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Tier mapping completeness  | All 3 Claude Code tiers (opus/sonnet/haiku) resolve to valid cloud.ru model IDs for every wizard preset                                        | Unmapped tier causes a null model ID, producing 404 from cloud.ru. |
| Fallback chain termination | Every fallback chain terminates at `ERROR` within 3 hops maximum                                                                               | Circular or infinite fallback loops hang the request.              |
| Wizard preset correctness  | Each of the 3 wizard choices sets exactly the expected BIG/MIDDLE/SMALL model configuration                                                    | Incorrect preset silently assigns wrong model, degrading quality.  |
| Free tier invariant        | `SMALL_MODEL` is always `GLM-4.7-Flash` regardless of wizard choice                                                                            | Violating this invariant incurs unexpected costs.                  |
| Fallback trigger accuracy  | Fallback triggers on: HTTP 5xx, timeout > 120s, tool call parse error. Does NOT trigger on: 4xx client error, empty response, rate limit (429) | Incorrect triggers cause unnecessary fallbacks or missed recovery. |

### Reliability

| Criterion                 | Threshold                                                                                                            | Rationale                                                                        |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Fallback latency budget   | Total fallback chain completes within 180s (3 \* 60s per attempt)                                                    | Unbounded fallback time makes the system appear dead.                            |
| Model switch transparency | When fallback changes model mid-conversation, the user is informed (or response quality delta is < 20% on benchmark) | Silent quality degradation confuses users.                                       |
| Rate limit handling       | 429 responses trigger exponential backoff, NOT fallback to a different model                                         | Falling back on 429 wastes the fallback budget; the rate limit applies globally. |

### Performance

| Criterion                  | Threshold                                                                 | Rationale                                                           |
| -------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Model mapping lookup time  | < 1ms for tier-to-model resolution                                        | Mapping is a simple dictionary lookup; must not introduce overhead. |
| Fallback detection latency | Failure detected within 5s of first error signal (no unnecessary waiting) | Waiting for full timeout before fallback adds avoidable latency.    |

### Security

| Criterion                     | Threshold                                                                            | Rationale                                                                      |
| ----------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| Model ID injection prevention | Model IDs from config are validated against an allowlist before passing to proxy env | Arbitrary model IDs could reference unauthorized models or trigger proxy bugs. |
| Thinking mode isolation       | `DISABLE_THINKING=true` propagates correctly and cannot be overridden by user input  | Thinking mode leakage may expose chain-of-thought to end users.                |

### Maintainability

| Criterion                       | Threshold                                                                                    | Rationale                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Model ID single source of truth | All model IDs defined in one location; wizard, proxy env, and fallback config derive from it | Scattered definitions cause silent divergence.      |
| New model onboarding            | Adding a new cloud.ru model requires changes to at most 2 files                              | High change-set friction discourages model updates. |

---

# 2. Risk Storming per ADR

## 2.1 ADR-001: Proxy Integration Risks

| ID      | Risk                                                    | Category      | Prob |  Impact  |    P\*I    | Test Scenario                                                                                 |
| ------- | ------------------------------------------------------- | ------------- | :--: | :------: | :--------: | --------------------------------------------------------------------------------------------- |
| R001-01 | Proxy silently drops tool_use blocks during translation | Architectural |  M   | Critical |  **High**  | Send a multi-tool request (3+ tool_use blocks); verify all arrive at cloud.ru API verbatim.   |
| R001-02 | SSE stream corruption on large responses (>16K tokens)  | Operational   |  M   |   High   |  **High**  | Generate a 20K-token response; compare proxy output byte-by-byte with cloud.ru raw SSE.       |
| R001-03 | API key exposed in proxy error stack trace              | Security      |  L   | Critical | **Medium** | Trigger a proxy crash (invalid upstream URL); grep all logs and stdout for API key substring. |
| R001-04 | Proxy OOM on concurrent streaming requests              | Operational   |  M   |   High   |  **High**  | Send 10 concurrent streaming requests; monitor container RSS and OOM-kill events.             |
| R001-05 | Docker host port conflict (8082 already in use)         | Operational   |  M   |   Low    |  **Low**   | Attempt `docker-compose up` with port 8082 occupied; verify clear error message.              |
| R001-06 | Proxy image supply chain compromise                     | Security      |  L   | Critical | **Medium** | Verify image signature/digest; scan with Trivy for CVEs before deployment.                    |
| R001-07 | `serialize: true` deadlock under webhook retry          | Architectural |  L   |   High   | **Medium** | Simulate webhook retry while previous request is in-flight; verify no deadlock.               |
| R001-08 | Rate limit (15 req/s) causes cascading timeouts         | Operational   |  M   |  Medium  | **Medium** | Send 20 req/s burst; verify graceful 429 responses, not proxy crash.                          |

## 2.2 ADR-002: Wizard Auth Choice Risks

| ID      | Risk                                             | Category      | Prob | Impact |    P\*I    | Test Scenario                                                                                         |
| ------- | ------------------------------------------------ | ------------- | :--: | :----: | :--------: | ----------------------------------------------------------------------------------------------------- |
| R002-01 | Wizard writes invalid model ID to config         | Architectural |  L   |  High  | **Medium** | Mock each wizard choice; validate output model IDs against cloud.ru model catalog.                    |
| R002-02 | API key pasted with leading/trailing whitespace  | Operational   |  H   | Medium |  **High**  | Input key with `\n` and spaces; verify trimming before storage.                                       |
| R002-03 | Docker not installed on host                     | Operational   |  M   |  High  |  **High**  | Run wizard on a host without Docker; verify graceful error with install instructions.                 |
| R002-04 | Wizard overwrites existing non-cloudru config    | Operational   |  L   |  High  | **Medium** | Pre-populate `openclaw.json` with OpenAI config; run cloud.ru wizard; verify OpenAI config preserved. |
| R002-05 | `.env` file write fails (permissions, disk full) | Operational   |  L   | Medium |  **Low**   | Mock filesystem write failure; verify wizard reports error, not silent corruption.                    |
| R002-06 | Wizard group ID collision with future providers  | Architectural |  L   |  Low   |  **Low**   | Verify `"cloudru-fm"` does not collide with any existing `AuthChoiceGroupId` values.                  |

## 2.3 ADR-003: Agentic Engine Risks

| ID      | Risk                                                        | Category      | Prob |  Impact  |    P\*I    | Test Scenario                                                                                              |
| ------- | ----------------------------------------------------------- | ------------- | :--: | :------: | :--------: | ---------------------------------------------------------------------------------------------------------- |
| R003-01 | Claude Code subprocess hangs indefinitely                   | Operational   |  M   |   High   |  **High**  | Kill the proxy mid-request; verify subprocess times out and returns error within 300s.                     |
| R003-02 | JSON output contains non-JSON preamble from stderr          | Architectural |  M   |   High   |  **High**  | Force Claude Code to emit warning to stderr; verify JSON parsing ignores stderr content.                   |
| R003-03 | Session ID collision between two users                      | Security      |  L   | Critical | **Medium** | Generate 1M session IDs; verify zero collisions. Hash function collision test.                             |
| R003-04 | Tools disabled prompt ignored by GLM-4.7                    | Security      |  M   | Critical |  **High**  | Send a message that strongly prompts tool use ("read file X"); verify GLM-4.7 does not attempt tool calls. |
| R003-05 | `clearEnv` fails to remove host ANTHROPIC_API_KEY           | Security      |  L   | Critical | **Medium** | Set host `ANTHROPIC_API_KEY`; spawn subprocess; dump subprocess env; verify key is absent.                 |
| R003-06 | Claude Code upstream CLI update changes JSON schema         | Architectural |  M   |   High   |  **High**  | Pin test against known Claude Code version; run with version N+1; verify parsing still works.              |
| R003-07 | Concurrent user messages bypass `serialize: true`           | Architectural |  L   |   High   | **Medium** | Send 3 messages in rapid succession from different users; verify strict sequential execution.              |
| R003-08 | `--append-system-prompt` truncated by argument length limit | Operational   |  L   |  Medium  |  **Low**   | Pass a 10K-character system prompt; verify full content reaches Claude Code.                               |

## 2.4 ADR-004: Proxy Lifecycle Risks

| ID      | Risk                                                        | Category      | Prob |  Impact  |    P\*I    | Test Scenario                                                                                        |
| ------- | ----------------------------------------------------------- | ------------- | :--: | :------: | :--------: | ---------------------------------------------------------------------------------------------------- |
| R004-01 | Health check returns 200 but proxy cannot reach cloud.ru    | Architectural |  M   |   High   |  **High**  | Block outbound HTTPS from container (iptables); verify `/health` returns non-200.                    |
| R004-02 | Docker restart loop (crash -> restart -> crash)             | Operational   |  L   |   High   | **Medium** | Configure proxy with invalid `OPENAI_BASE_URL`; verify restart count caps and logs escalate.         |
| R004-03 | `.env` file committed to git despite .gitignore             | Security      |  L   | Critical | **Medium** | Create `.env`; run `git add .`; verify `.env` is not staged. Test with pre-existing `.env` in index. |
| R004-04 | Pre-flight health check adds >500ms to every request        | Performance   |  M   |  Medium  | **Medium** | Measure p99 health check latency over 1000 calls; verify < 100ms with caching.                       |
| R004-05 | State machine stuck in DEPLOYING (docker-compose hangs)     | Operational   |  L   |  Medium  |  **Low**   | Mock `docker-compose up` with infinite hang; verify deployment timeout fires.                        |
| R004-06 | Container runs as root with write access to host filesystem | Security      |  L   |   High   | **Medium** | Inspect container runtime user; verify non-root. Check no host volume mounts with write access.      |

## 2.5 ADR-005: Model Mapping & Fallback Risks

| ID      | Risk                                                 | Category      | Prob |  Impact  |    P\*I    | Test Scenario                                                                                                    |
| ------- | ---------------------------------------------------- | ------------- | :--: | :------: | :--------: | ---------------------------------------------------------------------------------------------------------------- |
| R005-01 | Fallback chain enters infinite loop                  | Architectural |  L   | Critical | **Medium** | Configure circular fallback (`A -> B -> A`); verify chain terminates with error after max hops.                  |
| R005-02 | Fallback triggers on 429 rate limit (incorrect)      | Architectural |  M   |   High   |  **High**  | Return 429 from mock cloud.ru; verify system retries same model with backoff, not fallback.                      |
| R005-03 | Model switch mid-conversation degrades coherence     | Operational   |  M   |  Medium  | **Medium** | Start conversation on GLM-4.7; force fallback to GLM-4.7-Flash at turn 5; evaluate response coherence.           |
| R005-04 | `DISABLE_THINKING=true` not propagated through proxy | Architectural |  M   |   High   |  **High**  | Enable thinking mode on GLM-4.7; verify proxy passes `DISABLE_THINKING`; check response has no thinking blocks.  |
| R005-05 | GLM-4.7 tool call parse crash causes proxy restart   | Operational   |  M   |   High   |  **High**  | Send request triggering GLM-4.7 tool call; inject malformed tool call response; verify proxy handles gracefully. |
| R005-06 | Wizard preset sets SMALL_MODEL to non-free model     | Architectural |  L   |  Medium  |  **Low**   | Validate all 3 wizard presets; assert `SMALL_MODEL === "zai-org/GLM-4.7-Flash"` in every case.                   |
| R005-07 | Anti-refusal system prompt exceeds 4000 char limit   | Operational   |  L   |  Medium  |  **Low**   | Measure system prompt length including anti-refusal additions; verify < 4000 characters.                         |

---

# 3. Testability Assessment per ADR

## 3.1 ADR-001: Proxy Integration -- Testability Score: 62/100

### Test Doubles Needed

| Double                   | Type         | Purpose                                                                                             |
| ------------------------ | ------------ | --------------------------------------------------------------------------------------------------- |
| Mock cloud.ru FM API     | Stub server  | Return canned responses for `/v1/chat/completions` to test proxy translation without real API calls |
| Mock Claude Code client  | HTTP client  | Send Anthropic-format requests to proxy to test protocol translation                                |
| Docker health check mock | Process mock | Simulate `/health` endpoint responses for lifecycle testing                                         |
| Network fault injector   | Chaos proxy  | Inject latency, drops, and resets between proxy and cloud.ru to test resilience                     |

### Integration Boundaries

| Boundary             | Owner   | Contract                                   |
| -------------------- | ------- | ------------------------------------------ |
| Claude Code -> Proxy | ADR-001 | Anthropic API protocol (request)           |
| Proxy -> Cloud.ru FM | ADR-001 | OpenAI-compatible protocol (request)       |
| Cloud.ru FM -> Proxy | ADR-001 | OpenAI-compatible protocol (response, SSE) |
| Proxy -> Claude Code | ADR-001 | Anthropic API protocol (response, SSE)     |

### Unit vs E2E Split

- **Unit (70%)**: Protocol translation functions, model name mapping, header transformation, SSE chunk parsing, error response formatting.
- **Integration (20%)**: Docker container startup, health check endpoint, request round-trip through running proxy.
- **E2E (10%)**: Full chain from Claude Code CLI to proxy to cloud.ru FM (requires real API key; gated behind `CI_CLOUDRU_KEY` env).

### Testability Gaps

- Proxy is a third-party Docker image; no source access for unit testing internals. Testing is black-box only.
- SSE streaming tests require a mock server that emits timed SSE events, which is non-trivial to set up.
- The `legard/claude-code-proxy` image does not publish its test suite or API contract specification.

---

## 3.2 ADR-002: Wizard Auth Choice -- Testability Score: 81/100

### Test Doubles Needed

| Double           | Type         | Purpose                                                                                        |
| ---------------- | ------------ | ---------------------------------------------------------------------------------------------- |
| Mock Docker CLI  | Command stub | Return success/failure for `docker-compose up` and `docker-compose config` without real Docker |
| Mock filesystem  | In-memory FS | Capture `.env` and `docker-compose.yml` writes without touching disk                           |
| Mock HTTP client | Stub         | Return canned `/health` responses for `verifyProxyHealth()`                                    |
| Mock prompter    | Input stub   | Provide scripted user inputs for each wizard step                                              |

### Integration Boundaries

| Boundary                  | Owner       | Contract             |
| ------------------------- | ----------- | -------------------- |
| Wizard -> `openclaw.json` | ADR-002     | Config schema (JSON) |
| Wizard -> `.env`          | ADR-002     | Key-value pairs      |
| Wizard -> Docker Compose  | ADR-002     | YAML template        |
| Wizard -> Proxy health    | ADR-002/004 | HTTP GET `/health`   |

### Unit vs E2E Split

- **Unit (80%)**: `applyCloudruFmConfig()` pure function, `generateDockerCompose()` template rendering, AuthChoice type validation, config schema conformance.
- **Integration (15%)**: Full wizard flow with mock prompter, Docker compose validation with real `docker-compose config`.
- **E2E (5%)**: Full wizard flow on real terminal with Docker deployment (manual QA or CI with Docker-in-Docker).

### Testability Strengths

- `applyCloudruFmConfig()` is explicitly described as a pure function, enabling deterministic unit testing.
- Existing wizard patterns (`onboard-custom.ts`) provide reference test implementations.
- 2-step selection flow is deterministic and enumerable (3 groups \* 3 choices = 9 paths).

---

## 3.3 ADR-003: Agentic Engine -- Testability Score: 55/100

### Test Doubles Needed

| Double                  | Type         | Purpose                                                                 |
| ----------------------- | ------------ | ----------------------------------------------------------------------- |
| Mock Claude Code CLI    | Process stub | Return canned JSON output without spawning real Claude Code             |
| Mock subprocess spawner | Spy/Stub     | Capture spawn arguments and env vars; return mock stdout/stderr streams |
| Session store mock      | In-memory    | Store and retrieve session IDs without filesystem persistence           |
| Timer mock              | Fake clock   | Control timeout behavior without waiting real seconds                   |

### Integration Boundaries

| Boundary                           | Owner       | Contract                                          |
| ---------------------------------- | ----------- | ------------------------------------------------- |
| OpenClaw -> Claude Code subprocess | ADR-003     | CLI args + env vars (input), JSON stdout (output) |
| Claude Code -> Proxy               | ADR-001/003 | ANTHROPIC_BASE_URL env var                        |
| Agent runner -> CLI backend config | ADR-003     | `resolveCliBackendConfig()` return type           |
| Session manager -> filesystem      | ADR-003     | `--session-id` persistence                        |

### Unit vs E2E Split

- **Unit (50%)**: Config resolution, env merging, session ID generation, JSON output parsing, error classification.
- **Integration (35%)**: Subprocess spawn with mock CLI, session continuity across calls, serialization enforcement.
- **E2E (15%)**: Full message cycle through OpenClaw to Claude Code to proxy to cloud.ru (requires all components running).

### Testability Gaps

- Subprocess testing is inherently flaky (timing, buffering, signal handling).
- `serialize: true` enforcement requires concurrent test orchestration to verify mutual exclusion.
- Claude Code's internal behavior (reasoning steps, tool disablement compliance) is opaque from OpenClaw's perspective.
- The ADR references `agent-runner.claude-cli.test.ts` but does not describe its coverage scope.

---

## 3.4 ADR-004: Proxy Lifecycle -- Testability Score: 58/100

### Test Doubles Needed

| Double                   | Type         | Purpose                                                      |
| ------------------------ | ------------ | ------------------------------------------------------------ |
| Mock Docker daemon       | API stub     | Simulate container start/stop/health without real Docker     |
| Mock filesystem          | In-memory    | Capture docker-compose YAML and .env writes                  |
| Mock network             | Stub         | Simulate proxy reachability/unreachability for health checks |
| State machine assertions | Test harness | Verify state transitions and invalid transition rejection    |

### Unit vs E2E Split

- **Unit (40%)**: State machine transitions, docker-compose template generation, .gitignore update logic, health check response parsing.
- **Integration (40%)**: Docker container lifecycle with real Docker daemon, health check round-trip, restart policy validation.
- **E2E (20%)**: Full wizard deployment to running proxy serving requests (requires Docker environment).

### Testability Gaps

- State machine is described in prose but not as a typed state machine implementation. No code artifact to test transitions against.
- Health check endpoint contract (`/health` response schema) is not formally specified.
- `UNHEALTHY -> RECOVERING` transition trigger is not defined (automatic? manual? after N successful checks?).
- Fallback behavior ("fall back to direct API call or queue the request") is described as two alternatives with no decision criteria.

---

## 3.5 ADR-005: Model Mapping & Fallback -- Testability Score: 74/100

### Test Doubles Needed

| Double                            | Type        | Purpose                                                                  |
| --------------------------------- | ----------- | ------------------------------------------------------------------------ |
| Mock cloud.ru API                 | Stub server | Return 5xx, 429, timeout, malformed tool calls to test fallback triggers |
| Mock config store                 | In-memory   | Provide model mapping and fallback lists without filesystem              |
| Mock timer                        | Fake clock  | Control timeout detection for fallback trigger testing                   |
| Mock `runAgentTurnWithFallback()` | Spy         | Verify fallback chain invocation order and termination                   |

### Unit vs E2E Split

- **Unit (75%)**: Model mapping lookup, fallback chain construction, fallback trigger classification (5xx vs 429 vs timeout), wizard preset validation, invariant checks (SMALL_MODEL = Flash).
- **Integration (20%)**: Fallback chain execution through `runAgentTurnWithFallback()` with mock API, model switch detection.
- **E2E (5%)**: Real model fallback under artificial cloud.ru failure (requires cloud.ru API access).

### Testability Strengths

- `ModelMapping` is a well-typed value object with clear fields, enabling property-based testing.
- Fallback chain is a finite, enumerable list (max 3 hops), enabling exhaustive path testing.
- Wizard presets are a 3x3 matrix, fully enumerable.
- `runAgentTurnWithFallback()` is an existing function with known behavior, testable via spy.

---

# 4. Quality Criteria Matrix

| Quality Characteristic | ADR-001 Proxy Integration                                                                      | ADR-002 Wizard Auth                                                                    | ADR-003 Agentic Engine                                                                                 | ADR-004 Proxy Lifecycle                                                                   | ADR-005 Model Mapping                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Functionality**      | Protocol translation 100% fidelity; tool_use round-trip; model name mapping zero failures      | 5-step wizard completes <120s; config passes schema validation; 3 auth choices compile | Subprocess spawn 99.5%+; JSON parse 100%; session continuity 100%; tools disabled enforced             | State machine complete; health gate blocks unhealthy routing; compose template valid YAML | 3-tier mapping complete; fallback terminates in <=3 hops; free tier invariant holds      |
| **Reliability**        | Container restart <15s MTTR; health check accuracy (no false 200s); timeout handling (no hang) | Idempotent re-runs; partial recovery on cancel; invalid key detection before write     | Subprocess timeout <300s; stderr isolation; serialization enforced; graceful proxy-failure degradation | Auto-restart <15s MTTR; 30s health interval detects within 60s; deployment idempotent     | Fallback budget <180s; rate limit triggers backoff not fallback; chain always terminates |
| **Performance**        | Translation <50ms p99; memory <256MB; cold start <5s; SSE forwarding <10ms                     | Step latency <200ms; health check timeout 5s                                           | Cold start <3s; warm resume <1s; E2E <30s p90; memory <512MB per subprocess                            | Health check <100ms cached; image pull <30s                                               | Mapping lookup <1ms; failure detection <5s                                               |
| **Security**           | Key not in logs; TLS 1.2+; input sanitization; no debug endpoints                              | Key masked in terminal; key only in .env; compose in .gitignore                        | clearEnv removes host key; permission skip scoped; session ID collision-free                           | .env mode 0600; .env in .gitignore; container non-root                                    | Model ID allowlist; DISABLE_THINKING propagation                                         |
| **Maintainability**    | Image version pinned; config via env vars; structured JSON logs                                | Model IDs in 1 file; follows onboard-custom.ts pattern                                 | CLI version N and N-1 compatible; output schema change detection                                       | Documented image update path; versioned health endpoint                                   | Single source of truth for model IDs; new model in <=2 files                             |

---

# 5. Missing Quality Scenarios

## 5.1 Failure Modes Not Addressed

| ID    | Failure Mode                                      | Affected ADRs | Description                                                                                                                                                                                                       | Suggested Test                                                                                                                                                                                 |
| ----- | ------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MQ-01 | **Proxy crash during streaming response**         | 001, 003      | If proxy crashes mid-SSE stream, Claude Code receives a truncated response. No ADR specifies how partial responses are handled -- is the truncated text delivered to the user, or is the entire response dropped? | Kill proxy container during a 10K-token streaming response. Verify OpenClaw either delivers nothing (with error) or delivers complete response (with retry). Never deliver truncated response. |
| MQ-02 | **cloud.ru API key rotation**                     | 001, 002, 004 | No ADR describes how to rotate the cloud.ru API key after initial setup. The current flow requires manually editing `.env` and restarting the proxy container.                                                    | Rotate key in `.env`; restart proxy; verify new key is used within 30s. Verify old key produces 401 that triggers user notification.                                                           |
| MQ-03 | **Disk full during session persistence**          | 003           | Claude Code persists sessions to disk. If the host disk is full, session writes fail silently or crash. No ADR addresses disk space monitoring.                                                                   | Fill disk to 99%; send a message; verify Claude Code exits with a parseable error, not corruption of existing sessions.                                                                        |
| MQ-04 | **Proxy and OpenClaw timezone/clock skew**        | 001, 004      | Health check timestamps, request timeouts, and Docker restart timing all depend on consistent clocks. No ADR mentions NTP or clock synchronization.                                                               | Set container clock 5 minutes ahead of host; verify health checks still function correctly.                                                                                                    |
| MQ-05 | **Unicode handling in model names**               | 005           | Cloud.ru model IDs contain ASCII-only names today, but no validation prevents future model IDs with non-ASCII characters. Proxy env vars may not handle non-ASCII correctly on all platforms.                     | Set `BIG_MODEL` to a model ID containing Cyrillic characters; verify proxy passes the ID to cloud.ru without mojibake.                                                                         |
| MQ-06 | **Multiple OpenClaw instances sharing one proxy** | 001, 004      | No ADR addresses whether multiple OpenClaw instances (e.g., staging + production) can share a single proxy container, or if this causes session/key contamination.                                                | Run two OpenClaw instances with different API keys against one proxy; verify request isolation.                                                                                                |

## 5.2 Edge Cases Not Covered

| ID    | Edge Case                                                                    | Affected ADRs | Expected Behavior                                                                  | Currently Undefined                                               |
| ----- | ---------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| EC-01 | User sends empty message ("")                                                | 003, 005      | Claude Code should return a prompt for clarification, not an error                 | Yes -- no validation at OpenClaw boundary before subprocess spawn |
| EC-02 | User sends message exceeding 200K context window                             | 003, 005      | System should reject with clear error before sending to cloud.ru                   | Yes -- no input length validation in `runCliAgent()`              |
| EC-03 | cloud.ru returns empty response body with 200 OK                             | 001, 005      | Proxy should translate to Anthropic-format error, not pass empty body              | Yes -- empty response handling not specified                      |
| EC-04 | Proxy receives request with `anthropic-version` header it does not recognize | 001           | Proxy should use a default version, not reject the request                         | Yes -- version negotiation not specified                          |
| EC-05 | Wizard run on Windows (no Unix `.env` conventions)                           | 002, 004      | Wizard should detect OS and adjust file paths and Docker commands                  | Yes -- Unix-only assumptions throughout                           |
| EC-06 | GLM-4.7 returns thinking blocks despite `DISABLE_THINKING=true`              | 005           | System should strip thinking blocks before delivering to user                      | Yes -- no post-processing of thinking block leakage               |
| EC-07 | Session ID contains special characters (slashes, colons)                     | 003           | Session ID must be filesystem-safe and URL-safe                                    | Yes -- session ID format constraints not specified                |
| EC-08 | Fallback triggers simultaneously for all 3 tiers (cloud.ru full outage)      | 005           | System should report service unavailable, not attempt 9 retries (3 tiers x 3 hops) | Yes -- global outage detection not specified                      |
| EC-09 | User cancels request while subprocess is running                             | 003           | Subprocess should be killed; partial response discarded                            | Yes -- cancellation handling not specified                        |
| EC-10 | Docker compose file already exists from previous installation                | 002, 004      | Wizard should detect existing file and offer overwrite/merge/skip                  | Yes -- no conflict resolution for existing compose files          |

## 5.3 Data Consistency Scenarios

| ID    | Scenario                                                                              | Risk                                                                                       | Affected ADRs |
| ----- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ------------- |
| DC-01 | `openclaw.json` edited manually after wizard, invalidating proxy config alignment     | Config drift between `openclaw.json` model references and proxy `BIG_MODEL` env            | 002, 005      |
| DC-02 | `.env` contains `CLOUDRU_API_KEY` but `openclaw.json` references a different provider | Silent misconfiguration: proxy uses cloud.ru key, but OpenClaw routes to different backend | 002, 003      |
| DC-03 | Proxy env `BIG_MODEL` changed but OpenClaw fallback list still references old model   | Fallback attempts to use a model the proxy no longer maps to                               | 004, 005      |
| DC-04 | Session persisted with GLM-4.7 context; fallback switches to GLM-4.7-Flash            | Session context may exceed Flash's effective attention; response quality drops sharply     | 003, 005      |

## 5.4 Performance Degradation Scenarios

| ID    | Scenario                                                                 | Expected Behavior                                                                            | Currently Undefined                                                                                    |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| PD-01 | 50 concurrent users, each sending 1 msg/min, `serialize: true`           | Queue depth grows linearly; p99 latency exceeds 50 \* avg_response_time                      | Yes -- no queue depth limit or rejection policy                                                        |
| PD-02 | GLM-4.7 response time spikes to 60s (cloud.ru degradation)               | Fallback triggers after timeout; user receives response from fallback model in <120s total   | Partially -- fallback triggers on timeout, but timeout value and fallback latency budget not specified |
| PD-03 | Docker host under memory pressure; proxy container OOM-killed repeatedly | Proxy enters restart loop; health check flaps; OpenClaw alternates between routing and error | Yes -- no circuit breaker for flapping proxy                                                           |
| PD-04 | Session file grows to 100MB+ after extended conversation                 | Claude Code `--resume` takes >10s to load session; user perceives cold-start latency         | Yes -- no session size limit or pruning strategy                                                       |

---

# 6. Cross-ADR Interactions

## 6.1 Interaction Map

```
ADR-002 (Wizard) ──writes──> ADR-004 (Proxy Lifecycle)
     │                              │
     │ configures                   │ manages
     v                              v
ADR-005 (Model Mapping) <──maps── ADR-001 (Proxy Integration)
     │                              │
     │ fallback list                │ translates protocol
     v                              v
ADR-003 (Agentic Engine) ──routes through──> ADR-001
```

## 6.2 Cross-ADR Risk Analysis

### Risk X-01: Proxy Crash Cascades to Agentic Engine (ADR-001 x ADR-003)

**Scenario**: Proxy container crashes (OOM, segfault) while Claude Code subprocess is mid-request.

**Chain of failure**:

1. Proxy crashes (ADR-001)
2. Claude Code subprocess receives TCP RST or timeout (ADR-003)
3. Claude Code emits non-JSON error to stderr (ADR-003)
4. `runCliAgent()` JSON parsing fails (ADR-003)
5. User receives opaque error (ADR-003)
6. Proxy restarts via Docker policy (ADR-004)
7. Next request succeeds, but session context may be corrupted (ADR-003)

**Test scenario**: Kill proxy container with `docker kill` during an active Claude Code request. Verify:

- Claude Code subprocess exits within 30s (not hang)
- Error returned to user is human-readable
- Next request after proxy restart succeeds with session continuity

**Gap**: No ADR specifies the Claude Code subprocess behavior when the proxy connection is abruptly severed.

### Risk X-02: Wizard Config Drift Breaks Model Fallback (ADR-002 x ADR-005)

**Scenario**: User runs wizard, selects "GLM-4.7 (Full)". Later, they manually edit `openclaw.json` to change the primary model to a custom model, but the proxy env vars still map to the wizard's original selection.

**Chain of failure**:

1. Wizard writes `BIG_MODEL=zai-org/GLM-4.7` to proxy env (ADR-002)
2. User edits `openclaw.json` primary model to `custom-model-x` (manual)
3. OpenClaw requests `custom-model-x` via Claude Code (ADR-003)
4. Claude Code sends `model: claude-opus-4-6` to proxy (hardcoded) (ADR-001)
5. Proxy maps opus to `BIG_MODEL=GLM-4.7` regardless of OpenClaw config (ADR-005)
6. Fallback list in `openclaw.json` references models the proxy cannot serve (ADR-005)

**Test scenario**: Configure wizard defaults, then manually override `openclaw.json` primary model. Verify that the system either (a) detects the mismatch and warns, or (b) correctly resolves through the proxy mapping regardless.

**Gap**: No validation that `openclaw.json` model references are consistent with proxy env model mappings.

### Risk X-03: Health Check False Positive Masks Upstream Outage (ADR-004 x ADR-001)

**Scenario**: Proxy's `/health` endpoint returns 200 because the proxy process is alive, but cloud.ru FM API is down (5xx).

**Chain of failure**:

1. Pre-flight health check passes (ADR-004)
2. Request routed to Claude Code subprocess (ADR-003)
3. Claude Code sends request through proxy (ADR-001)
4. Proxy forwards to cloud.ru, gets 5xx (ADR-001)
5. Proxy returns 5xx to Claude Code (ADR-001)
6. Claude Code subprocess fails with model error (ADR-003)
7. Fallback triggers (ADR-005) -- but ALL models are on cloud.ru, so fallback also fails
8. User receives error after exhausting entire fallback chain (ADR-005)

**Test scenario**: Block cloud.ru DNS from proxy container. Verify:

- `/health` returns non-200 (if deep health check) OR
- Fallback chain terminates quickly with "upstream unavailable" (if shallow health check)
- Total user-visible latency for full failure < 60s

**Gap**: ADR-004 does not specify whether `/health` performs a deep check (probe cloud.ru) or shallow check (process alive only).

### Risk X-04: Wizard Proxy Deployment Fails Silently (ADR-002 x ADR-004)

**Scenario**: Docker Compose generation succeeds (ADR-002), but `docker-compose up -d` fails silently because the Docker daemon is not running.

**Chain of failure**:

1. Wizard generates valid YAML (ADR-002)
2. Wizard runs `docker-compose up -d` (ADR-004)
3. Docker daemon not running; command exits with error code
4. Wizard does not check exit code (gap)
5. Wizard proceeds to `verifyProxyHealth()` which times out
6. Wizard reports "proxy unhealthy" without explaining root cause

**Test scenario**: Stop Docker daemon before wizard execution. Verify wizard detects Docker daemon unavailability BEFORE attempting compose deployment and provides actionable error ("Docker daemon is not running. Start it with: ...").

**Gap**: ADR-002's wizard flow does not include a Docker daemon availability check before Step 4.

### Risk X-05: Fallback Model Switch Exceeds Session Context Window (ADR-005 x ADR-003)

**Scenario**: Conversation started on GLM-4.7 (200K context). After 150K tokens accumulated in session, fallback switches to Qwen3-Coder-480B (128K context).

**Chain of failure**:

1. Session accumulates 150K tokens over multiple turns (ADR-003)
2. GLM-4.7 fails (timeout, tool call error) (ADR-005)
3. Fallback selects Qwen3-Coder-480B (128K context limit) (ADR-005)
4. Session context (150K) exceeds Qwen3's 128K limit (ADR-003 x ADR-005)
5. Qwen3 either truncates context (losing critical conversation history) or returns 400

**Test scenario**: Build a session with 150K tokens on GLM-4.7. Force fallback to Qwen3-Coder. Verify:

- System detects context window incompatibility BEFORE sending to Qwen3
- Either truncates intelligently (summarize old context) or skips Qwen3 in fallback chain

**Gap**: No ADR specifies context window compatibility checking during fallback model selection.

### Risk X-06: Rate Limit Interaction Between Proxy and Fallback (ADR-001 x ADR-005)

**Scenario**: cloud.ru rate limits at 15 req/s. Fallback chain makes 3 attempts (primary + 2 fallbacks). Under moderate load (6 users), each user's fallback chain consumes 3 of the 15 req/s budget, starving other users.

**Chain of failure**:

1. 6 users send concurrent messages (ADR-003)
2. Primary model fails for all (e.g., cloud.ru returns 503) (ADR-005)
3. Each user's fallback chain fires 2 additional requests (ADR-005)
4. Total: 6 primary + 12 fallback = 18 requests, exceeding 15 req/s limit (ADR-001)
5. Rate limiting kicks in (429), triggering MORE retries
6. Cascading failure: all users experience timeouts

**Test scenario**: Simulate 6 concurrent users with primary model returning 503. Measure total requests hitting cloud.ru. Verify fallback requests are rate-limited or queued to stay within 15 req/s budget.

**Gap**: No ADR specifies rate limit awareness in the fallback chain. Fallback attempts count against the global rate limit budget but are not throttled.

---

# 7. Recommended Test Implementation Priority

| Priority | Test Area                                                 | Effort |   Risk Covered   |     ADRs      |
| :------: | --------------------------------------------------------- | :----: | :--------------: | :-----------: |
|    P0    | Proxy protocol translation fidelity (tool_use round-trip) |   M    |     R001-01      |      001      |
|    P0    | Subprocess timeout and error parsing                      |   M    | R003-01, R003-02 |      003      |
|    P0    | API key non-exposure in logs and errors                   |   S    | R001-03, R003-05 |   001, 003    |
|    P0    | Fallback chain termination (no infinite loops)            |   S    |     R005-01      |      005      |
|    P0    | Health check accuracy (no false 200s)                     |   M    |  R004-01, X-03   |   001, 004    |
|    P1    | Wizard config output schema validation                    |   S    |     R002-01      |      002      |
|    P1    | Serialization enforcement under concurrency               |   M    |     R003-07      |      003      |
|    P1    | Rate limit triggers backoff not fallback                  |   S    |     R005-02      |      005      |
|    P1    | Proxy crash recovery E2E                                  |   L    |       X-01       | 001, 003, 004 |
|    P1    | Session context window check before fallback              |   M    |       X-05       |   003, 005    |
|    P2    | Wizard idempotency and config preservation                |   M    |     R002-04      |      002      |
|    P2    | Docker daemon availability pre-check                      |   S    |       X-04       |   002, 004    |
|    P2    | GLM-4.7 tool call instability handling                    |   L    |     R005-05      |   001, 005    |
|    P2    | Rate limit budget under fallback cascade                  |   M    |       X-06       |   001, 005    |
|    P3    | Container security profile validation                     |   S    |     R004-06      |      004      |
|    P3    | Windows compatibility for wizard                          |   L    |      EC-05       |   002, 004    |
|    P3    | Session size pruning strategy                             |   M    |      PD-04       |      003      |

**Effort**: S = <1 day, M = 1-3 days, L = 3-5 days

---

# 8. Summary of Findings

## Testability Scores

| ADR     | Score  | Key Weakness                                                                        |
| ------- | :----: | ----------------------------------------------------------------------------------- |
| ADR-001 | 62/100 | Third-party Docker image; black-box only; no published contract                     |
| ADR-002 | 81/100 | Pure function design is highly testable; Docker dependency lowers score             |
| ADR-003 | 55/100 | Subprocess testing inherently flaky; Claude Code internals opaque                   |
| ADR-004 | 58/100 | State machine not typed; health check contract unspecified; Docker dependency       |
| ADR-005 | 74/100 | Well-typed value objects; enumerable paths; but fallback trigger criteria ambiguous |

## Top 5 Quality Gaps

1. **No deep health check**: `/health` does not verify cloud.ru reachability, allowing false-positive routing (ADR-001, ADR-004).
2. **No fallback rate limit awareness**: Fallback chain can amplify request volume beyond the 15 req/s budget under failure conditions (ADR-001, ADR-005).
3. **No context window compatibility check**: Fallback to a model with a smaller context window causes silent truncation or hard failure (ADR-003, ADR-005).
4. **No subprocess cancellation path**: User-initiated cancellation has no mechanism to kill the Claude Code subprocess (ADR-003).
5. **No config drift detection**: Manual edits to `openclaw.json` after wizard setup can silently break model mapping alignment (ADR-002, ADR-005).

## Recommendation

Prioritize P0 test scenarios immediately, as they cover the most likely and most damaging failure modes. The cross-ADR interaction risks (X-01 through X-06) are particularly important because they emerge only at the boundary between architectural decisions and are invisible when each ADR is reviewed in isolation.
