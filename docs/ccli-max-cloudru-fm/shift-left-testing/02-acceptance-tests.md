# Shift-Left Testing: Level 2 -- ADR Acceptance & Integration Tests

## Overview

This document specifies acceptance tests and integration test scenarios for the
5 Architecture Decision Records governing the OpenClaw + cloud.ru FM integration.
Each ADR section contains:

1. **Acceptance criteria** -- what must be true for the ADR to be considered implemented
2. **Test stubs** -- vitest-style TypeScript test code
3. **Edge cases** -- boundary conditions and failure modes

Executable tests live in `/tests/adr-acceptance.test.ts`.

---

## ADR-001: Cloud.ru FM Proxy Integration

### Acceptance Criteria

| #   | Criterion                                                                 | Verification                              |
| --- | ------------------------------------------------------------------------- | ----------------------------------------- |
| 1.1 | `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` injected into subprocess env | Unit test on `mergeBackendConfig()`       |
| 1.2 | `mergeBackendConfig()` merges user-provided `env` over base defaults      | Unit test with cloudru override           |
| 1.3 | Proxy health endpoint returns 200 on `/health`                            | Integration test (requires running proxy) |
| 1.4 | CLAUDE_MODEL_ALIASES maps Anthropic names to tier names correctly         | Unit test on alias map                    |
| 1.5 | Proxy Docker binds to 127.0.0.1 only (not 0.0.0.0 externally)             | Config validation test                    |

### Test Stubs

```typescript
describe("ADR-001: Proxy Integration", () => {
  describe("Proxy env injection", () => {
    it("should merge ANTHROPIC_BASE_URL into claude-cli backend env", () => {
      // Given: openclaw.json with agents.defaults.cliBackends.claude-cli.env
      // When: resolveCliBackendConfig("claude-cli", config) is called
      // Then: result.config.env.ANTHROPIC_BASE_URL === "http://localhost:8082"
    });

    it("should merge ANTHROPIC_API_KEY into claude-cli backend env", () => {
      // Given: user config with env.ANTHROPIC_API_KEY = "cloudru-proxy-key"
      // When: resolveCliBackendConfig merges
      // Then: result.config.env.ANTHROPIC_API_KEY === "cloudru-proxy-key"
    });

    it("should preserve default args when only env is overridden", () => {
      // Given: override with only env set, no args
      // When: mergeBackendConfig(DEFAULT_CLAUDE_BACKEND, override)
      // Then: result.args === DEFAULT_CLAUDE_BACKEND.args
    });
  });

  describe("mergeBackendConfig()", () => {
    it("should deep-merge env from base and override", () => {
      // Given: base.env = { A: "1" }, override.env = { B: "2" }
      // When: mergeBackendConfig(base, override)
      // Then: result.env === { A: "1", B: "2" }
    });

    it("should override env values when keys conflict", () => {
      // Given: base.env = { A: "1" }, override.env = { A: "9" }
      // When: mergeBackendConfig(base, override)
      // Then: result.env.A === "9"
    });

    it("should union clearEnv arrays without duplicates", () => {
      // Given: base.clearEnv = ["X"], override.clearEnv = ["X", "Y"]
      // When: mergeBackendConfig(base, override)
      // Then: result.clearEnv === ["X", "Y"]
    });

    it("should return a shallow copy when override is undefined", () => {
      // Given: override = undefined
      // When: mergeBackendConfig(base, undefined)
      // Then: result !== base (new object) && deepEqual(result, base)
    });
  });

  describe("Proxy health check", () => {
    it("should return ok=true when proxy responds 200", async () => {
      // Given: proxy running on localhost:8082
      // When: GET http://localhost:8082/health
      // Then: response.ok === true, response.status === 200
    });

    it("should return ok=false with error on connection refused", async () => {
      // Given: no proxy running on port 9999
      // When: verifyProxyHealth("http://localhost:9999")
      // Then: result.ok === false, result.error contains "ECONNREFUSED"
    });

    it("should timeout after 5 seconds", async () => {
      // Given: proxy that hangs indefinitely
      // When: verifyProxyHealth with 5s timeout
      // Then: result.ok === false, result.error contains timeout
    });
  });

  describe("Model alias mapping", () => {
    it("should map claude-opus-4-6 to 'opus'", () => {
      // CLAUDE_MODEL_ALIASES["claude-opus-4-6"] === "opus"
    });

    it("should map claude-sonnet-4-5 to 'sonnet'", () => {
      // CLAUDE_MODEL_ALIASES["claude-sonnet-4-5"] === "sonnet"
    });

    it("should map claude-haiku-3-5 to 'haiku'", () => {
      // CLAUDE_MODEL_ALIASES["claude-haiku-3-5"] === "haiku"
    });

    it("should map short aliases (opus, sonnet, haiku) to themselves", () => {
      // CLAUDE_MODEL_ALIASES["opus"] === "opus"
      // CLAUDE_MODEL_ALIASES["sonnet"] === "sonnet"
      // CLAUDE_MODEL_ALIASES["haiku"] === "haiku"
    });
  });

  describe("Localhost-only binding", () => {
    it("should bind docker ports to 127.0.0.1 in compose template", () => {
      // Given: generated docker-compose YAML
      // When: parsing ports section
      // Then: port binding starts with "127.0.0.1:"
    });
  });
});
```

---

## ADR-002: Wizard Cloud.ru FM Auth Choice

### Acceptance Criteria

| #   | Criterion                                                                            | Verification                 |
| --- | ------------------------------------------------------------------------------------ | ---------------------------- |
| 2.1 | `AuthChoice` type includes `cloudru-fm-glm47`, `cloudru-fm-flash`, `cloudru-fm-qwen` | Type-level test              |
| 2.2 | `AUTH_CHOICE_GROUP_DEFS` includes a `cloudru-fm` group entry                         | Unit test on group array     |
| 2.3 | Wizard dispatch routes `cloudru-fm-*` choices to correct handler                     | Unit test on dispatch logic  |
| 2.4 | `applyCloudruFmConfig()` produces correct `openclaw.json` structure                  | Unit test on pure function   |
| 2.5 | Docker compose template generation includes all required env vars                    | Unit test on template output |

### Test Stubs

```typescript
describe("ADR-002: Wizard Auth Choice", () => {
  describe("AuthChoice type extensions", () => {
    it("should accept 'cloudru-fm-glm47' as valid AuthChoice", () => {
      // Given: a variable typed as AuthChoice
      // When: assigned "cloudru-fm-glm47"
      // Then: no TypeScript compile error (compile-time test)
    });

    it("should accept 'cloudru-fm-flash' as valid AuthChoice", () => {});
    it("should accept 'cloudru-fm-qwen' as valid AuthChoice", () => {});
  });

  describe("AUTH_CHOICE_GROUP_DEFS", () => {
    it("should contain a group with value 'cloudru-fm'", () => {
      // Given: AUTH_CHOICE_GROUP_DEFS array
      // When: finding entry where value === "cloudru-fm"
      // Then: entry exists
    });

    it("should have label 'Cloud.ru FM' for cloudru-fm group", () => {
      // Then: entry.label === "Cloud.ru FM"
    });

    it("should include 3 choices in cloudru-fm group", () => {
      // Then: entry.choices.length === 3
      // And: choices includes "cloudru-fm-glm47", "cloudru-fm-flash", "cloudru-fm-qwen"
    });
  });

  describe("Wizard dispatch", () => {
    it("should route cloudru-fm-glm47 to cloudru handler", () => {
      // Given: authChoice = "cloudru-fm-glm47"
      // When: wizard dispatch evaluates choice
      // Then: calls promptCloudruFmConfig or applyCloudruFmConfig
    });

    it("should route cloudru-fm-flash to cloudru handler", () => {});
    it("should route cloudru-fm-qwen to cloudru handler", () => {});
  });

  describe("applyCloudruFmConfig()", () => {
    it("should set models.providers.cloudru-fm with correct baseUrl", () => {
      // Given: apiKey="test-key", choice="cloudru-fm-glm47"
      // When: applyCloudruFmConfig(config, params)
      // Then: config.models.providers["cloudru-fm"].baseUrl ===
      //       "https://foundation-models.api.cloud.ru/v1"
    });

    it("should set cliBackends.claude-cli.env.ANTHROPIC_BASE_URL", () => {
      // Then: config.agents.defaults.cliBackends["claude-cli"].env
      //       .ANTHROPIC_BASE_URL === "http://localhost:8082"
    });

    it("should set agents.defaults.model.primary for chosen model", () => {
      // Given: choice = "cloudru-fm-glm47"
      // Then: config.agents.defaults.model.primary === "cloudru-fm/zai-org/GLM-4.7"
    });

    it("should never store API key in openclaw.json directly", () => {
      // Then: JSON.stringify(config) does not contain the raw API key
    });
  });

  describe("Docker compose template generation", () => {
    it("should include OPENAI_API_KEY placeholder", () => {
      // Given: generateDockerCompose() output
      // Then: output contains "OPENAI_API_KEY"
    });

    it("should include OPENAI_BASE_URL for cloud.ru", () => {
      // Then: output contains "https://foundation-models.api.cloud.ru/v1"
    });

    it("should include BIG_MODEL, MIDDLE_MODEL, SMALL_MODEL envs", () => {
      // Then: output contains all 3 MODEL env keys
    });

    it("should bind to 127.0.0.1:8082", () => {
      // Then: output contains "127.0.0.1:8082:8082"
    });

    it("should include healthcheck with curl", () => {
      // Then: output contains "curl" and "/health"
    });
  });
});
```

---

## ADR-003: Claude Code as Agentic Engine

### Acceptance Criteria

| #   | Criterion                                                               | Verification                            |
| --- | ----------------------------------------------------------------------- | --------------------------------------- |
| 3.1 | `isCliProvider("claude-cli")` returns true                              | Unit test                               |
| 3.2 | `runCliAgent()` spawns subprocess with `claude -p --output-format json` | Unit test on args construction          |
| 3.3 | Session ID mapping is deterministic and consistent                      | Unit test on `resolveSessionIdToSend()` |
| 3.4 | `clearEnv` removes `ANTHROPIC_API_KEY` before applying user env         | Unit test on env construction           |
| 3.5 | "Tools are disabled" message is injected into system prompt             | Unit test on `extraSystemPrompt`        |

### Test Stubs

```typescript
describe("ADR-003: Agentic Engine", () => {
  describe("CLI provider identification", () => {
    it("should identify 'claude-cli' as a CLI provider", () => {
      // Given: provider string = "claude-cli"
      // When: isCliProvider(provider)
      // Then: returns true
    });

    it("should identify 'codex-cli' as a CLI provider", () => {
      // When: isCliProvider("codex-cli") => true
    });

    it("should return false for non-CLI providers", () => {
      // When: isCliProvider("openai") => false
    });
  });

  describe("runCliAgent subprocess spawning", () => {
    it("should construct args with -p --output-format json", () => {
      // Given: DEFAULT_CLAUDE_BACKEND.args
      // Then: args includes "-p", "--output-format", "json"
    });

    it("should include --dangerously-skip-permissions", () => {
      // Then: args includes "--dangerously-skip-permissions"
    });

    it("should pass --model with normalized model name", () => {
      // Given: model = "claude-opus-4-6"
      // When: normalizeCliModel resolves via CLAUDE_MODEL_ALIASES
      // Then: "--model" "opus" appears in constructed args
    });

    it("should pass --session-id on first call", () => {
      // Given: sessionMode = "always", no existing cliSessionId
      // When: buildCliArgs called
      // Then: "--session-id" appears with generated session ID
    });

    it("should use --resume with sessionId on subsequent calls", () => {
      // Given: existing cliSessionId, resumeArgs configured
      // When: buildCliArgs called
      // Then: "--resume" and session ID appear in args
    });
  });

  describe("Session ID consistency", () => {
    it("should return same session ID for same input params", () => {
      // Given: resolveSessionIdToSend with same backend + cliSessionId
      // When: called twice
      // Then: both return same sessionId
    });

    it("should generate new session ID when no cliSessionId provided", () => {
      // Given: cliSessionId = undefined
      // When: resolveSessionIdToSend called
      // Then: isNew === true, sessionId is non-empty string
    });
  });

  describe("Environment isolation", () => {
    it("should remove ANTHROPIC_API_KEY from inherited env", () => {
      // Given: process.env contains ANTHROPIC_API_KEY = "old-key"
      // And: backend.clearEnv = ["ANTHROPIC_API_KEY"]
      // When: env construction runs
      // Then: result env does NOT contain "old-key"
    });

    it("should remove ANTHROPIC_API_KEY_OLD from inherited env", () => {
      // Given: clearEnv includes "ANTHROPIC_API_KEY_OLD"
      // When: env construction
      // Then: ANTHROPIC_API_KEY_OLD is deleted
    });

    it("should apply user env AFTER clearing", () => {
      // Given: clearEnv = ["ANTHROPIC_API_KEY"]
      // And: backend.env = { ANTHROPIC_API_KEY: "new-proxy-key" }
      // When: env built as { ...process.env, ...backend.env } then clear
      // Then: result has ANTHROPIC_API_KEY = "new-proxy-key"
      // NOTE: actual code applies env first, then clears -- verify order
    });
  });

  describe("Tools disabled injection", () => {
    it("should inject 'Tools are disabled' into extraSystemPrompt", () => {
      // Given: runCliAgent called
      // When: extraSystemPrompt is constructed (line 81-86)
      // Then: contains "Tools are disabled in this session. Do not call tools."
    });

    it("should append tools-disabled after user extraSystemPrompt", () => {
      // Given: extraSystemPrompt = "Be helpful."
      // When: joined
      // Then: result === "Be helpful.\nTools are disabled in this session..."
    });

    it("should work when extraSystemPrompt is undefined", () => {
      // Given: extraSystemPrompt = undefined
      // When: filtered and joined
      // Then: result === "Tools are disabled in this session. Do not call tools."
    });
  });
});
```

---

## ADR-004: Proxy Lifecycle Management

### Acceptance Criteria

| #   | Criterion                                                                       | Verification                       |
| --- | ------------------------------------------------------------------------------- | ---------------------------------- |
| 4.1 | Wizard generates `docker-compose.cloudru-proxy.yml` with correct template       | Unit test                          |
| 4.2 | Health check endpoint returns structured result                                 | Unit test on `verifyProxyHealth()` |
| 4.3 | State machine transitions follow: UNDEPLOYED -> DEPLOYING -> RUNNING -> HEALTHY | State test                         |
| 4.4 | Proxy recovers after restart (Docker restart policy)                            | Integration test                   |

### Test Stubs

```typescript
describe("ADR-004: Proxy Lifecycle", () => {
  describe("Docker compose generation", () => {
    it("should generate valid YAML with all template variables", () => {
      // Given: generateDockerCompose({ apiKey, port, models })
      // When: output is parsed as YAML
      // Then: services.claude-code-proxy exists
    });

    it("should use legard/claude-code-proxy:latest image", () => {
      // Then: services.claude-code-proxy.image === "legard/claude-code-proxy:latest"
    });

    it("should set restart: unless-stopped", () => {
      // Then: services.claude-code-proxy.restart === "unless-stopped"
    });

    it("should include healthcheck with 30s interval", () => {
      // Then: healthcheck.interval === "30s"
      // And: healthcheck.test includes "curl" and "/health"
    });

    it("should set PORT env to match exposed port", () => {
      // Given: port = 8082
      // Then: environment.PORT === "8082"
    });

    it("should reference .env file for API key", () => {
      // Then: OPENAI_API_KEY uses ${CLOUDRU_API_KEY} syntax
    });
  });

  describe("verifyProxyHealth()", () => {
    it("should return { ok: true, status: 200 } for healthy proxy", async () => {
      // Given: mock fetch returning 200
      // When: verifyProxyHealth("http://localhost:8082")
      // Then: { ok: true, status: 200 }
    });

    it("should return { ok: false, status: 503 } for degraded proxy", async () => {
      // Given: mock fetch returning 503
      // Then: { ok: false, status: 503 }
    });

    it("should return error message on network failure", async () => {
      // Given: fetch throws ECONNREFUSED
      // Then: { ok: false, error: "fetch failed" or similar }
    });

    it("should enforce 5 second timeout", async () => {
      // Given: fetch hangs for 10 seconds
      // When: verifyProxyHealth with 5000ms timeout
      // Then: returns within ~5s with ok=false
    });
  });

  describe("Proxy state machine", () => {
    it("should start in UNDEPLOYED state", () => {
      // Given: new ProxyLifecycle()
      // Then: state === "UNDEPLOYED"
    });

    it("should transition UNDEPLOYED -> DEPLOYING on deploy()", () => {
      // When: lifecycle.deploy()
      // Then: state === "DEPLOYING"
    });

    it("should transition DEPLOYING -> RUNNING when container starts", () => {
      // When: lifecycle.onContainerStarted()
      // Then: state === "RUNNING"
    });

    it("should transition RUNNING -> HEALTHY on successful health check", () => {
      // When: lifecycle.onHealthCheckPassed()
      // Then: state === "HEALTHY"
    });

    it("should transition HEALTHY -> UNHEALTHY on failed health check", () => {
      // When: lifecycle.onHealthCheckFailed()
      // Then: state === "UNHEALTHY"
    });

    it("should transition UNHEALTHY -> RECOVERING on restart", () => {
      // When: lifecycle.onRestart()
      // Then: state === "RECOVERING"
    });

    it("should transition RECOVERING -> HEALTHY on recovery", () => {
      // When: lifecycle.onHealthCheckPassed()
      // Then: state === "HEALTHY"
    });

    it("should not allow invalid transitions", () => {
      // Given: state === "UNDEPLOYED"
      // When: lifecycle.onHealthCheckPassed()
      // Then: throws InvalidTransitionError
    });
  });

  describe("Proxy restart recovery", () => {
    it("should detect proxy restart via health check polling", async () => {
      // Given: proxy was UNHEALTHY
      // When: Docker restarts container and health returns 200
      // Then: state transitions to HEALTHY
    });

    it("should retry health check up to 3 times before marking STOPPED", () => {
      // Given: 3 consecutive health check failures
      // Then: state === "STOPPED" or remains UNHEALTHY
    });
  });
});
```

---

## ADR-005: Model Mapping and Fallback Strategy

### Acceptance Criteria

| #   | Criterion                                                             | Verification                 |
| --- | --------------------------------------------------------------------- | ---------------------------- |
| 5.1 | 3 wizard presets produce correct BIG_MODEL, MIDDLE_MODEL, SMALL_MODEL | Unit test per preset         |
| 5.2 | Fallback chain terminates (no circular references)                    | Graph cycle detection test   |
| 5.3 | SMALL_MODEL is always `zai-org/GLM-4.7-Flash` (invariant)             | Unit test across all presets |
| 5.4 | Proxy has all 3 MODEL envs set                                        | Validation test              |

### Test Stubs

```typescript
describe("ADR-005: Model Mapping & Fallback", () => {
  describe("Wizard preset: GLM-4.7 (Full)", () => {
    it("should set BIG_MODEL to 'zai-org/GLM-4.7'", () => {
      // Given: choice = "cloudru-fm-glm47"
      // When: resolveModelPreset("cloudru-fm-glm47")
      // Then: result.BIG_MODEL === "zai-org/GLM-4.7"
    });

    it("should set MIDDLE_MODEL to 'zai-org/GLM-4.7-FlashX'", () => {
      // Then: result.MIDDLE_MODEL === "zai-org/GLM-4.7-FlashX"
    });

    it("should set SMALL_MODEL to 'zai-org/GLM-4.7-Flash'", () => {
      // Then: result.SMALL_MODEL === "zai-org/GLM-4.7-Flash"
    });
  });

  describe("Wizard preset: GLM-4.7-Flash (Free)", () => {
    it("should set all 3 MODEL envs to GLM-4.7-Flash variants", () => {
      // Given: choice = "cloudru-fm-flash"
      // Then: BIG === MIDDLE === SMALL === "zai-org/GLM-4.7-Flash"
      //       (or: BIG/MIDDLE = Flash, SMALL = Flash)
    });

    it("should set BIG_MODEL to 'zai-org/GLM-4.7-Flash'", () => {});
    it("should set MIDDLE_MODEL to 'zai-org/GLM-4.7-Flash'", () => {});
    it("should set SMALL_MODEL to 'zai-org/GLM-4.7-Flash'", () => {});
  });

  describe("Wizard preset: Qwen3-Coder-480B", () => {
    it("should set BIG_MODEL to Qwen3-Coder-480B", () => {
      // Then: result.BIG_MODEL === "Qwen/Qwen3-Coder-480B-A35B-Instruct"
    });

    it("should set MIDDLE_MODEL to GLM-4.7-FlashX", () => {
      // Then: result.MIDDLE_MODEL === "zai-org/GLM-4.7-FlashX"
    });

    it("should set SMALL_MODEL to GLM-4.7-Flash", () => {
      // Then: result.SMALL_MODEL === "zai-org/GLM-4.7-Flash"
    });
  });

  describe("Fallback chain integrity", () => {
    it("should terminate GLM-4.7 fallback chain at GLM-4.7-Flash", () => {
      // Given: fallback chain GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash
      // When: traversing chain
      // Then: last entry has no further fallback -> ERROR
    });

    it("should terminate Qwen3 fallback chain at GLM-4.7-Flash", () => {
      // Given: Qwen3-Coder -> GLM-4.7 -> GLM-4.7-Flash
      // Then: chain ends at GLM-4.7-Flash
    });

    it("should detect circular fallbacks if accidentally configured", () => {
      // Given: A -> B -> A (circular)
      // When: validateFallbackChain(chain)
      // Then: throws CircularFallbackError or returns false
    });

    it("should limit fallback depth to prevent infinite loops", () => {
      // Given: chain length > MAX_FALLBACK_DEPTH (e.g., 10)
      // Then: validation fails
    });
  });

  describe("SMALL_MODEL invariant", () => {
    it("should always be GLM-4.7-Flash for glm47 preset", () => {
      // resolveModelPreset("cloudru-fm-glm47").SMALL_MODEL === "zai-org/GLM-4.7-Flash"
    });

    it("should always be GLM-4.7-Flash for flash preset", () => {
      // resolveModelPreset("cloudru-fm-flash").SMALL_MODEL === "zai-org/GLM-4.7-Flash"
    });

    it("should always be GLM-4.7-Flash for qwen preset", () => {
      // resolveModelPreset("cloudru-fm-qwen").SMALL_MODEL === "zai-org/GLM-4.7-Flash"
    });
  });

  describe("Proxy MODEL envs validation", () => {
    it("should have all 3 MODEL envs set in docker-compose", () => {
      // Given: generated docker-compose
      // Then: environment contains BIG_MODEL, MIDDLE_MODEL, SMALL_MODEL
    });

    it("should not have empty MODEL env values", () => {
      // Given: any preset
      // When: generating env config
      // Then: all 3 values are non-empty strings
    });

    it("should use valid cloud.ru model IDs", () => {
      // Given: known valid model IDs
      // Then: each MODEL env matches a known cloud.ru model
    });
  });

  describe("CLAUDE_MODEL_ALIASES coverage", () => {
    it("should have at least one alias for opus tier", () => {
      // Object.values(CLAUDE_MODEL_ALIASES).includes("opus")
    });

    it("should have at least one alias for sonnet tier", () => {
      // Object.values(CLAUDE_MODEL_ALIASES).includes("sonnet")
    });

    it("should have at least one alias for haiku tier", () => {
      // Object.values(CLAUDE_MODEL_ALIASES).includes("haiku")
    });

    it("should only map to valid tier names (opus, sonnet, haiku)", () => {
      // All values in CLAUDE_MODEL_ALIASES are one of ["opus", "sonnet", "haiku"]
    });
  });
});
```

---

## Cross-ADR Integration Tests

These tests verify that multiple ADRs work together correctly.

```typescript
describe("Cross-ADR Integration", () => {
  it("ADR-001+002: wizard config produces valid proxy env + backend config", () => {
    // Given: wizard completes with cloudru-fm-glm47 choice
    // When: applyCloudruFmConfig() runs
    // Then: both docker-compose env AND openclaw.json backend config are consistent
  });

  it("ADR-001+003: resolved backend config produces valid subprocess env", () => {
    // Given: openclaw.json with cloudru-fm backend config
    // When: runCliAgent resolves backend and builds env
    // Then: subprocess env has ANTHROPIC_BASE_URL pointing to proxy
  });

  it("ADR-002+005: wizard choice determines correct MODEL env mapping", () => {
    // Given: wizard choice "cloudru-fm-flash"
    // When: docker-compose generated
    // Then: all 3 MODEL envs are set to GLM-4.7-Flash
  });

  it("ADR-003+004: runCliAgent fails gracefully when proxy is down", () => {
    // Given: proxy is UNHEALTHY
    // When: runCliAgent attempts to call proxy
    // Then: FailoverError thrown with appropriate reason
  });

  it("ADR-004+005: proxy restart preserves model mapping", () => {
    // Given: proxy running with GLM-4.7 preset
    // When: proxy restarts
    // Then: MODEL envs unchanged (Docker env persistence)
  });
});
```

---

## Test Priority Matrix

| Priority | Test                           | ADR | Risk                             |
| -------- | ------------------------------ | --- | -------------------------------- |
| P0       | Env injection correctness      | 001 | API calls go to wrong endpoint   |
| P0       | clearEnv isolation             | 003 | API key leakage between backends |
| P0       | SMALL_MODEL invariant          | 005 | Free tier guarantee broken       |
| P1       | mergeBackendConfig merge logic | 001 | Config corruption                |
| P1       | Tools disabled injection       | 003 | Unauthorized tool execution      |
| P1       | Fallback chain termination     | 005 | Infinite retry loops             |
| P1       | Health check timeout           | 004 | Request hangs indefinitely       |
| P2       | Wizard dispatch routing        | 002 | Wrong handler called             |
| P2       | Docker compose template        | 004 | Deployment failure               |
| P2       | Model alias completeness       | 005 | Unrecognized model names         |
| P3       | State machine transitions      | 004 | Incorrect lifecycle tracking     |
| P3       | Localhost-only binding         | 001 | Security (external access)       |
