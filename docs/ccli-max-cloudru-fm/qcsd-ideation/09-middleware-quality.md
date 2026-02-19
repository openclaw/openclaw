# 09 - Middleware / Integration Quality Analysis

**QCSD Phase**: Ideation
**Validator**: qe-middleware-validator
**Flag**: HAS_MIDDLEWARE=TRUE
**Date**: 2026-02-12
**Scope**: ADR-001, ADR-003, ADR-004, ADR-005, cli-runner.ts, cli-backends.ts

---

## 1. Architecture Overview

The middleware chain under analysis is a four-layer pipeline:

```
Layer 1: OpenClaw (runCliAgent / agent-runner.ts)
  |
  | spawns subprocess
  v
Layer 2: Claude Code (CLI binary, env-configured)
  |
  | HTTP (Anthropic API protocol)
  v
Layer 3: claude-code-proxy (Docker, port 8082)
  |
  | HTTP (OpenAI API protocol)
  v
Layer 4: cloud.ru FM API (https://foundation-models.api.cloud.ru/v1/)
```

Each layer boundary introduces a protocol translation, failure mode, and observability gap. This analysis evaluates the quality, completeness, and risks of each boundary.

---

## 2. Protocol Translation Quality

### 2.1 Anthropic API to OpenAI API Mapping

The `claude-code-proxy` is responsible for translating the Anthropic Messages API into OpenAI Chat Completions API. The following field mappings are required:

| Anthropic Field                        | OpenAI Equivalent                              | Status                                                                                                                      |
| -------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `x-api-key` header                     | `Authorization: Bearer` header                 | HANDLED (proxy core feature)                                                                                                |
| `anthropic-version` header             | Not applicable                                 | STRIPPED (proxy must ignore)                                                                                                |
| `/v1/messages` endpoint                | `/v1/chat/completions` endpoint                | HANDLED (proxy routing)                                                                                                     |
| `model: "opus"`                        | `model: "zai-org/GLM-4.7"` (via BIG_MODEL env) | HANDLED (3-tier mapping)                                                                                                    |
| `messages[].role: "user"`              | `messages[].role: "user"`                      | COMPATIBLE (same format)                                                                                                    |
| `messages[].content` (array of blocks) | `messages[].content` (string or array)         | RISK: Anthropic content blocks use `{type: "text", text: "..."}` arrays; OpenAI expects strings or a different array format |
| `system` (top-level field)             | `messages[0].role: "system"`                   | HANDLED (proxy must restructure)                                                                                            |
| `max_tokens` (required in Anthropic)   | `max_tokens` (optional in OpenAI)              | COMPATIBLE                                                                                                                  |
| `stream: true`                         | `stream: true`                                 | SEE SECTION 2.3                                                                                                             |
| `tool_use` blocks                      | `function_calling` / `tool_calls`              | SEE SECTION 2.2                                                                                                             |
| `stop_reason`                          | `finish_reason`                                | HANDLED (proxy response mapping)                                                                                            |

**Finding MQ-01 (MEDIUM)**: The ADRs do not document the content block array format translation. Anthropic uses `content: [{type: "text", text: "..."}, {type: "image", ...}]` while OpenAI uses `content: "string"` or `content: [{type: "text", text: "..."}, {type: "image_url", ...}]`. The proxy must handle this, but the ADRs treat it as a black box.

### 2.2 Tool Calling Format Differences

ADR-001 identifies tool calling format incompatibility as a known force. ADR-003 mitigates this partially by disabling tools in OpenClaw sessions (`cli-runner.ts:82-83`):

```typescript
"Tools are disabled in this session. Do not call tools.";
```

However, Claude Code itself may still internally attempt tool_use blocks even when instructed not to (the instruction is in the system prompt, not an API-level toggle). If a tool_use block reaches the proxy:

- Anthropic format: `{type: "tool_use", id: "...", name: "...", input: {...}}`
- OpenAI format: `{tool_calls: [{id: "...", type: "function", function: {name: "...", arguments: "..."}}]}`

ADR-005 notes that GLM-4.7 has known tool calling instabilities (sglang #15721) and the proxy handles streaming tool call parse crashes internally.

**Finding MQ-02 (HIGH)**: The system prompt-level tool disablement (`"Tools are disabled"`) is a soft constraint. If the underlying model (GLM-4.7 via proxy) generates a response that Claude Code interprets as containing tool calls, the round-trip translation (Anthropic tool_use -> proxy -> OpenAI function_calling -> cloud.ru -> response -> proxy -> Anthropic tool_result) has no documented validation. ADR-005 mentions "Proxy validates response format" but does not specify what validation occurs or what happens when validation fails.

**Finding MQ-03 (MEDIUM)**: There is no documented mechanism for Claude Code's internal tool orchestration (MCP, file ops, bash) to be translated through the proxy. ADR-003 explicitly notes tools are disabled, but if a future ADR enables selective tools, the proxy translation layer becomes a critical bottleneck with no current design for tool_result round-trips.

### 2.3 Streaming Format Differences

Anthropic uses Server-Sent Events (SSE) with event types:

- `message_start`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`

OpenAI uses SSE with:

- `data: {"choices": [{"delta": {"content": "..."}}]}`

The proxy must translate between these formats in real-time. ADR-003 explicitly notes:

> No streaming to end user (batch response only)

This is because Claude Code is invoked with `--output-format json`, which means Claude Code collects the full response before outputting JSON to stdout. The proxy still handles streaming between itself and cloud.ru internally, but the OpenClaw layer receives a batch response.

**Finding MQ-04 (LOW)**: Streaming is not surfaced to the end user. This eliminates a class of streaming translation bugs at the OpenClaw layer but introduces latency (full response must complete before user sees anything). For long responses from GLM-4.7 (which has 200K context), this could mean multi-second waits with no feedback.

### 2.4 Error Code Mapping

| cloud.ru HTTP Status     | Proxy Translation                    | Claude Code Interpretation            | OpenClaw Handling               |
| ------------------------ | ------------------------------------ | ------------------------------------- | ------------------------------- |
| 200 OK                   | Pass through with format translation | Parse JSON response                   | Return to user                  |
| 400 Bad Request          | Should map to Anthropic 400          | `FailoverError(reason: "format")`     | Fallback chain                  |
| 401 Unauthorized         | Should map to Anthropic 401          | `FailoverError(reason: "auth")`       | Fail (no key rotation possible) |
| 429 Rate Limited         | Should map to Anthropic 429          | `FailoverError(reason: "rate_limit")` | Fallback chain                  |
| 500/502/503 Server Error | Should map to 5xx                    | Generic error (non-zero exit code)    | Fallback chain                  |
| Timeout                  | Connection timeout                   | `FailoverError(reason: "timeout")`    | Fallback chain                  |

**Finding MQ-05 (MEDIUM)**: The ADRs do not document how the proxy translates cloud.ru error responses into Anthropic-compatible error responses. Claude Code expects errors in Anthropic format (`{type: "error", error: {type: "...", message: "..."}}`). If the proxy passes through OpenAI-format errors, Claude Code may fail to parse them, resulting in a generic non-zero exit code with opaque stderr instead of a classifiable `FailoverError`.

---

## 3. Request/Response Integrity

### 3.1 Field Mapping Completeness

Examining `cli-runner.ts:222-228`, the environment construction is:

```typescript
const env = (() => {
  const next = { ...process.env, ...backend.env };
  for (const key of backend.clearEnv ?? []) {
    delete next[key];
  }
  return next;
})();
```

And from `cli-backends.ts:95-110`, the merge:

```typescript
function mergeBackendConfig(base, override) {
  return {
    ...base,
    ...override,
    args: override.args ?? base.args,
    env: { ...base.env, ...override.env },
    clearEnv: Array.from(new Set([...(base.clearEnv ?? []), ...(override.clearEnv ?? [])])),
    // ...
  };
}
```

The `clearEnv` field in `DEFAULT_CLAUDE_BACKEND` contains `["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]`. This is a security-critical invariant: the real Anthropic key is removed before injecting the proxy key.

**Finding MQ-06 (POSITIVE)**: The `clearEnv` mechanism is well-designed. It ensures that the host's real ANTHROPIC_API_KEY does not leak to the subprocess, preventing accidental bypass of the proxy. This is documented as a DDD invariant in ADR-003.

### 3.2 Multi-turn Conversation Preservation

Session continuity is handled by `resolveSessionIdToSend()` in `helpers.ts:421-437`:

```typescript
if (existing) {
  return { sessionId: existing, isNew: false };
}
return { sessionId: crypto.randomUUID(), isNew: true };
```

Claude Code uses `--session-id` on first call and `--resume {sessionId}` on subsequent calls. The session state lives entirely within Claude Code's local session store (on disk). The proxy is stateless.

**Finding MQ-07 (POSITIVE)**: Session state is correctly decoupled from the proxy. The proxy does not need to maintain conversation history. Claude Code handles context injection via its session mechanism. This means proxy restarts do not break multi-turn conversations (only the in-flight request fails).

**Finding MQ-08 (MEDIUM)**: However, the system prompt is only injected on the first message (`systemPromptWhen: "first"` in `DEFAULT_CLAUDE_BACKEND`). If the proxy restarts and Claude Code's session is lost (or session data corrupts), subsequent messages will lack the system prompt. There is no mechanism to detect session staleness and re-inject the system prompt.

### 3.3 Response Parsing

`parseCliJson()` in `helpers.ts:330-352` attempts to extract text from Claude Code's JSON output:

```typescript
const text =
  collectText(parsed.message) ||
  collectText(parsed.content) ||
  collectText(parsed.result) ||
  collectText(parsed);
```

This is a defensive multi-field fallback. The `collectText()` function handles nested structures including `{type: "text", text: "..."}` content blocks.

**Finding MQ-09 (LOW)**: If cloud.ru returns a response format that the proxy translates into a non-standard Anthropic JSON structure, `parseCliJson` may fail to extract text. The function falls back to returning `null`, which causes `runCliAgent` to return `{ text: stdout }` (raw stdout). This is a graceful degradation but may produce garbled output to the user.

---

## 4. Routing Quality

### 4.1 Model Name Routing (3-Tier)

The routing chain is:

1. OpenClaw sends `--model opus` to Claude Code subprocess
2. `normalizeCliModel()` in `helpers.ts:251-266` maps via `CLAUDE_MODEL_ALIASES`:
   - `opus` -> `opus`, `sonnet` -> `sonnet`, `haiku` -> `haiku`
3. Claude Code sends `model: "opus"` to the proxy (via Anthropic API)
4. Proxy maps via environment variables:
   - `opus`-class -> `BIG_MODEL` -> `zai-org/GLM-4.7`
   - `sonnet`-class -> `MIDDLE_MODEL` -> `Qwen/Qwen3-Coder-480B-A35B-Instruct`
   - `haiku`-class -> `SMALL_MODEL` -> `zai-org/GLM-4.7-Flash`

**Finding MQ-10 (MEDIUM)**: The exact model name matching in the proxy is undocumented. Claude Code may send model names like `claude-opus-4-6` (full name) or `opus` (alias). The `CLAUDE_MODEL_ALIASES` in `cli-backends.ts:10-28` normalizes to short names (`opus`, `sonnet`, `haiku`) before passing to the CLI. However, whether the proxy recognizes these exact strings and maps them to the correct environment variable is assumed but not verified in the ADRs. If Claude Code internally overrides the model name (e.g., for different task complexity), the proxy mapping may break.

### 4.2 Fallback Chain Correctness

ADR-005 defines two fallback chains:

```
GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash -> ERROR
Qwen3-Coder -> GLM-4.7 -> GLM-4.7-Flash -> ERROR
```

Fallback is handled by `runWithModelFallback()` in `model-fallback.ts:209-321`. This function iterates through `candidates` and catches `FailoverError` instances. The fallback list comes from `agents.defaults.model.fallbacks` in config.

**Finding MQ-11 (HIGH)**: There is a fundamental mismatch between the fallback mechanism and the proxy architecture. OpenClaw's fallback in `model-fallback.ts` changes the `provider` and `model` parameters for each retry. However, the model mapping lives inside the proxy's environment variables (BIG_MODEL, MIDDLE_MODEL, SMALL_MODEL), not in the request. If OpenClaw tries to fall back from `opus` to `sonnet`, Claude Code will send `model: "sonnet"` to the proxy, which maps to MIDDLE_MODEL. This works. But if the fallback list includes a specific cloud.ru model name (e.g., `zai-org/GLM-4.7-FlashX`), Claude Code will send that literal string to the proxy, which may not have a mapping for it.

The ADR-005 fallback chains (`GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash`) are described at the cloud.ru level, but OpenClaw's fallback operates at the Claude model tier level (`opus -> sonnet -> haiku`). These two chains must be aligned, and this alignment is not formally verified.

### 4.3 Circular Fallback Prevention

ADR-005 lists an invariant: "Model fallback list must terminate (no circular fallbacks)."

Examining `resolveFallbackCandidates()` in `model-fallback.ts:130-207`:

```typescript
const seen = new Set<string>();
const addCandidate = (candidate, enforceAllowlist) => {
  const key = modelKey(candidate.provider, candidate.model);
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  candidates.push(candidate);
};
```

**Finding MQ-12 (POSITIVE)**: The `seen` set prevents duplicate candidates, which effectively prevents circular fallbacks. Each model/provider combination can only appear once in the candidate list. The iteration is a simple for-loop over a finite array, so it always terminates.

### 4.4 Request Queuing Under Load

`cli-backends.ts:52` sets `serialize: true` for the default Claude backend. This feeds into `cli-runner.ts:177-178`:

```typescript
const serialize = backend.serialize ?? true;
const queueKey = serialize ? backendResolved.id : `${backendResolved.id}:${params.runId}`;
```

The `enqueueCliRun()` function in `helpers.ts:152-162` chains promises:

```typescript
const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
const chained = prior.catch(() => undefined).then(task);
```

**Finding MQ-13 (HIGH)**: With `serialize: true`, ALL requests to the `claude-cli` backend are serialized globally. This means only one user message can be processed at a time across all OpenClaw conversations. If one request takes 30 seconds (possible with GLM-4.7's 200K context), all other users are queued. ADR-001 acknowledges the cloud.ru rate limit of 15 req/s, but the serialization constraint reduces effective throughput to well below that. For multi-user deployments, this is a severe bottleneck.

---

## 5. Error Propagation

### 5.1 cloud.ru 5xx Errors

**Propagation path:**

```
cloud.ru returns HTTP 500
  -> proxy receives 500, translates to Anthropic error format (UNVERIFIED)
  -> Claude Code receives error, writes error to stderr, exits non-zero
  -> cli-runner.ts:262-272 catches non-zero exit code:
     const err = stderr || stdout || "CLI failed.";
     const reason = classifyFailoverReason(err) ?? "unknown";
     throw new FailoverError(err, { reason, provider, model, status });
  -> model-fallback.ts catches FailoverError, tries next candidate
  -> If all candidates fail: throw Error("All models failed (N): summary")
  -> agent-runner.ts surfaces error to user
```

**Finding MQ-14 (MEDIUM)**: The error classification depends on `classifyFailoverReason()` being able to parse the error string from stderr. If the proxy returns an error in OpenAI format that Claude Code does not recognize, the stderr output may be a generic error message. The `classifyFailoverReason()` function uses regex matching on strings like "timeout", "rate limit", etc. Cloud.ru-specific error messages may not match these patterns, resulting in `reason: "unknown"` and potentially missing the fallback path (since only recognized FailoverError reasons trigger fallback in some code paths).

### 5.2 Proxy Crash

**Propagation path:**

```
Proxy Docker container crashes
  -> Claude Code HTTP request to localhost:8082 fails (ECONNREFUSED)
  -> Claude Code exits with non-zero code and error in stderr
  -> cli-runner.ts catches as FailoverError (reason: "timeout" or "unknown")
  -> Docker restart policy (unless-stopped) restarts proxy
  -> Next request may succeed after restart (~2-5s Docker restart time)
```

**Finding MQ-15 (MEDIUM)**: The proxy crash scenario has a race condition. Docker's `unless-stopped` restart policy will restart the container, but there is no coordination between the restart and incoming requests. If OpenClaw retries (via fallback) during the restart window, the retry will also fail with ECONNREFUSED. The health check interval (30s from ADR-001's docker-compose) is too slow to detect crash-restart cycles in real-time.

### 5.3 Timeout Propagation

`failover-error.ts:115-143` provides comprehensive timeout detection:

```typescript
function hasTimeoutHint(err): boolean {
  if (getErrorName(err) === "TimeoutError") return true;
  return TIMEOUT_HINT_RE.test(message); // /timeout|timed out|deadline exceeded/i
}
```

And node-level error codes are also checked (line 168):

```typescript
if (["ETIMEDOUT", "ESOCKETTIMEDOUT", "ECONNRESET", "ECONNABORTED"].includes(code)) {
  return "timeout";
}
```

**Finding MQ-16 (POSITIVE)**: Timeout detection is thorough. It covers named TimeoutError, message-based patterns, error codes (ETIMEDOUT, ECONNRESET), and AbortError with timeout cause. This ensures that timeouts at any layer (cloud.ru, proxy, Node.js) are correctly classified and trigger fallback.

### 5.4 Error Message Quality

At each layer:

| Layer       | Error Visibility                                  | Error Quality                           |
| ----------- | ------------------------------------------------- | --------------------------------------- |
| cloud.ru    | HTTP status + JSON body                           | Provider-specific, may be in Russian    |
| Proxy       | Translates to Anthropic format (ASSUMED)          | Unknown fidelity                        |
| Claude Code | stderr with error details                         | Varies by error type                    |
| OpenClaw    | FailoverError with reason/status/message          | Structured, classifiable                |
| User        | Final text message or "All models failed" summary | User-unfriendly for multi-failure cases |

**Finding MQ-17 (LOW)**: When all fallback candidates fail, the error message presented is: `"All models failed (N): provider/model: error | provider/model: error"`. This is technically informative but not user-friendly. For a Telegram/WhatsApp user, seeing raw error chains is confusing.

---

## 6. Observability

### 6.1 Proxy Health Monitoring

ADR-004 defines a health check:

```yaml
healthcheck:
  test: ["CMD", "curl", "-f", "http://localhost:8082/health"]
  interval: 30s
  timeout: 10s
  retries: 3
```

And a programmatic check:

```typescript
async function verifyProxyHealth(proxyUrl: string): Promise<{
  ok: boolean;
  status?: number;
  error?: string;
}>;
```

**Finding MQ-18 (MEDIUM)**: The health check only verifies that the proxy process is alive and responding. It does not verify:

- That the cloud.ru API key is valid
- That cloud.ru is reachable from the proxy
- That model mappings resolve to valid models
- That a sample request succeeds end-to-end

A "deep health check" that sends a minimal completion request through the full chain would catch configuration errors that the basic `/health` endpoint misses.

### 6.2 Request Tracing

**Finding MQ-19 (HIGH)**: There is no distributed tracing across the 4 layers. A request entering OpenClaw has a `runId` (from `cli-runner.ts`), but this ID is not propagated:

- Not passed as a header to Claude Code
- Not passed from Claude Code to the proxy
- Not passed from the proxy to cloud.ru

If a request fails, correlating the OpenClaw error log with the proxy Docker log and the cloud.ru request log requires timestamp-based guessing. For debugging production issues, this is a significant observability gap.

### 6.3 Latency Metrics Per Layer

`cli-runner.ts:54` captures start time and `cli-runner.ts:293` computes `durationMs`:

```typescript
const started = Date.now();
// ...
meta: {
  durationMs: Date.now() - started;
}
```

This captures the total wall-clock time from OpenClaw's perspective (subprocess spawn to output parsed). However, there is no breakdown:

- Subprocess spawn overhead (Layer 1-2 boundary)
- Claude Code internal processing time
- Proxy translation time (Layer 2-3 boundary)
- cloud.ru API response time (Layer 3-4 boundary)

**Finding MQ-20 (MEDIUM)**: Without per-layer latency, performance debugging is impossible. If response time degrades, the operator cannot determine whether the bottleneck is subprocess spawn, proxy translation, or cloud.ru itself. The `usage` object returned by `parseCliJson` includes token counts but not timing information.

### 6.4 Error Rate Tracking

**Finding MQ-21 (MEDIUM)**: OpenClaw logs errors via `createSubsystemLogger("agent/claude-cli")`, and the fallback system records `FallbackAttempt` arrays. However, there is no aggregate error rate metric (e.g., "5% of requests to GLM-4.7 failed in the last hour"). Error tracking is per-request, not time-series.

---

## 7. Configuration Management

### 7.1 Docker Compose Environment Variables

From ADR-001's docker-compose:

```yaml
environment:
  OPENAI_API_KEY: "${CLOUDRU_API_KEY}"
  OPENAI_BASE_URL: "https://foundation-models.api.cloud.ru/v1"
  BIG_MODEL: "zai-org/GLM-4.7"
  MIDDLE_MODEL: "Qwen/Qwen3-Coder-480B-A35B-Instruct"
  SMALL_MODEL: "zai-org/GLM-4.7-Flash"
  HOST: "0.0.0.0"
  PORT: "8082"
```

**Finding MQ-22 (MEDIUM)**: Model mapping is hardcoded in Docker environment variables. Changing model assignments requires restarting the Docker container (`docker compose restart`). There is no hot-reload capability. ADR-005 acknowledges this: "Model mapping hardcoded in proxy env -- requires restart to change."

### 7.2 OpenClaw cliBackends.env Override

From ADR-001:

```json
{
  "agents": {
    "defaults": {
      "cliBackends": {
        "claude-cli": {
          "env": {
            "ANTHROPIC_BASE_URL": "http://localhost:8082",
            "ANTHROPIC_API_KEY": "cloudru-proxy-key"
          }
        }
      }
    }
  }
}
```

This is merged by `mergeBackendConfig()` in `cli-backends.ts:95-110`:

```typescript
env: { ...base.env, ...override.env }
```

**Finding MQ-23 (POSITIVE)**: The configuration layering is clean. Base backend config provides defaults, user config overrides only what is needed. The `clearEnv` mechanism prevents key leakage. The `ANTHROPIC_API_KEY` value (`"cloudru-proxy-key"`) is a dummy value since the proxy uses its own cloud.ru key internally.

### 7.3 Health Check Configuration

ADR-004's health check parameters:

| Parameter    | Value   | Assessment                                   |
| ------------ | ------- | -------------------------------------------- |
| Interval     | 30s     | Too slow for real-time monitoring            |
| Timeout      | 10s     | Reasonable for a health endpoint             |
| Retries      | 3       | 3 failures = ~90s before marked unhealthy    |
| Start period | Not set | Container may receive traffic before healthy |

**Finding MQ-24 (LOW)**: The `start_period` is not configured in the Docker healthcheck. During container startup, Docker may report the container as healthy before the proxy is ready. Adding `start_period: 10s` would prevent premature traffic routing.

---

## 8. Resilience Patterns

### 8.1 Docker Restart Policy

```yaml
restart: unless-stopped
```

**Finding MQ-25 (POSITIVE)**: `unless-stopped` is the correct policy. It survives crashes and host reboots but respects explicit `docker stop` commands. It does not restart infinitely in a crash loop (Docker applies exponential backoff: 100ms, 200ms, 400ms, ... up to 1 minute).

### 8.2 Health Check Intervals

The 30s interval combined with 3 retries means up to 90 seconds of unhealthy operation before Docker takes action. For a proxy that handles all LLM traffic, this is a long window.

**Finding MQ-26 (LOW)**: Consider reducing interval to 10s and retries to 2 for faster failure detection (20s worst case). The tradeoff is slightly more CPU from health check curl commands, which is negligible.

### 8.3 Fallback Chain Execution

The fallback in `runWithModelFallback()` is synchronous and sequential:

```typescript
for (let i = 0; i < candidates.length; i += 1) {
  try {
    const result = await params.run(candidate.provider, candidate.model);
    return { result, provider, model, attempts };
  } catch (err) {
    // classify and continue
  }
}
```

**Finding MQ-27 (POSITIVE)**: The fallback is correctly sequential (not parallel), which prevents wasting quota on cloud.ru. Each attempt is fully resolved before the next begins. Auth profile cooldowns are checked before attempting (`isProfileInCooldown`), which skips providers known to be rate-limited.

### 8.4 Request Retry Logic

**Finding MQ-28 (MEDIUM)**: There is no retry-with-backoff at the proxy layer. If a cloud.ru request fails with a transient 503, the entire request fails and is handled by the OpenClaw fallback chain. This means a transient cloud.ru error triggers a model switch rather than a retry of the same model. For transient errors, a 1-retry with 1s delay at the proxy or Claude Code layer would be more appropriate than switching to a different model.

---

## 9. Security Assessment

### 9.1 Network Binding

```yaml
ports:
  - "127.0.0.1:8082:8082"
```

**Finding MQ-29 (POSITIVE)**: The proxy is bound to localhost only. External network access is impossible unless the host is compromised. This is the correct security posture for a local protocol translator.

### 9.2 API Key Handling

- `CLOUDRU_API_KEY` is stored in `.env` file (gitignored per ADR-004)
- `ANTHROPIC_API_KEY` is cleared from the subprocess environment (`clearEnv`)
- The proxy receives the cloud.ru key via Docker environment variable
- The value `"cloudru-proxy-key"` in OpenClaw config is a dummy passthrough

**Finding MQ-30 (POSITIVE)**: API key isolation is correctly implemented. The cloud.ru key never appears in OpenClaw config or source code. The `clearEnv` mechanism prevents the real Anthropic key from reaching the proxy. The proxy handles the actual cloud.ru authentication internally.

### 9.3 Subprocess Security

Claude Code is invoked with `--dangerously-skip-permissions` (from `cli-backends.ts:32`). This bypasses Claude Code's permission system.

**Finding MQ-31 (MEDIUM)**: While tools are disabled via system prompt injection, the `--dangerously-skip-permissions` flag means that if a model response is interpreted as a tool call, Claude Code would execute it without permission checks. Combined with Finding MQ-02 (soft tool disablement), this creates a defense-in-depth gap. The mitigating factor is that Claude Code uses `--output-format json` which likely suppresses tool execution in pipe mode.

---

## 10. Summary of Findings

### Critical (0)

No critical findings. The architecture is fundamentally sound for its stated purpose.

### High (3)

| ID    | Finding                                                                                                     | Recommendation                                                                                                               |
| ----- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| MQ-02 | Tool call translation is undocumented and relies on soft system prompt disablement                          | Document proxy behavior for tool_use blocks. Add API-level tool disablement if Claude Code supports it.                      |
| MQ-11 | Fallback chain operates at Claude tier level but ADR describes cloud.ru model level; alignment not verified | Create explicit mapping table: fallback candidate -> Claude model name -> proxy mapping -> cloud.ru model. Verify each path. |
| MQ-19 | No distributed tracing across the 4 layers                                                                  | Add `X-Request-ID` header propagation. Log request IDs at proxy layer. Correlate with OpenClaw runId.                        |

### Medium (12)

| ID    | Finding                                                                   | Recommendation                                                                                     |
| ----- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| MQ-01 | Content block array format translation undocumented                       | Document Anthropic content block to OpenAI content format mapping in proxy docs.                   |
| MQ-05 | Error format translation from cloud.ru to Anthropic format not documented | Verify proxy error translation with test cases for 400, 401, 429, 500 responses.                   |
| MQ-08 | Session staleness can cause missing system prompt                         | Add session health check or re-inject system prompt periodically.                                  |
| MQ-10 | Proxy model name matching is assumed but not verified                     | Test proxy with exact model strings sent by Claude Code. Document accepted values.                 |
| MQ-13 | serialize:true creates global single-request bottleneck                   | Consider per-session serialization or configurable concurrency limit for multi-user deployments.   |
| MQ-14 | cloud.ru error messages may not match failover regex patterns             | Add cloud.ru-specific error patterns to `classifyFailoverReason()`.                                |
| MQ-15 | Proxy crash-restart race condition with retry timing                      | Add pre-flight proxy health check in `runCliAgent()` before subprocess spawn.                      |
| MQ-18 | Health check does not verify end-to-end connectivity                      | Add deep health check that sends a minimal completion through the full chain.                      |
| MQ-20 | No per-layer latency breakdown                                            | Add timing markers for subprocess spawn, and parse proxy response headers for upstream timing.     |
| MQ-21 | No aggregate error rate tracking                                          | Add counters for success/failure per model per time window.                                        |
| MQ-22 | Model mapping requires container restart to change                        | Document the restart requirement. Consider future support for dynamic model mapping via proxy API. |
| MQ-28 | No retry-with-backoff for transient cloud.ru errors                       | Add single-retry with 1s delay for 503/timeout at proxy or CLI level.                              |
| MQ-31 | --dangerously-skip-permissions combined with soft tool disablement        | Investigate Claude Code pipe-mode tool execution behavior. Add explicit documentation.             |

### Low (4)

| ID    | Finding                                                          | Recommendation                                                                           |
| ----- | ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| MQ-04 | No streaming to user; batch response only                        | Document expected latency for various response sizes. Consider future streaming support. |
| MQ-09 | Response parsing graceful degradation may produce garbled output | Add integration test for non-standard proxy response formats.                            |
| MQ-17 | Multi-failure error messages are user-unfriendly                 | Add user-facing error message template that hides technical details.                     |
| MQ-24 | Docker healthcheck missing start_period                          | Add `start_period: 10s` to docker-compose healthcheck.                                   |
| MQ-26 | Health check interval (30s) is slow for a critical proxy         | Reduce to 10s interval, 2 retries.                                                       |

### Positive (6)

| ID    | Finding                                                                           |
| ----- | --------------------------------------------------------------------------------- |
| MQ-06 | clearEnv mechanism prevents API key leakage between backends                      |
| MQ-07 | Session state is correctly decoupled from stateless proxy                         |
| MQ-12 | Seen-set in fallback prevents circular fallback chains                            |
| MQ-16 | Timeout detection is comprehensive across all error types                         |
| MQ-23 | Configuration layering (base + override + clearEnv) is clean and correct          |
| MQ-25 | Docker restart policy is appropriate (unless-stopped with backoff)                |
| MQ-27 | Sequential fallback prevents quota waste; cooldown check skips exhausted profiles |
| MQ-29 | Proxy bound to localhost only; correct security posture                           |
| MQ-30 | API key isolation is correctly implemented across all layers                      |

---

## 11. Middleware Quality Score

| Criterion                    | Weight   | Score (1-5) | Weighted       |
| ---------------------------- | -------- | ----------- | -------------- |
| Protocol Translation Quality | 20%      | 3.0         | 0.60           |
| Request/Response Integrity   | 15%      | 3.5         | 0.53           |
| Routing Quality              | 20%      | 3.0         | 0.60           |
| Error Propagation            | 15%      | 3.5         | 0.53           |
| Observability                | 10%      | 2.0         | 0.20           |
| Configuration Management     | 10%      | 4.0         | 0.40           |
| Resilience Patterns          | 10%      | 3.5         | 0.35           |
| **Total**                    | **100%** |             | **3.21 / 5.0** |

**Overall Assessment**: The middleware architecture is well-designed for a single-user, config-only integration with no code changes to upstream components. The key strengths are the clean configuration layering, robust fallback mechanism, and proper security isolation. The primary gaps are in observability (no distributed tracing, no per-layer metrics), the unverified proxy translation behavior (treated as a black box), and the global serialization constraint that limits multi-user throughput. For the stated goal of an ideation-phase architecture, the score of 3.21/5.0 is acceptable with the high-priority findings addressed before production.
