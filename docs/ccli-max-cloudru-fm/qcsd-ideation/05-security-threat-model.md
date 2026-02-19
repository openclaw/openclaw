# QCSD Ideation: Security Threat Model (STRIDE Analysis)

## Document Metadata

| Field                        | Value                                                  |
| ---------------------------- | ------------------------------------------------------ |
| **Document ID**              | QCSD-05                                                |
| **Date**                     | 2026-02-12                                             |
| **Scope**                    | OpenClaw + Claude Code + cloud.ru FM proxy integration |
| **ADRs Analyzed**            | ADR-001 through ADR-005                                |
| **Source Code Analyzed**     | `cli-runner.ts`, `cli-backends.ts`                     |
| **Framework**                | STRIDE (Microsoft Threat Modeling)                     |
| **Total Threats Identified** | 24                                                     |
| **Critical**                 | 5                                                      |
| **High**                     | 9                                                      |
| **Medium**                   | 7                                                      |
| **Low**                      | 3                                                      |

---

## System Boundary Diagram

```
                          TRUST BOUNDARY 1 (Host OS)
 +----------------------------------------------------------------------+
 |                                                                      |
 |  OpenClaw Process                                                    |
 |  +-------------------------------+                                   |
 |  | agent-runner.ts               |                                   |
 |  | cli-runner.ts (runCliAgent)   |--- spawns subprocess ----------+  |
 |  | cli-backends.ts (config)      |                                |  |
 |  +-------------------------------+                                |  |
 |         |                                                         |  |
 |         | reads openclaw.json                                     |  |
 |         | reads .env (CLOUDRU_API_KEY)                             |  |
 |                                                                   |  |
 |  Claude Code Subprocess    <--------------------------------------+  |
 |  +-------------------------------+                                   |
 |  | ANTHROPIC_BASE_URL=localhost   |                                  |
 |  | ANTHROPIC_API_KEY=proxy-key    |                                  |
 |  | --dangerously-skip-permissions |                                  |
 |  +-------------------------------+                                   |
 |         |                                                            |
 |         | HTTP to 127.0.0.1:8082                                     |
 |                                                                      |
 |         TRUST BOUNDARY 2 (Docker)                                    |
 |  +-------------------------------+                                   |
 |  | claude-code-proxy container    |                                  |
 |  | legard/claude-code-proxy:latest|                                  |
 |  | OPENAI_API_KEY=${CLOUDRU_KEY}  |                                  |
 |  | Port 8082 (127.0.0.1 bind)    |                                  |
 |  +-------------------------------+                                   |
 |         |                                                            |
 +---------|------------------------------------------------------------+
           | HTTPS to cloud.ru
           |
           TRUST BOUNDARY 3 (Network)
  +--------|-----------------------------+
  | cloud.ru FM API                      |
  | foundation-models.api.cloud.ru/v1/   |
  +--------------------------------------+
```

---

## S -- Spoofing

### S-01: Rogue Process Port Hijacking

| Field                  | Value                                                                                                                                                                                                                                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | S-01                                                                                                                                                                                                                                                                                                      |
| **Category**           | Spoofing                                                                                                                                                                                                                                                                                                  |
| **Severity**           | Critical                                                                                                                                                                                                                                                                                                  |
| **Affected Component** | Proxy / Claude Code subprocess                                                                                                                                                                                                                                                                            |
| **Attack Vector**      | A malicious process on the host binds to port 8082 before the legitimate proxy container starts. Claude Code sends all requests -- including the `ANTHROPIC_API_KEY` header and user prompts -- to the rogue listener. The attacker captures credentials and conversation content in plaintext over HTTP. |

**Existing Mitigation in ADRs:**

- ADR-001 specifies `127.0.0.1:8082` binding (localhost only).
- ADR-004 defines a health check endpoint (`/health`).

**Gaps:**

- No port ownership verification. The health check only confirms something responds on 8082 -- not that it is the legitimate proxy.
- No mutual authentication between Claude Code and the proxy.
- No TLS on the localhost connection (plaintext HTTP).

**Recommended Additional Controls:**

1. Implement a shared secret or nonce exchange on proxy startup. The wizard should generate a random `PROXY_AUTH_TOKEN` stored in `.env` and validated by both OpenClaw and the proxy on each request.
2. Verify the Docker container ID that owns port 8082 before sending requests (`docker port` or `/proc/net/tcp` inspection).
3. Consider localhost TLS with a self-signed certificate pinned at deploy time.

---

### S-02: API Key Spoofing via Environment Manipulation

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | S-02                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Category**           | Spoofing                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Affected Component** | CLI backend configuration                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Attack Vector**      | An attacker with write access to `openclaw.json` modifies `agents.defaults.cliBackends.claude-cli.env` to point `ANTHROPIC_BASE_URL` to an attacker-controlled server. The `mergeBackendConfig()` function in `cli-backends.ts:95-110` blindly merges user-provided `env` values with no URL validation. The static key `"cloudru-proxy-key"` (ADR-001) provides no authentication value since the proxy accepts any key. |

**Existing Mitigation in ADRs:**

- ADR-003 mentions `clearEnv` removes `ANTHROPIC_API_KEY` before applying user config.

**Gaps:**

- No validation that `ANTHROPIC_BASE_URL` points to `127.0.0.1` or `localhost`.
- The `mergeBackendConfig()` function performs no schema or URL validation on env overrides.
- `ANTHROPIC_API_KEY` is set to the static string `"cloudru-proxy-key"` (ADR-001), which is effectively a null authentication credential.

**Recommended Additional Controls:**

1. Add URL allowlist validation in `mergeBackendConfig()` -- only permit `http://127.0.0.1:*` and `http://localhost:*` for `ANTHROPIC_BASE_URL`.
2. Generate a per-installation random proxy key instead of using a static placeholder.
3. Log a warning when `ANTHROPIC_BASE_URL` is overridden to any non-localhost address.

---

### S-03: Upstream Docker Image Substitution

| Field                  | Value                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | S-03                                                                                                                                                                                                                                                                                                                 |
| **Category**           | Spoofing                                                                                                                                                                                                                                                                                                             |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                 |
| **Affected Component** | Proxy Docker image                                                                                                                                                                                                                                                                                                   |
| **Attack Vector**      | The proxy image `legard/claude-code-proxy:latest` is pulled from Docker Hub. An attacker who compromises the Docker Hub account or performs a supply chain attack can push a malicious image. Since the tag is `:latest` (mutable), users pulling the image get the compromised version without any integrity check. |

**Existing Mitigation in ADRs:**

- None. ADR-001 and ADR-004 reference `legard/claude-code-proxy:latest` without pinning.

**Gaps:**

- No image digest pinning (SHA256).
- No signature verification (Docker Content Trust / cosign).
- `:latest` tag is mutable and provides no reproducibility guarantee.

**Recommended Additional Controls:**

1. Pin the Docker image to a specific digest: `legard/claude-code-proxy@sha256:<hash>`.
2. Enable Docker Content Trust (`DOCKER_CONTENT_TRUST=1`) in the deployment instructions.
3. Document a verification step in the wizard that checks the image digest against a known-good list.
4. Consider building the proxy from source with a pinned commit hash as an alternative.

---

### S-04: Cloud.ru API Endpoint Spoofing (DNS/MITM)

| Field                  | Value                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | S-04                                                                                                                                                                                                     |
| **Category**           | Spoofing                                                                                                                                                                                                 |
| **Severity**           | Medium                                                                                                                                                                                                   |
| **Affected Component** | Proxy outbound connection                                                                                                                                                                                |
| **Attack Vector**      | DNS poisoning or a man-in-the-middle attack redirects `foundation-models.api.cloud.ru` to an attacker-controlled endpoint. The proxy sends the `OPENAI_API_KEY` (cloud.ru bearer token) to the attacker. |

**Existing Mitigation in ADRs:**

- ADR-001 specifies HTTPS for the cloud.ru endpoint.

**Gaps:**

- No certificate pinning for the cloud.ru domain.
- No DNS-over-HTTPS enforcement.
- The proxy image's TLS configuration is unspecified (certificate store, minimum TLS version).

**Recommended Additional Controls:**

1. Document the expected TLS certificate chain for `foundation-models.api.cloud.ru`.
2. Verify the proxy container uses a current CA bundle and enforces TLS 1.2+.
3. Consider certificate pinning in environments where the threat model warrants it.

---

## T -- Tampering

### T-01: Proxy Response Injection

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | T-01                                                                                                                                                                                                                                                                                                                                                                         |
| **Category**           | Tampering                                                                                                                                                                                                                                                                                                                                                                    |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                         |
| **Affected Component** | Proxy / Claude Code subprocess                                                                                                                                                                                                                                                                                                                                               |
| **Attack Vector**      | Since the connection between Claude Code and the proxy is plaintext HTTP over localhost, any process with network sniffing capability (or a compromised proxy) can modify API responses in transit. Tampered responses could inject malicious instructions into Claude Code's reasoning pipeline, alter model outputs delivered to users, or inject false tool-call results. |

**Existing Mitigation in ADRs:**

- ADR-003 states tools are disabled (`"Tools are disabled in this session"`), reducing the impact of injected tool-call responses.
- ADR-005 mentions proxy validates response format for tool call simulation.

**Gaps:**

- No integrity verification on proxy responses (no HMAC, no signing).
- No response schema validation in `parseCliJson()` or `parseCliJsonl()` beyond basic JSON parsing.
- Claude Code trusts the proxy response completely.

**Recommended Additional Controls:**

1. Implement response schema validation in the OpenClaw JSON parser (`parseCliJson` in `cli-runner.ts`) to reject malformed or unexpected response structures.
2. Add a content hash or HMAC to proxy responses, verified by the client.
3. Consider localhost TLS to prevent local network-level tampering.

---

### T-02: Model Mapping Tampering via Environment Variables

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | T-02                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Category**           | Tampering                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Affected Component** | Proxy configuration / docker-compose                                                                                                                                                                                                                                                                                                                                                                                      |
| **Attack Vector**      | An attacker with access to the `docker-compose.cloudru-proxy.yml` or the `.env` file modifies `BIG_MODEL`, `MIDDLE_MODEL`, or `SMALL_MODEL` to point to an attacker-controlled model or a weaker model. Since model mapping changes require only a container restart (ADR-005), and the Docker `restart: unless-stopped` policy auto-restarts, the attacker can introduce the change and wait for the next restart cycle. |

**Existing Mitigation in ADRs:**

- ADR-004 specifies docker-compose file is NOT committed to git.
- ADR-004 specifies `.env` must be in `.gitignore`.

**Gaps:**

- No file integrity monitoring on `docker-compose.cloudru-proxy.yml` or `.env`.
- No checksum validation of environment variables at proxy startup.
- Model mapping changes are silent -- no audit log when models are remapped.

**Recommended Additional Controls:**

1. Add file permission hardening: `chmod 600` on `.env` and docker-compose files.
2. Implement a startup log entry in the proxy that records the active model mapping.
3. Add a model-mapping hash to the health check response so OpenClaw can detect drift.
4. Consider read-only Docker volumes for the configuration.

---

### T-03: Configuration File Injection via openclaw.json

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | T-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Category**           | Tampering                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Affected Component** | CLI backend configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Attack Vector**      | The `resolveCliBackendConfig()` function in `cli-backends.ts:124-157` reads backend overrides from `openclaw.json` without schema validation. An attacker who can write to `openclaw.json` can inject arbitrary `command`, `args`, or `env` values into the backend config. For example, changing `command` from `"claude"` to a malicious binary, or injecting `args` that exfiltrate data. The `mergeBackendConfig()` function at line 95 blindly spreads override properties. |

**Existing Mitigation in ADRs:**

- ADR-003 mentions `clearEnv` removes sensitive keys before applying overrides.

**Gaps:**

- No schema validation on backend overrides in `openclaw.json`.
- The `command` field accepts any executable path with no allowlist.
- No integrity check on `openclaw.json` itself.
- `args` can contain arbitrary flags including `--dangerously-skip-permissions` (already present in defaults at `cli-backends.ts:32`).

**Recommended Additional Controls:**

1. Validate the `command` field against an allowlist of known CLI executables (`claude`, `codex`).
2. Implement JSON schema validation for `cliBackends` configuration.
3. Add a config checksum that is verified at runtime.
4. Log all configuration overrides at startup with a WARNING level.

---

### T-04: System Prompt Injection via User Message

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Threat ID**          | T-04                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Category**           | Tampering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Affected Component** | CLI runner / Claude Code subprocess                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Attack Vector**      | The user prompt is passed directly to Claude Code as a command-line argument in `cli-runner.ts:166-175`. A crafted user message containing prompt injection patterns (e.g., `"Ignore previous instructions and..."`) could override the system prompt injected via `--append-system-prompt`. While tools are disabled, the attacker could manipulate the model's reasoning to produce misleading outputs or exfiltrate context from the system prompt (which contains OpenClaw configuration details). |

**Existing Mitigation in ADRs:**

- ADR-003 disables tools (`"Tools are disabled in this session"`).
- ADR-005 mentions anti-refusal in system prompt.

**Gaps:**

- No input sanitization on user prompts before passing to CLI.
- No prompt injection detection layer.
- System prompt content (including config details) could be exfiltrated via model output.

**Recommended Additional Controls:**

1. Implement a prompt injection detection layer before passing user input to `runCliAgent()`.
2. Minimize sensitive information in the system prompt.
3. Add output filtering to detect and redact system prompt content appearing in responses.

---

## R -- Repudiation

### R-01: Unaudited Proxy Request Forwarding

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | R-01                                                                                                                                                                                                                                                                                                                                                                               |
| **Category**           | Repudiation                                                                                                                                                                                                                                                                                                                                                                        |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                               |
| **Affected Component** | Proxy container                                                                                                                                                                                                                                                                                                                                                                    |
| **Attack Vector**      | The claude-code-proxy container forwards requests from Claude Code to cloud.ru FM without maintaining an audit log. There is no record of which user message triggered which API call, what model was used, or what response was returned. If a malicious or unauthorized API call is made through the proxy, there is no way to trace it back to the originating user or session. |

**Existing Mitigation in ADRs:**

- ADR-001 mentions Docker health checks (but not request logging).
- `cli-runner.ts:182-183` logs provider, model, and prompt character count.

**Gaps:**

- The proxy itself has no request/response logging mechanism described in any ADR.
- No correlation ID between OpenClaw session and proxy request.
- No structured audit log for API calls to cloud.ru.

**Recommended Additional Controls:**

1. Configure the proxy to log all requests with: timestamp, request hash, model, token count, response status, and latency.
2. Pass a correlation ID (e.g., `X-Request-ID` header) from OpenClaw through the proxy to cloud.ru for end-to-end traceability.
3. Persist proxy logs to a volume mount with log rotation.
4. Implement structured JSON logging for machine-parseable audit trails.

---

### R-02: Missing Configuration Change Audit Trail

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | R-02                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Category**           | Repudiation                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Affected Component** | Wizard / Configuration files                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Attack Vector**      | The wizard modifies `openclaw.json`, `.env`, and `docker-compose.cloudru-proxy.yml` without recording who made changes, when, or what the previous values were. ADR-002 describes domain events (`CloudruFmProviderConfigured`, `ClaudeCliBackendConfigured`) but these are proposed domain events -- there is no implementation of an event store or audit log. A malicious configuration change cannot be attributed or rolled back. |

**Existing Mitigation in ADRs:**

- ADR-002 proposes domain events but does not mandate persistence.
- Configuration files are excluded from git (`.gitignore`).

**Gaps:**

- No configuration change log or event store implementation.
- No before/after diff capture on config changes.
- `.env` and docker-compose files are excluded from version control by design, so git history cannot provide an audit trail.

**Recommended Additional Controls:**

1. Implement a local audit log that records all configuration changes with timestamps and before/after values (excluding secrets).
2. Persist domain events (`CloudruFmProviderConfigured`, etc.) to a local event store file.
3. Add a `config-history` command that shows recent configuration changes.

---

### R-03: Session Attribution Gap

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Threat ID**          | R-03                                                                                                                                                                                                                                                                                                                                                                                 |
| **Category**           | Repudiation                                                                                                                                                                                                                                                                                                                                                                          |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                               |
| **Affected Component** | CLI runner / Session management                                                                                                                                                                                                                                                                                                                                                      |
| **Attack Vector**      | The `resolveSessionIdToSend()` function maps OpenClaw sessions to Claude Code sessions, but the session ID is redacted in logs (`redactRunIdentifier` at `cli-runner.ts:62-63`). While redaction protects privacy, it also means that if a user disputes that they sent a particular message, the log trail cannot definitively prove which user was responsible for which API call. |

**Existing Mitigation in ADRs:**

- ADR-003 defines session identity as an aggregate invariant.
- `cli-runner.ts:62-63` redacts session IDs in logs.

**Gaps:**

- Redacted session IDs cannot be correlated back to users without additional lookup.
- No separate secure audit log with un-redacted identifiers (access-controlled).
- No request signing or user authentication token per API call.

**Recommended Additional Controls:**

1. Maintain a separate, access-controlled audit log with un-redacted session-to-user mappings.
2. Implement HMAC-based request signing so each API call is cryptographically tied to a session.
3. Store a hash of the session ID (not the redacted form) in audit logs for deterministic lookup without exposing the raw value.

---

### R-04: Cloud.ru API Call Non-Repudiation

| Field                  | Value                                                                                                                                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | R-04                                                                                                                                                                                                                                                     |
| **Category**           | Repudiation                                                                                                                                                                                                                                              |
| **Severity**           | Low                                                                                                                                                                                                                                                      |
| **Affected Component** | Proxy outbound connection                                                                                                                                                                                                                                |
| **Attack Vector**      | All API calls to cloud.ru use a single shared API key (`CLOUDRU_API_KEY`). If the key is compromised and used from another location, the organization cannot distinguish legitimate usage from unauthorized usage based on cloud.ru's access logs alone. |

**Existing Mitigation in ADRs:**

- ADR-004 specifies API key stored in `.env`.

**Gaps:**

- Single shared API key with no per-user or per-session scoping.
- No IP allowlisting on the cloud.ru side documented.
- No usage monitoring or anomaly detection for the cloud.ru API key.

**Recommended Additional Controls:**

1. Configure IP allowlisting on the cloud.ru API key if supported.
2. Implement local usage tracking that records token consumption per session.
3. Set up alerts for unusual API usage patterns (spike in requests, unexpected models).

---

## I -- Information Disclosure

### I-01: API Key Exposure in Docker Inspect

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | I-01                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Category**           | Information Disclosure                                                                                                                                                                                                                                                                                                                                                                                              |
| **Severity**           | Critical                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Affected Component** | Proxy Docker container                                                                                                                                                                                                                                                                                                                                                                                              |
| **Attack Vector**      | The `docker-compose.yml` in ADR-001 passes `OPENAI_API_KEY: "${CLOUDRU_API_KEY}"` as an environment variable to the container. Any user with Docker socket access can run `docker inspect <container>` and see the API key in plaintext in the environment section. On shared hosts or CI environments, this exposes the key to all Docker users. Additionally, `docker exec env` prints all environment variables. |

**Existing Mitigation in ADRs:**

- ADR-004 states API key stored in `.env`, not in `openclaw.json`.
- ADR-001 binds to localhost only.

**Gaps:**

- Docker environment variables are visible to anyone with Docker socket access.
- No use of Docker secrets, vault integration, or encrypted environment.
- `docker-compose.yml` template directly references the key variable.
- Process listing (`/proc/<pid>/environ`) on the host can reveal the key.

**Recommended Additional Controls:**

1. Use Docker secrets instead of environment variables for the API key.
2. If Docker secrets are unavailable, use Docker Compose `secrets` with file-based injection.
3. Restrict Docker socket access to the minimum required users.
4. Document that `/proc/<pid>/environ` is a risk and recommend `hidepid=2` mount option.
5. Consider a secrets manager (HashiCorp Vault, SOPS) for production deployments.

---

### I-02: API Key Exposure in Process Arguments

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | I-02                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Category**           | Information Disclosure                                                                                                                                                                                                                                                                                                                                                                                               |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Affected Component** | CLI runner subprocess                                                                                                                                                                                                                                                                                                                                                                                                |
| **Attack Vector**      | While `cli-runner.ts:222-228` passes `ANTHROPIC_API_KEY` via environment variables (not command-line arguments), the proxy key `"cloudru-proxy-key"` is defined in the `openclaw.json` config (ADR-001). More critically, the `CLOUDRU_API_KEY` is present in the process environment of the Docker container and can be read via `/proc/<pid>/environ` by any process running as the same user or root on the host. |

**Existing Mitigation in ADRs:**

- ADR-003 specifies `clearEnv: ["ANTHROPIC_API_KEY"]` to prevent key leakage between backends.
- ADR-001 uses `.env` files for the real API key.

**Gaps:**

- The static proxy key `"cloudru-proxy-key"` in ADR-001 configuration example has no security value.
- Process environment is readable from `/proc` filesystem.
- No secret rotation mechanism.
- Verbose logging mode (`OPENCLAW_CLAUDE_CLI_LOG_OUTPUT`) could log sensitive content.

**Recommended Additional Controls:**

1. Replace the static proxy key with a per-installation generated secret.
2. Implement API key rotation support in the wizard.
3. Ensure verbose logging mode (`cli-runner.ts:185-251`) never logs environment variables or API keys.
4. Add a startup check that warns if `OPENCLAW_CLAUDE_CLI_LOG_OUTPUT` is enabled in production.

---

### I-03: Sensitive Data in Model Responses

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | I-03                                                                                                                                                                                                                                                                                                                                                                                            |
| **Category**           | Information Disclosure                                                                                                                                                                                                                                                                                                                                                                          |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                                          |
| **Affected Component** | Proxy / Model output                                                                                                                                                                                                                                                                                                                                                                            |
| **Attack Vector**      | The cloud.ru FM models process user prompts that may contain sensitive business data, PII, or confidential information. Model responses may echo or reference this data. The proxy does not perform any output filtering, and responses are stored in Claude Code session files on the local filesystem. Session files accumulate conversation history including potentially sensitive content. |

**Existing Mitigation in ADRs:**

- ADR-003 mentions session persistence as a feature (not a risk).

**Gaps:**

- No output sanitization or PII detection on model responses.
- Session files have no encryption at rest.
- No data retention policy for session files.
- No mechanism to purge sensitive data from completed sessions.

**Recommended Additional Controls:**

1. Implement session file encryption at rest.
2. Define and enforce a data retention policy for Claude Code session files.
3. Add a PII detection filter on model outputs before delivery to end users.
4. Provide a `session-purge` command for GDPR/compliance data deletion.

---

### I-04: System Prompt Leakage Through Model Output

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | I-04                                                                                                                                                                                                                                                                                                                                                                             |
| **Category**           | Information Disclosure                                                                                                                                                                                                                                                                                                                                                           |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                           |
| **Affected Component** | CLI runner / Claude Code subprocess                                                                                                                                                                                                                                                                                                                                              |
| **Attack Vector**      | The system prompt built in `cli-runner.ts:110-122` includes workspace paths, configuration details, model display names, agent IDs, and potentially owner phone numbers (`ownerNumbers` parameter). A prompt injection attack (see T-04) could cause the model to output the full system prompt contents, revealing internal architecture details and configuration to the user. |

**Existing Mitigation in ADRs:**

- None specific to system prompt confidentiality.

**Gaps:**

- System prompt contains infrastructure details (workspace paths, agent IDs).
- `ownerNumbers` parameter in `buildSystemPrompt()` could expose admin phone numbers.
- No output filtering to detect system prompt content in responses.

**Recommended Additional Controls:**

1. Minimize infrastructure details in the system prompt -- remove workspace paths and internal IDs.
2. Remove `ownerNumbers` from the system prompt or hash them.
3. Add an output filter that detects and redacts system prompt fragments in model responses.
4. Implement a "system prompt confidentiality" instruction in the prompt itself.

---

## D -- Denial of Service

### D-01: Proxy Rate Limit Exhaustion

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | D-01                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Category**           | Denial of Service                                                                                                                                                                                                                                                                                                                                                                                                                       |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Affected Component** | Proxy / cloud.ru API                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Attack Vector**      | ADR-001 documents a 15 req/s rate limit. The proxy has no built-in rate limiting -- it forwards all requests to cloud.ru. An attacker (or a misbehaving client) sending requests at high frequency will exhaust the cloud.ru rate limit, causing 429 errors for all users. Since `serialize: true` in the default backend (ADR-003, `cli-backends.ts:52`) limits to 1 concurrent request, a single slow request blocks all other users. |

**Existing Mitigation in ADRs:**

- ADR-001 mentions "Request queuing in OpenClaw" as mitigation.
- `serialize: true` in backend config provides implicit serialization.

**Gaps:**

- No per-user rate limiting in the proxy or OpenClaw.
- No request queuing implementation described (only mentioned as mitigation).
- `serialize: true` is a global lock -- one slow request blocks everyone.
- No circuit breaker to stop sending requests after repeated failures.

**Recommended Additional Controls:**

1. Implement per-user rate limiting in OpenClaw before requests reach the proxy.
2. Add a circuit breaker pattern: after N consecutive failures, stop sending requests for a backoff period.
3. Implement request priority queuing so high-priority users are not blocked by low-priority traffic.
4. Add a configurable timeout shorter than the cloud.ru timeout to fail fast.

---

### D-02: Docker Container Resource Exhaustion

| Field                  | Value                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | D-02                                                                                                                                                                                                                                                                                                                              |
| **Category**           | Denial of Service                                                                                                                                                                                                                                                                                                                 |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                            |
| **Affected Component** | Proxy Docker container                                                                                                                                                                                                                                                                                                            |
| **Attack Vector**      | The `docker-compose.yml` in ADR-001 specifies no resource limits (no `mem_limit`, `cpu_limit`, or `pids_limit`). A memory leak in the proxy, a large response payload, or deliberate abuse could cause the container to consume all available host memory or CPU, impacting other services on the host including OpenClaw itself. |

**Existing Mitigation in ADRs:**

- ADR-001 specifies `restart: unless-stopped` for recovery from crashes.
- ADR-004 defines health checks with 30s interval.

**Gaps:**

- No Docker resource limits in the compose template.
- No OOM (Out of Memory) kill score configuration.
- Health check interval of 30s means up to 30s of degraded service before detection.
- No alerting on container restarts.

**Recommended Additional Controls:**

1. Add resource limits to docker-compose: `mem_limit: 512m`, `cpus: 1.0`, `pids_limit: 100`.
2. Reduce health check interval to 10s for faster failure detection.
3. Add a restart counter alert: if the container restarts more than 3 times in 5 minutes, notify the operator.
4. Configure Docker OOM kill priority to protect the host.

---

### D-03: Model Timeout Cascade Failure

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | D-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Category**           | Denial of Service                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Affected Component** | CLI runner / Fallback chain                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **Attack Vector**      | ADR-005 defines a fallback chain: `GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash -> ERROR`. If the primary model is slow (not failing, just slow), the timeout in `runCliAgent()` (`params.timeoutMs`) triggers a FailoverError. The fallback mechanism retries with the next model, but if cloud.ru is experiencing general latency issues, each fallback attempt also times out. Total user wait time becomes `N * timeoutMs` where N is the fallback chain length. With 3 models and a 60s timeout, a user waits up to 3 minutes for a final error. |

**Existing Mitigation in ADRs:**

- ADR-005 mentions OpenClaw's `runAgentTurnWithFallback()` handles retries.
- ADR-001 mentions configurable `REQUEST_TIMEOUT` env.

**Gaps:**

- No total timeout budget across the fallback chain.
- No distinction between "slow" (timeout) and "broken" (5xx) failures in fallback logic.
- No exponential backoff between fallback attempts.
- Fallback changes model mid-conversation (ADR-005 acknowledged negative).

**Recommended Additional Controls:**

1. Implement a total timeout budget for the entire fallback chain (e.g., 90s total regardless of chain length).
2. Differentiate timeout failures from error failures -- skip fallback on timeout if the issue is likely infrastructure-wide.
3. Implement a "fast fail" check: if the proxy health check fails, skip directly to ERROR without trying models.
4. Add a user-facing message explaining that a fallback model is being used.

---

### D-04: Subprocess Accumulation (Fork Bomb)

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | D-04                                                                                                                                                                                                                                                                                                                                                                       |
| **Category**           | Denial of Service                                                                                                                                                                                                                                                                                                                                                          |
| **Severity**           | Medium                                                                                                                                                                                                                                                                                                                                                                     |
| **Affected Component** | CLI runner subprocess management                                                                                                                                                                                                                                                                                                                                           |
| **Attack Vector**      | `cli-runner.ts:231` calls `cleanupSuspendedCliProcesses(backend)` and `cleanupResumeProcesses()` to manage stale subprocesses. However, if cleanup fails or is not triggered (e.g., OpenClaw crashes mid-execution), Claude Code subprocesses may accumulate. Each subprocess consumes memory and a process slot. Repeated rapid requests could exhaust the process table. |

**Existing Mitigation in ADRs:**

- `cli-runner.ts:230-234` implements cleanup functions.
- `serialize: true` limits concurrent subprocesses to 1.

**Gaps:**

- Cleanup only runs when a new request is enqueued -- orphaned processes from crashes are not cleaned up.
- No process count monitoring or alerting.
- No `ulimit` or cgroup restriction on subprocess spawning.

**Recommended Additional Controls:**

1. Add a periodic cleanup job (cron or timer) that kills orphaned Claude Code processes.
2. Implement a process count guard: refuse new requests if more than N Claude Code processes exist.
3. Set `ulimit -u` restrictions for the OpenClaw process.

---

## E -- Elevation of Privilege

### E-01: Docker Container Escape

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | E-01                                                                                                                                                                                                                                                                                                                                                                                                                              |
| **Category**           | Elevation of Privilege                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Severity**           | Critical                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Affected Component** | Proxy Docker container                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Attack Vector**      | ADR-004 states the container runs with the "default Docker security profile." If the proxy image contains a vulnerability (or the attacker exploits a Docker runtime vulnerability), the container could escape to the host. The proxy has access to the cloud.ru API key and network access to `127.0.0.1` -- a container escape grants access to the host filesystem (including `.env`, `openclaw.json`, and all session data). |

**Existing Mitigation in ADRs:**

- ADR-004 mentions "default Docker security profile."

**Gaps:**

- No explicit `--security-opt` configuration (no AppArmor, no seccomp profile).
- No `--read-only` filesystem flag on the container.
- No `--no-new-privileges` flag.
- Container runs as root by default (no `user:` directive in compose).
- No network policy restricting container egress.

**Recommended Additional Controls:**

1. Add `security_opt: ["no-new-privileges:true"]` to docker-compose.
2. Add `read_only: true` to the container filesystem.
3. Run the container as a non-root user: `user: "1000:1000"`.
4. Apply a minimal seccomp profile.
5. Add `cap_drop: ["ALL"]` and only add back required capabilities.
6. Restrict network egress to only `foundation-models.api.cloud.ru`.

---

### E-02: Claude Code Tool Execution Re-enablement

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | E-02                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Category**           | Elevation of Privilege                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| **Severity**           | Critical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| **Affected Component** | CLI runner / Claude Code subprocess                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Attack Vector**      | `cli-runner.ts:82-83` disables tools via system prompt injection: `"Tools are disabled in this session. Do not call tools."` The `--dangerously-skip-permissions` flag (`cli-backends.ts:32`) is also present in the default args. If a future configuration change, prompt injection, or model behavior change causes Claude Code to ignore the "tools disabled" instruction (which is a soft control, not an API-level restriction), Claude Code would execute tools (bash, file I/O, web search) with the permissions of the OpenClaw process. The `--dangerously-skip-permissions` flag means NO permission prompts would be shown. |

**Existing Mitigation in ADRs:**

- ADR-003 explicitly disables tools via system prompt.
- ADR-003 documents this as a known limitation with a future ADR planned.

**Gaps:**

- Tool disablement is a soft control (system prompt text) not a hard control (API parameter or CLI flag).
- `--dangerously-skip-permissions` bypasses all Claude Code permission prompts.
- No sandbox or workspace isolation per user session.
- If tools activate, Claude Code runs with full process permissions.
- There is no `--disable-tools` flag used (only a prompt-level instruction).

**Recommended Additional Controls:**

1. Investigate if Claude Code supports a hard `--no-tools` or `--allowed-tools ""` flag, and use it instead of prompt-based disabling.
2. Remove `--dangerously-skip-permissions` if possible, or at minimum, combine it with explicit tool restrictions.
3. If tools must remain soft-disabled, implement output parsing in `parseCliJson()` to detect and reject responses containing tool-use blocks.
4. Run Claude Code subprocesses in a restricted sandbox (nsjail, firejail, or a dedicated container).
5. Implement per-session workspace isolation (chroot or namespace).

---

### E-03: System Prompt Injection Leading to Capability Escalation

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Threat ID**          | E-03                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Category**           | Elevation of Privilege                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Severity**           | High                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| **Affected Component** | CLI runner / Claude Code subprocess                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Attack Vector**      | A user crafts a message that manipulates the model into behaving as if it has elevated capabilities. Since the cloud.ru model (GLM-4.7) is not Anthropic's model, it may have weaker instruction-following on system prompt boundaries. ADR-005 acknowledges "RLHF refusals" and "anti-refusal in system prompt" -- the anti-refusal prompt weakens the model's safety guardrails. Combined with prompt injection, an attacker could get the model to output content that bypasses OpenClaw's content filters or produces responses impersonating system administrators. |

**Existing Mitigation in ADRs:**

- ADR-005 mentions "Anti-refusal in system prompt" (this is a double-edged sword).
- ADR-003 disables tools.

**Gaps:**

- Anti-refusal prompt intentionally weakens safety guardrails.
- GLM-4.7 may have different prompt injection resistance than Anthropic models.
- No output content filtering or safety classification layer.
- No jailbreak detection on user inputs.

**Recommended Additional Controls:**

1. Implement a jailbreak/prompt injection detection layer on user inputs before they reach the CLI runner.
2. Add output safety classification that checks model responses against content policies.
3. Carefully scope the anti-refusal prompt to only prevent task-refusal, not safety-refusal.
4. Conduct adversarial testing of GLM-4.7 with known prompt injection techniques.

---

### E-04: Backend Command Injection via Config

| Field                  | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Threat ID**          | E-04                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Category**           | Elevation of Privilege                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Severity**           | Critical                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Affected Component** | CLI backend configuration / subprocess spawning                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Attack Vector**      | `cli-backends.ts` allows the `command` field to be overridden via `openclaw.json`. The `resolveCliBackendConfig()` function at line 124 returns whatever `command` is configured. `cli-runner.ts:236` passes this directly to `runCommandWithTimeout()` as the executable. An attacker who can modify `openclaw.json` can set `command` to any executable on the system (e.g., `/bin/bash`) with arbitrary `args`, achieving remote code execution with the privileges of the OpenClaw process. |

**Existing Mitigation in ADRs:**

- None. This vector is not addressed in any ADR.

**Gaps:**

- No validation or allowlist for the `command` field.
- `args` array is fully controllable via config override.
- `env` is fully controllable via config override.
- Combined with `--dangerously-skip-permissions`, any spawned process runs without restrictions.

**Recommended Additional Controls:**

1. Implement a strict allowlist for the `command` field: only `claude` and `codex` (and their full paths) should be permitted.
2. Validate `args` against a pattern allowlist -- reject args containing shell metacharacters.
3. Implement config file integrity verification (hash check at startup).
4. Add a security warning when backend configuration overrides are detected.
5. Consider making `command` immutable (not overridable from config).

---

## Threat Summary Matrix

| ID   | Category          | Severity | Component         | Existing Mitigation      | Gap Level |
| ---- | ----------------- | -------- | ----------------- | ------------------------ | --------- |
| S-01 | Spoofing          | Critical | Proxy             | Localhost binding        | High      |
| S-02 | Spoofing          | High     | CLI backend       | clearEnv                 | High      |
| S-03 | Spoofing          | High     | Docker image      | None                     | Critical  |
| S-04 | Spoofing          | Medium   | Proxy outbound    | HTTPS                    | Medium    |
| T-01 | Tampering         | High     | Proxy responses   | Tools disabled           | High      |
| T-02 | Tampering         | Medium   | Proxy config      | .gitignore               | Medium    |
| T-03 | Tampering         | High     | openclaw.json     | clearEnv                 | High      |
| T-04 | Tampering         | Medium   | CLI runner        | Tools disabled           | Medium    |
| R-01 | Repudiation       | High     | Proxy             | CLI logging              | High      |
| R-02 | Repudiation       | Medium   | Wizard/config     | Domain events (proposed) | High      |
| R-03 | Repudiation       | Medium   | Session mgmt      | Session invariant        | Medium    |
| R-04 | Repudiation       | Low      | cloud.ru API      | .env storage             | Medium    |
| I-01 | Info Disclosure   | Critical | Docker container  | .env file                | High      |
| I-02 | Info Disclosure   | High     | CLI runner        | clearEnv                 | Medium    |
| I-03 | Info Disclosure   | Medium   | Model output      | None                     | High      |
| I-04 | Info Disclosure   | Medium   | System prompt     | None                     | High      |
| D-01 | Denial of Service | High     | Proxy/rate limit  | serialize:true           | High      |
| D-02 | Denial of Service | Medium   | Docker resources  | restart policy           | High      |
| D-03 | Denial of Service | High     | Fallback chain    | runAgentTurnWithFallback | Medium    |
| D-04 | Denial of Service | Medium   | Subprocess mgmt   | Cleanup functions        | Medium    |
| E-01 | Elevation         | Critical | Docker container  | Default profile          | Critical  |
| E-02 | Elevation         | Critical | Claude Code tools | Prompt-based disable     | Critical  |
| E-03 | Elevation         | High     | Prompt injection  | Anti-refusal prompt      | High      |
| E-04 | Elevation         | Critical | Backend config    | None                     | Critical  |

---

## Critical Findings Requiring Immediate Action

### Priority 1 -- Must Fix Before Production

| ID   | Finding                                                                                         | Recommended Fix                                                                       |
| ---- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| E-04 | Backend command injection via `openclaw.json` -- arbitrary code execution                       | Allowlist `command` field to `claude`/`codex` only                                    |
| E-02 | Tool disablement is prompt-only, not API-level; `--dangerously-skip-permissions` compounds risk | Use hard `--no-tools` flag if available; add output parsing to reject tool-use blocks |
| E-01 | Docker container runs as root with no security hardening                                        | Add `no-new-privileges`, `read_only`, non-root user, `cap_drop: ALL`                  |
| I-01 | API key visible via `docker inspect`                                                            | Use Docker secrets or file-based injection                                            |
| S-01 | No port ownership verification; rogue process can impersonate proxy                             | Implement shared secret verification on proxy startup                                 |

### Priority 2 -- Should Fix Before GA

| ID   | Finding                                                               | Recommended Fix                                |
| ---- | --------------------------------------------------------------------- | ---------------------------------------------- |
| S-03 | Docker image uses mutable `:latest` tag                               | Pin to SHA256 digest                           |
| T-03 | Config file accepts arbitrary command/args/env overrides              | JSON schema validation with allowlists         |
| R-01 | No audit logging in proxy                                             | Enable structured request/response logging     |
| D-01 | No rate limiting or circuit breaker                                   | Per-user rate limits + circuit breaker pattern |
| E-03 | Anti-refusal prompt weakens safety guardrails for non-Anthropic model | Scope anti-refusal; add jailbreak detection    |

### Priority 3 -- Should Fix Before Scale

| ID   | Finding                                       | Recommended Fix                 |
| ---- | --------------------------------------------- | ------------------------------- |
| D-03 | Fallback chain has no total timeout budget    | Implement aggregate timeout     |
| I-03 | No PII filtering on model responses           | Add output sanitization layer   |
| I-04 | System prompt contains infrastructure details | Minimize prompt content         |
| R-02 | No configuration change audit trail           | Implement local event store     |
| D-02 | No Docker resource limits                     | Add mem_limit, cpus, pids_limit |

---

## Compliance Implications

### SOC2 Gaps

| Control                 | Status  | Gap                                       |
| ----------------------- | ------- | ----------------------------------------- |
| CC6.1 Access Control    | Partial | No authentication on proxy (S-01, S-02)   |
| CC6.6 Security Logging  | Missing | No proxy audit log (R-01)                 |
| CC6.8 Change Management | Missing | No config change audit trail (R-02)       |
| CC7.2 Encryption        | Partial | No encryption at rest for sessions (I-03) |

### GDPR Gaps

| Article                           | Status  | Gap                                |
| --------------------------------- | ------- | ---------------------------------- |
| Art. 17 Right to Erasure          | Missing | No session purge mechanism (I-03)  |
| Art. 25 Data Protection by Design | Partial | No PII filtering on outputs (I-03) |
| Art. 30 Records of Processing     | Missing | No processing activity log (R-01)  |

---

## Methodology Notes

- This analysis follows the Microsoft STRIDE framework applied to the specific architecture described in ADR-001 through ADR-005.
- Source code analysis was performed on `cli-runner.ts` (363 lines) and `cli-backends.ts` (157 lines) from the OpenClaw upstream.
- Severity ratings follow CVSS v3.1 qualitative scale: Critical (9.0-10.0), High (7.0-8.9), Medium (4.0-6.9), Low (0.1-3.9).
- "Gap Level" indicates how much additional work is needed: Critical = no mitigation exists, High = partial mitigation with significant gaps, Medium = mitigation exists but needs strengthening.
