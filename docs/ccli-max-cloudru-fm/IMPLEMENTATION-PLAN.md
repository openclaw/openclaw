# Implementation Plan: OpenClaw + Cloud.ru FM via Claude Code Proxy

## Document Metadata

| Field | Value |
|-------|-------|
| **Date** | 2026-02-12 |
| **Status** | DRAFT |
| **ADRs Implemented** | ADR-001 through ADR-005 |
| **Methodology** | SPARC-GOAP (Specification, Pseudocode, Architecture, Refinement, Completion) |
| **Shift-Left Issues Addressed** | CRITICAL-001 through CRITICAL-007, WARNING-001 through WARNING-011, X-001 through X-005 |
| **QCSD Quality Gates** | Capability, Reliability, Security (P0); Performance, Development (P1) |
| **Risk Register Coverage** | R001-R025 from shift-left risk analysis |

---

## Current State

```yaml
current_state:
  proxy_integration: none
  wizard_cloudru_support: false
  proxy_deployment_automation: false
  model_mapping: none
  health_monitoring: none
  concurrency: "serialize:true, limit 1"
  tools_in_cli_sessions: disabled
  type_system:
    AuthChoice: 43 members (onboard-types.ts:5-47)
    AuthChoiceGroupId:
      onboard-types.ts: 17 values (lines 48-66, missing litellm + together)
      auth-choice-options.ts: 20 values (lines 10-30, includes litellm + together)
    # NOTE: These two definitions ALREADY diverge (X-005)
  auth_handler_chain:
    file: auth-choice.apply.ts (lines 43-55)
    pattern: "applyAuthChoice<Provider>" returns null if not handled
    handlers: [Anthropic, OpenAI, OAuth, ApiProviders, MiniMax, GitHubCopilot, GoogleAntigravity, GoogleGeminiCli, CopilotProxy, QwenPortal, XAI]
  cli_backend:
    DEFAULT_CLAUDE_BACKEND: cli-backends.ts:30-53
    clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]
    serialize: true
    dangerously_skip_permissions: true
    systemPromptWhen: "first"
```

## Goal State

```yaml
goal_state:
  proxy_integration: "claude-code-proxy via Docker, localhost:8082"
  wizard_cloudru_support: true  # 3 model choices in wizard
  proxy_deployment_automation: "docker-compose generation + health check"
  model_mapping: "3 presets (GLM-4.7 Full, Flash Free, Qwen3 Code)"
  health_monitoring: "pre-flight health check with 30s cache"
  fallback_chain: "opus -> sonnet -> haiku (mapped via proxy tiers)"
  security_hardened: true  # Docker security opts, pinned image, extended clearEnv
  type_system_consistent: true  # Both AuthChoiceGroupId definitions aligned
  acceptance_tests: passing
```

---

## Dependency DAG

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

**Parallel opportunities:**
- M2 and M3 can execute in parallel after M1 completes
- M6 can start partially in parallel with M5 (Docker security is independent of health check code)

---

## Milestone 1: Type System Foundation

| Field | Value |
|-------|-------|
| **ID** | M1 |
| **Name** | Type System Foundation |
| **SPARC Phase** | Specification |
| **Estimated Effort** | S (Small) |
| **Risk Level** | Medium |
| **Dependencies** | None (starting point) |

### Preconditions

- Access to upstream source files in `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/`
- TypeScript compiler available

### Problem Statement

The `AuthChoiceGroupId` type is defined in TWO files with DIFFERENT members (shift-left X-005, WARNING-004). Adding `"cloudru-fm"` to only one file will cause type mismatches. ADR-002 only mentions extending `auth-choice-options.ts` but `onboard-types.ts` also needs updating.

### Files to Modify

#### 1. `upstream/src/commands/onboard-types.ts`

**Change:** Add 3 new `AuthChoice` values and `"cloudru-fm"` to `AuthChoiceGroupId`.

```typescript
// In AuthChoice union (after line 46, before "skip"):
| "cloudru-fm-glm47"
| "cloudru-fm-flash"
| "cloudru-fm-qwen"

// In AuthChoiceGroupId union (after line 65, before "custom"):
| "cloudru-fm"
```

Also add to `OnboardOptions`:
```typescript
cloudruApiKey?: string;
```

#### 2. `upstream/src/commands/auth-choice-options.ts`

**Change:** Add `"cloudru-fm"` to `AuthChoiceGroupId` union and add group definition + choice options.

```typescript
// In AuthChoiceGroupId union (after line 29, before "custom"):
| "cloudru-fm"

// In AUTH_CHOICE_GROUP_DEFS array (after zai group, before qianfan group -- position ~line 98):
{
  value: "cloudru-fm",
  label: "Cloud.ru FM",
  hint: "GLM-4.7 / Qwen3 via Claude Code proxy",
  choices: ["cloudru-fm-glm47", "cloudru-fm-flash", "cloudru-fm-qwen"],
},

// In buildAuthChoiceOptions function (after zai options, before xiaomi):
options.push({
  value: "cloudru-fm-glm47",
  label: "GLM-4.7 (Full)",
  hint: "358B MoE, thinking mode, 200K context",
});
options.push({
  value: "cloudru-fm-flash",
  label: "GLM-4.7-Flash (Free)",
  hint: "Free tier, fast, recommended default",
});
options.push({
  value: "cloudru-fm-qwen",
  label: "Qwen3-Coder-480B",
  hint: "Code-specialized, 128K context",
});
```

### Shift-Left Issues Addressed

| Issue | Resolution |
|-------|-----------|
| X-005 | Both `AuthChoiceGroupId` definitions updated simultaneously |
| WARNING-004 | `"cloudru-fm"` added to BOTH files |
| WARNING-005 | Verified actual AuthChoice count (43, not 47) before extending |
| CRITICAL-003 | Handler naming convention `applyAuthChoice<Provider>` followed (set up for M2) |

### Acceptance Criteria

1. `tsc --noEmit` compiles with zero errors after type extensions
2. Both `AuthChoiceGroupId` definitions include `"cloudru-fm"`
3. `AUTH_CHOICE_GROUP_DEFS` array includes the cloudru-fm group with 3 choices
4. `buildAuthChoiceOptions` returns options for all 3 cloudru-fm choices
5. No existing auth choices are broken (regression check)

### Tests to Write

- `tests/commands/auth-choice-options.cloudru-fm.test.ts`
  - Verify `buildAuthChoiceGroups` returns a group with `value: "cloudru-fm"` and 3 options
  - Verify all existing groups still present (regression)
  - Verify `AuthChoiceGroupId` in both files are aligned (compile-time test)

### Quality Gate

- [ ] TypeScript compiles: `tsc --noEmit`
- [ ] All existing tests pass: `pnpm test`
- [ ] New type values are present in both definition files

---

## Milestone 2: Wizard Onboarding Flow

| Field | Value |
|-------|-------|
| **ID** | M2 |
| **Name** | Wizard Cloud.ru FM Onboarding Flow |
| **SPARC Phase** | Architecture + Refinement |
| **Estimated Effort** | M (Medium) |
| **Risk Level** | Medium |
| **Dependencies** | M1 (Type Foundation) |

### Preconditions

- M1 type extensions complete and compiling
- Existing wizard pattern understood (auth-choice.apply.xai.ts as reference)

### Files to Create

#### 1. `upstream/src/commands/auth-choice.apply.cloudru-fm.ts` (~120 lines)

**Purpose:** Auth choice handler for `cloudru-fm-*` choices. Follows the established `applyAuthChoice<Provider>` pattern.

**Functions:**
- `applyAuthChoiceCloudruFm(params: ApplyAuthChoiceParams): Promise<ApplyAuthChoiceResult | null>` -- Main handler. Returns `null` if `params.authChoice` does not start with `"cloudru-fm-"`.

**Flow:**
```
1. Check authChoice starts with "cloudru-fm-" -> return null otherwise
2. Prompt for cloud.ru API key (or detect from CLOUDRU_API_KEY env)
3. Resolve model preset based on authChoice:
   - "cloudru-fm-glm47"  -> BIG=GLM-4.7, MIDDLE=GLM-4.7-FlashX, SMALL=GLM-4.7-Flash
   - "cloudru-fm-flash"  -> BIG=GLM-4.7-Flash, MIDDLE=GLM-4.7-Flash, SMALL=GLM-4.7-Flash
   - "cloudru-fm-qwen"   -> BIG=Qwen3-Coder-480B, MIDDLE=GLM-4.7-FlashX, SMALL=GLM-4.7-Flash
4. Apply provider config to openclaw.json:
   - models.providers["cloudru-fm"] = { baseUrl, apiKey reference, models }
5. Apply CLI backend override:
   - agents.defaults.cliBackends["claude-cli"].env = {
       ANTHROPIC_BASE_URL: "http://localhost:8082",
       ANTHROPIC_API_KEY: "not-a-real-key-proxy-only"
     }
6. Set primary model:
   - agents.defaults.model.primary = "claude-cli/opus"  (routes through proxy)
   - agents.defaults.model.fallbacks = ["claude-cli/sonnet", "claude-cli/haiku"]
7. Store API key to .env (NOT to openclaw.json)
8. Return { config: updatedConfig }
```

#### 2. `upstream/src/commands/onboard-cloudru-fm.ts` (~100 lines)

**Purpose:** Cloud.ru FM-specific onboarding utilities (Docker compose generation, model preset resolution).

**Functions:**
- `resolveCloudruModelPreset(choice: AuthChoice): CloudruModelPreset` -- Pure function mapping choice to BIG/MIDDLE/SMALL model IDs
- `generateDockerComposeTemplate(params: { port: number; preset: CloudruModelPreset }): string` -- Returns docker-compose YAML string with template variables
- `writeCloudruEnvFile(params: { apiKey: string; workspaceDir: string }): Promise<void>` -- Writes `.env` with CLOUDRU_API_KEY and adds to `.gitignore`
- `ensureGitignoreEntries(params: { workspaceDir: string; entries: string[] }): Promise<void>` -- Idempotently adds entries to `.gitignore`

**Types:**
```typescript
type CloudruModelPreset = {
  big: string;    // Full cloud.ru model ID for BIG_MODEL
  middle: string; // Full cloud.ru model ID for MIDDLE_MODEL
  small: string;  // Full cloud.ru model ID for SMALL_MODEL
  label: string;  // Human-readable label
  free: boolean;  // Whether the default model is free tier
};
```

### Files to Modify

#### 3. `upstream/src/commands/auth-choice.apply.ts`

**Change:** Import and register the new handler.

```typescript
// Add import (after line 15):
import { applyAuthChoiceCloudruFm } from "./auth-choice.apply.cloudru-fm.js";

// Add to handlers array (line 43-55, add before the closing bracket):
// Add as the last handler before the loop:
applyAuthChoiceCloudruFm,
```

#### 4. `upstream/src/commands/configure.gateway-auth.ts`

**Change:** Add dispatch for `cloudru-fm-*` choices BEFORE the `custom-api-key` check.

```typescript
// Before line 60 (before `if (authChoice === "custom-api-key")`):
if (authChoice.startsWith("cloudru-fm-")) {
  const { promptCloudruFmSetup } = await import("./onboard-cloudru-fm.js");
  const cloudruResult = await promptCloudruFmSetup({ prompter, runtime, config: next, authChoice });
  next = cloudruResult.config;
} else if (authChoice === "custom-api-key") {
  // ... existing custom-api-key handling
```

NOTE: The actual insertion point is at line 59-60 in `configure.gateway-auth.ts`, NOT at "line 60" as ADR-002 incorrectly stated (shift-left CRITICAL-002). The dispatch in `configure.gateway-auth.ts` handles `custom-api-key` and `skip` explicitly. All other choices go through `applyAuthChoice()`. For `cloudru-fm-*`, we add handling in BOTH places: the handler chain in `auth-choice.apply.ts` (for programmatic use) and a pre-check in `configure.gateway-auth.ts` (for the interactive wizard flow that needs Docker setup steps).

### Shift-Left Issues Addressed

| Issue | Resolution |
|-------|-----------|
| CRITICAL-002 | Correct integration point: `auth-choice.apply.ts:43-55` handler chain + `configure.gateway-auth.ts:59-60` pre-check |
| CRITICAL-003 | Function named `applyAuthChoiceCloudruFm` matching convention |
| X-002 | Clear boundary: wizard handles UI + config; M4 handles Docker operations |
| R024 | Sentinel value changed to `"not-a-real-key-proxy-only"` for clarity |
| WARNING-010 | Full model IDs used consistently (`zai-org/GLM-4.7`, not `GLM-4.7`) |

### Acceptance Criteria

1. Selecting "Cloud.ru FM" in wizard shows 3 model choices
2. Completing the wizard writes correct config to `openclaw.json`:
   - `agents.defaults.cliBackends.claude-cli.env.ANTHROPIC_BASE_URL` = `"http://localhost:8082"`
   - `agents.defaults.model.primary` = `"claude-cli/opus"`
   - `agents.defaults.model.fallbacks` includes `["claude-cli/sonnet", "claude-cli/haiku"]`
3. API key is written to `.env`, NOT to `openclaw.json`
4. `.gitignore` includes `.env` and `docker-compose.cloudru-proxy.yml`
5. All existing wizard flows (18+ providers) still function correctly (regression)

### Tests to Write

- `tests/commands/auth-choice.apply.cloudru-fm.test.ts`
  - Handler returns `null` for non-cloudru-fm choices
  - Handler applies correct config for each of the 3 choices
  - API key sentinel value is `"not-a-real-key-proxy-only"`
  - Fallback list uses Claude tier names (opus/sonnet/haiku)
- `tests/commands/onboard-cloudru-fm.test.ts`
  - `resolveCloudruModelPreset` returns correct model IDs for each choice
  - `generateDockerComposeTemplate` produces valid YAML
  - Docker compose uses pinned image version (not `:latest`)
  - Docker compose binds to `127.0.0.1`
  - `.env` template includes `CLOUDRU_API_KEY` placeholder

### Quality Gate

- [ ] TypeScript compiles with new files
- [ ] Handler chain tests pass
- [ ] Wizard regression tests pass for all existing providers
- [ ] No secrets in generated config files

---

## Milestone 3: Backend Config and Model Mapping

| Field | Value |
|-------|-------|
| **ID** | M3 |
| **Name** | CLI Backend Configuration and Model Mapping |
| **SPARC Phase** | Specification + Refinement |
| **Estimated Effort** | S (Small) |
| **Risk Level** | Low |
| **Dependencies** | M1 (Type Foundation) |

### Preconditions

- M1 type extensions complete
- Understanding of `mergeBackendConfig()` shallow merge behavior (risk R011)
- Understanding of `CLAUDE_MODEL_ALIASES` mapping (cli-backends.ts:10-28)

### Problem Statement

ADR-001 defines the backend env override. ADR-005 defines model mapping. The fallback chain must operate at Claude Code tier level (opus/sonnet/haiku), NOT at cloud.ru model level (shift-left CRITICAL-006, CRITICAL-007, X-003). The proxy maps tiers to models via its BIG_MODEL/MIDDLE_MODEL/SMALL_MODEL env vars.

### Files to Create

#### 1. `upstream/src/config/cloudru-fm.constants.ts` (~60 lines)

**Purpose:** Centralized model ID definitions and preset configurations. Addresses risk R019 (model ID hardcoding) by having a single source of truth.

**Exports:**
```typescript
export const CLOUDRU_FM_MODELS = {
  "glm-4.7": "zai-org/GLM-4.7",
  "glm-4.7-flashx": "zai-org/GLM-4.7-FlashX",
  "glm-4.7-flash": "zai-org/GLM-4.7-Flash",
  "qwen3-coder-480b": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
} as const;

export const CLOUDRU_FM_PRESETS = {
  "cloudru-fm-glm47": {
    big: CLOUDRU_FM_MODELS["glm-4.7"],
    middle: CLOUDRU_FM_MODELS["glm-4.7-flashx"],
    small: CLOUDRU_FM_MODELS["glm-4.7-flash"],
    label: "GLM-4.7 (Full)",
    free: false,
  },
  "cloudru-fm-flash": {
    big: CLOUDRU_FM_MODELS["glm-4.7-flash"],
    middle: CLOUDRU_FM_MODELS["glm-4.7-flash"],
    small: CLOUDRU_FM_MODELS["glm-4.7-flash"],
    label: "GLM-4.7-Flash (Free)",
    free: true,
  },
  "cloudru-fm-qwen": {
    big: CLOUDRU_FM_MODELS["qwen3-coder-480b"],
    middle: CLOUDRU_FM_MODELS["glm-4.7-flashx"],
    small: CLOUDRU_FM_MODELS["glm-4.7-flash"],
    label: "Qwen3-Coder-480B",
    free: false,
  },
} as const;

export const CLOUDRU_PROXY_PORT_DEFAULT = 8082;
export const CLOUDRU_BASE_URL = "https://foundation-models.api.cloud.ru/v1";
export const CLOUDRU_PROXY_IMAGE = "legard/claude-code-proxy:v1.0.0"; // Pinned, NOT :latest
export const CLOUDRU_PROXY_SENTINEL_KEY = "not-a-real-key-proxy-only";
```

### Files to Modify

None in this milestone. The constants file is consumed by M2 and M4.

### Key Design Decisions

**Fallback chain alignment (CRITICAL-006, CRITICAL-007, X-003):**

The fallback chain MUST be expressed in Claude Code tier names. The mapping is:

| OpenClaw Fallback Config | Claude Code CLI Flag | Proxy Env | Cloud.ru Model |
|--------------------------|---------------------|-----------|---------------|
| `claude-cli/opus` | `--model opus` | BIG_MODEL | Per preset |
| `claude-cli/sonnet` | `--model sonnet` | MIDDLE_MODEL | Per preset |
| `claude-cli/haiku` | `--model haiku` | SMALL_MODEL | Per preset |

The `agents.defaults.model.fallbacks` config MUST use `["claude-cli/sonnet", "claude-cli/haiku"]` -- NOT `["zai-org/GLM-4.7-Flash"]`. The proxy handles the model-level mapping internally.

**GLM-4.7-FlashX availability (CRITICAL-007):**

GLM-4.7-FlashX IS available -- it is assigned to the MIDDLE_MODEL proxy slot. It is addressable as `claude-cli/sonnet` (which the proxy maps to MIDDLE_MODEL). The ADR-005 fallback chain `GLM-4.7 -> GLM-4.7-FlashX -> GLM-4.7-Flash` is implementable as `opus -> sonnet -> haiku` through the proxy tier system.

### Acceptance Criteria

1. Constants file exports all model IDs, presets, and default values
2. All 3 presets map correctly to BIG/MIDDLE/SMALL
3. SMALL_MODEL is always `GLM-4.7-Flash` (ADR-005 invariant)
4. Proxy image version is pinned (not `:latest`)
5. Base URL and port defaults are centralized

### Tests to Write

- `tests/config/cloudru-fm.constants.test.ts`
  - Verify all 3 presets have valid model IDs
  - Verify SMALL_MODEL invariant: always GLM-4.7-Flash
  - Verify no `:latest` in proxy image constant
  - Verify each preset has big, middle, small, label, free fields

### Quality Gate

- [ ] Constants compile
- [ ] All model ID strings match cloud.ru API documentation
- [ ] Proxy image is pinned to specific version

---

## Milestone 4: Proxy Lifecycle Management

| Field | Value |
|-------|-------|
| **ID** | M4 |
| **Name** | Proxy Docker Deployment and Lifecycle |
| **SPARC Phase** | Architecture + Refinement |
| **Estimated Effort** | M (Medium) |
| **Risk Level** | High |
| **Dependencies** | M2 (Wizard Flow), M3 (Constants) |

### Preconditions

- M3 constants available
- Docker installed on development machine
- Understanding of ADR-004 state machine and shift-left findings

### Problem Statement

ADR-004 defines proxy lifecycle but has the lowest testability score (50/100). The state machine has no TypeScript implementation (CRITICAL-005). The health check location is ambiguous (CRITICAL-004). Docker prerequisites are not checked (WARNING-008). Port conflicts are not handled (WARNING-009).

### Files to Create

#### 1. `upstream/src/agents/proxy-health.ts` (~90 lines)

**Purpose:** Proxy health checking with caching. Resolves CRITICAL-004 by specifying the exact location and mechanism.

**Functions:**
```typescript
type ProxyHealthResult = {
  ok: boolean;
  status?: number;
  error?: string;
  cachedAt?: number;
};

// Cached health check: result is cached for 30 seconds
export async function checkProxyHealth(proxyUrl: string): Promise<ProxyHealthResult>;

// Force fresh health check (bypass cache)
export async function checkProxyHealthFresh(proxyUrl: string): Promise<ProxyHealthResult>;

// Extract proxy URL from backend config
export function resolveProxyUrl(config?: OpenClawConfig): string | null;
```

**Implementation details:**
- Uses `fetch` with 5-second timeout to `GET ${proxyUrl}/health`
- Caches result in module-level variable for 30 seconds (configurable)
- Returns `{ ok: false, error: "..." }` on any failure
- Does NOT throw -- always returns a result object

#### 2. `upstream/src/commands/proxy-docker.ts` (~130 lines)

**Purpose:** Docker compose generation and Docker prerequisite checks. Resolves WARNING-008, WARNING-009.

**Functions:**
```typescript
// Check if Docker and docker-compose are available
export async function checkDockerAvailable(): Promise<{
  docker: boolean;
  compose: boolean;
  version?: string;
}>;

// Check if a port is available
export async function checkPortAvailable(port: number): Promise<boolean>;

// Generate docker-compose.cloudru-proxy.yml content
export function generateProxyDockerCompose(params: {
  port: number;
  preset: CloudruModelPreset;
}): string;

// Write docker-compose file to workspace
export async function writeProxyDockerCompose(params: {
  workspaceDir: string;
  port: number;
  preset: CloudruModelPreset;
}): Promise<string>; // Returns file path
```

**Docker compose template features (addressing security findings):**
- Image pinned to specific version: `legard/claude-code-proxy:v1.0.0` (R013)
- Localhost-only binding: `127.0.0.1:${port}:8082` (R008)
- Security hardening (E-01, QCSD-05):
  ```yaml
  security_opt:
    - no-new-privileges:true
  cap_drop:
    - ALL
  read_only: true
  ```
- Resource limits (D-02):
  ```yaml
  deploy:
    resources:
      limits:
        memory: 512M
        cpus: "1.0"
  ```
- Improved health check (MQ-24, MQ-26):
  ```yaml
  healthcheck:
    test: ["CMD", "curl", "-sf", "http://localhost:8082/health"]
    interval: 10s
    timeout: 5s
    retries: 3
    start_period: 10s
  ```
- `HOST: "0.0.0.0"` with comment explaining it is required for Docker port forwarding (WARNING-003)
- `DISABLE_THINKING: "true"` as default (ADR-005 mitigation)

### Files to Modify

#### 3. Integration with wizard flow (from M2)

The `onboard-cloudru-fm.ts` file created in M2 will import and use `proxy-docker.ts` functions:
- Call `checkDockerAvailable()` at wizard step 4
- Call `checkPortAvailable(port)` before Docker compose generation
- Call `writeProxyDockerCompose()` to generate the file
- Call `checkProxyHealth()` after Docker deployment

### Shift-Left Issues Addressed

| Issue | Resolution |
|-------|-----------|
| CRITICAL-004 | Health check at `proxy-health.ts`, called from agent-runner routing layer |
| CRITICAL-005 | State machine simplified to stateless health check with cache (pragmatic) |
| WARNING-008 | `checkDockerAvailable()` before wizard step 4 |
| WARNING-009 | `checkPortAvailable()` before Docker compose generation |
| R002 | Pre-flight health check prevents requests to dead proxy |
| R013 | Image pinned to specific version |
| R008 | Localhost-only binding + security_opt documentation |
| E-01 | Docker security hardening in compose template |
| D-02 | Docker resource limits in compose template |
| MQ-24 | `start_period: 10s` added to healthcheck |
| MQ-26 | Health check interval reduced to 10s |

### Acceptance Criteria

1. `checkDockerAvailable()` correctly detects Docker/docker-compose presence
2. `checkPortAvailable(8082)` returns false when port is occupied
3. Generated docker-compose is valid YAML and passes `docker-compose config`
4. Docker compose includes all security hardening options
5. `checkProxyHealth()` returns `{ ok: true }` when proxy is running
6. `checkProxyHealth()` returns `{ ok: false, error }` when proxy is down
7. Health check result is cached for 30 seconds
8. Wizard gracefully handles Docker not being installed (shows instructions, does not crash)

### Tests to Write

- `tests/agents/proxy-health.test.ts`
  - Mock HTTP server on localhost returns 200 -> `{ ok: true }`
  - No server running -> `{ ok: false, error: "ECONNREFUSED" }`
  - Timeout scenario -> `{ ok: false, error: "timeout" }`
  - Cache: two calls within 30s, only one HTTP request made
  - Cache expiry: call after 30s makes a fresh HTTP request
- `tests/commands/proxy-docker.test.ts`
  - Generated YAML contains pinned image version
  - Generated YAML contains `127.0.0.1` port binding
  - Generated YAML contains `security_opt`, `cap_drop`, `read_only`
  - Generated YAML contains resource limits
  - Port check with occupied port returns false

### Risk Mitigations

| Risk | Mitigation |
|------|-----------|
| Docker not installed | Wizard detects and shows manual setup instructions |
| Port 8082 in use | Wizard prompts for alternative port |
| Docker compose generation fails | Wizard outputs the YAML to console for manual use |
| Health check false positive | Fresh health check available for forced re-check |

### Quality Gate

- [ ] Docker compose passes `docker-compose config` validation
- [ ] Health check tests pass with mock server
- [ ] No secrets hardcoded in generated files (use .env references)
- [ ] Docker security hardening present in template

---

## Milestone 5: Health Monitoring and Fallback Integration

| Field | Value |
|-------|-------|
| **ID** | M5 |
| **Name** | Runtime Health Monitoring and Fallback Chain |
| **SPARC Phase** | Refinement |
| **Estimated Effort** | M (Medium) |
| **Risk Level** | High |
| **Dependencies** | M3 (Constants), M4 (Proxy Health) |

### Preconditions

- M4 `checkProxyHealth()` and `resolveProxyUrl()` available
- Understanding of `runCliAgent()` in `cli-runner.ts`
- Understanding of `runWithModelFallback()` in `model-fallback.ts`
- Understanding of `classifyFailoverReason()` in `pi-embedded-helpers.ts`

### Problem Statement

There is no runtime health check before routing to the proxy (R002). The fallback chain uses cloud.ru model names but must use Claude tier names (CRITICAL-006). Error messages from cloud.ru may not match existing failover regex patterns (MQ-14). The `classifyFailoverReason()` function needs cloud.ru-specific patterns.

### Files to Modify

#### 1. `upstream/src/agents/cli-runner.ts`

**Change:** Add pre-flight proxy health check before subprocess spawn. Insert after backend resolution (line 72) and before subprocess spawn (line 236).

The check should be lightweight and non-blocking for non-proxy backends:

```typescript
// After line 76 (const backend = backendResolved.config;):
// Pre-flight proxy health check for backends using localhost proxy
const proxyUrl = backend.env?.ANTHROPIC_BASE_URL;
if (proxyUrl && proxyUrl.includes("localhost")) {
  const { checkProxyHealth } = await import("./proxy-health.js");
  const health = await checkProxyHealth(proxyUrl);
  if (!health.ok) {
    throw new FailoverError(
      `Proxy unhealthy: ${health.error ?? "unknown error"}`,
      {
        reason: "proxy-unhealthy",
        provider: params.provider,
        model: modelId,
        status: 503,
      },
    );
  }
}
```

#### 2. `upstream/src/agents/pi-embedded-helpers.ts` (or equivalent failover classification file)

**Change:** Add cloud.ru-specific error patterns to `classifyFailoverReason()`.

```typescript
// Add patterns for cloud.ru FM errors:
// Russian error messages from cloud.ru API
if (/превышен лимит|rate.?limit/i.test(message)) return "rate_limit";
if (/модель.*недоступна|model.*unavailable/i.test(message)) return "model_unavailable";
if (/proxy.?unhealthy/i.test(message)) return "proxy-unhealthy";
// ECONNREFUSED to proxy
if (/ECONNREFUSED.*8082|ECONNREFUSED.*localhost/i.test(message)) return "proxy-unhealthy";
```

#### 3. `upstream/src/agents/cli-backends.ts`

**Change:** Extend `clearEnv` to cover additional sensitive variables (R007).

```typescript
// In DEFAULT_CLAUDE_BACKEND (line 51), extend clearEnv:
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

### Key Design Decisions

**Health check location (CRITICAL-004 resolution):**

The health check is placed inside `runCliAgent()` (after backend resolution, before subprocess spawn) rather than in `agent-runner.ts` routing layer. Rationale:
- The backend config (including `ANTHROPIC_BASE_URL`) is only fully resolved inside `runCliAgent()`
- The check runs only for backends with a localhost proxy URL (not all CLI backends)
- The 30-second cache means overhead is minimal (one HTTP call per 30 seconds max)

**Fallback integration (CRITICAL-006 resolution):**

The health check throws a `FailoverError` with reason `"proxy-unhealthy"`. This integrates with the existing `runWithModelFallback()` mechanism in `model-fallback.ts`. However, a proxy-unhealthy error should NOT trigger model fallback (switching from opus to sonnet won't help if the proxy is down). The fallback handler should skip backends that share the same proxy URL.

**Extended clearEnv (R007 resolution):**

The clearEnv is extended from 2 entries to 8 entries. This is a blocklist approach (not allowlist) to maintain backward compatibility. A future ADR may switch to an allowlist approach.

### Shift-Left Issues Addressed

| Issue | Resolution |
|-------|-----------|
| R002 | Pre-flight health check prevents requests to dead proxy |
| R007 | Extended clearEnv covers common sensitive variables |
| CRITICAL-006 | Fallback uses Claude tier names; documented mapping |
| MQ-14 | Cloud.ru-specific error patterns added to classifyFailoverReason |
| MQ-15 | Health check prevents retry during proxy restart |
| WARNING-001 | Latency budget documented: proxy health check < 1s, cached for 30s |

### Acceptance Criteria

1. When proxy is down, `runCliAgent()` throws `FailoverError` with reason `"proxy-unhealthy"` BEFORE spawning subprocess
2. When proxy is healthy, `runCliAgent()` proceeds normally with no extra latency (cached check)
3. `classifyFailoverReason()` correctly classifies cloud.ru-specific errors
4. `clearEnv` removes 8 sensitive variable patterns from subprocess environment
5. Existing `clearEnv` behavior for `ANTHROPIC_API_KEY` is preserved
6. Non-proxy CLI backends (e.g., direct claude-cli, codex-cli) are unaffected

### Tests to Write

- `tests/agents/cli-runner.proxy-health.test.ts`
  - Mock proxy unhealthy -> `FailoverError` thrown before subprocess spawn
  - Mock proxy healthy -> subprocess spawns normally
  - No proxy URL in config -> health check skipped
  - Health check cached -> only 1 HTTP call for rapid successive requests
- `tests/agents/failover-cloudru.test.ts`
  - Russian error message classified correctly
  - `ECONNREFUSED` to port 8082 classified as `"proxy-unhealthy"`
  - Rate limit patterns recognized
- `tests/agents/cli-backends.clearenv.test.ts`
  - All 8 sensitive variables cleared from subprocess environment
  - Non-sensitive variables (PATH, HOME) preserved

### Quality Gate

- [ ] Health check integration tests pass
- [ ] Failover classification tests pass
- [ ] No regression in existing CLI backend tests
- [ ] clearEnv covers all required sensitive patterns

---

## Milestone 6: Security Hardening

| Field | Value |
|-------|-------|
| **ID** | M6 |
| **Name** | Security Hardening and Defensive Measures |
| **SPARC Phase** | Refinement |
| **Estimated Effort** | S (Small) |
| **Risk Level** | Medium |
| **Dependencies** | M4 (Proxy Docker), M5 (Health Monitoring) |

### Preconditions

- M4 docker-compose template available
- M5 clearEnv extension done
- Understanding of STRIDE threat model (QCSD-05)

### Problem Statement

Multiple security gaps identified in the STRIDE analysis: no proxy authentication (S-01), Docker image not pinned (S-03), `--dangerously-skip-permissions` combined with soft tool disablement (E-02), no config validation (T-03, E-04), `.env` not enforced in `.gitignore` (I-01).

### Files to Create

#### 1. `upstream/src/agents/proxy-security.ts` (~60 lines)

**Purpose:** Security validation utilities for proxy configuration.

**Functions:**
```typescript
// Validate that ANTHROPIC_BASE_URL points to localhost only (S-02)
export function validateProxyUrl(url: string): { valid: boolean; error?: string };

// Validate that the backend config command is on the allowlist (E-04)
export function validateBackendCommand(command: string): { valid: boolean; error?: string };

// Generate a per-installation proxy auth token (S-01 mitigation)
export function generateProxyAuthToken(): string;
```

### Files to Modify

#### 2. `upstream/src/agents/cli-backends.ts`

**Change:** Add URL validation in `resolveCliBackendConfig()` for the `ANTHROPIC_BASE_URL` env override.

```typescript
// After merging config (line 133), add validation:
if (merged.env?.ANTHROPIC_BASE_URL) {
  const { validateProxyUrl } = await import("./proxy-security.js");
  const validation = validateProxyUrl(merged.env.ANTHROPIC_BASE_URL);
  if (!validation.valid) {
    log.warn(`[security] ${validation.error}`);
  }
}
```

Note: This is a WARNING, not a hard block, to maintain backward compatibility. Future versions may make this a hard error.

#### 3. Docker compose template (in M4's `proxy-docker.ts`)

**Additional security directives already included in M4:**
- `security_opt: [no-new-privileges:true]` (E-01)
- `cap_drop: [ALL]` (E-01)
- `read_only: true` (E-01)
- `user: "1000:1000"` (E-01, run as non-root)
- Resource limits (D-02)

#### 4. Wizard flow (in M2's files)

**Additional security measures in wizard:**
- Auto-add `.env` and `docker-compose.cloudru-proxy.yml` to `.gitignore` (I-01)
- Display warning about the sentinel key (R024)
- Show security summary after setup

### Shift-Left Issues Addressed

| Issue | Resolution |
|-------|-----------|
| S-01 | Proxy auth token generation (for future proxy versions that support it) |
| S-02 | URL validation warns on non-localhost ANTHROPIC_BASE_URL |
| S-03 | Docker image pinned (already in M4) |
| E-01 | Docker security hardening (already in M4) |
| E-02 | Documented: `--dangerously-skip-permissions` is required by OpenClaw; tools disabled via prompt |
| E-04 | Backend command allowlist validation |
| T-03 | URL validation on config overrides |
| I-01 | `.env` and docker-compose auto-added to `.gitignore` |
| R003 | Multiple defense layers documented and tested |

### Acceptance Criteria

1. `validateProxyUrl("http://localhost:8082")` returns `{ valid: true }`
2. `validateProxyUrl("http://evil.com:8082")` returns `{ valid: false, error: "..." }`
3. `validateBackendCommand("claude")` returns `{ valid: true }`
4. `validateBackendCommand("/bin/bash")` returns `{ valid: false, error: "..." }`
5. `.gitignore` includes `.env` and `docker-compose.cloudru-proxy.yml` after wizard
6. Docker compose template passes security review checklist

### Tests to Write

- `tests/agents/proxy-security.test.ts`
  - URL validation: localhost, 127.0.0.1, [::1] -> valid
  - URL validation: external IPs, hostnames -> invalid
  - Command validation: claude, codex -> valid
  - Command validation: /bin/bash, sh, python -> invalid

### Quality Gate

- [ ] Security validation tests pass
- [ ] Docker compose has all hardening directives
- [ ] `.gitignore` enforcement verified
- [ ] No secrets committed in any test or template

---

## Milestone 7: Integration Testing and Quality Gates

| Field | Value |
|-------|-------|
| **ID** | M7 |
| **Name** | End-to-End Integration Testing and Quality Gate Verification |
| **SPARC Phase** | Completion |
| **Estimated Effort** | L (Large) |
| **Risk Level** | Low |
| **Dependencies** | M1-M6 (all previous milestones) |

### Preconditions

- All previous milestones complete
- Docker available for integration tests
- All unit tests passing

### Problem Statement

No end-to-end integration test is specified across 5 ADRs (X-004). The overall testability score is 64/100. The P0 quality categories (Reliability, Security) have LOW testability. This milestone fills the testing gap.

### Test Suites to Create

#### 1. `tests/integration/cloudru-fm-e2e.test.ts` (~200 lines)

**End-to-end integration test (X-004 resolution):**

```
Given: proxy is running and healthy on localhost:8082
When: OpenClaw sends a message via claude-cli backend
Then: a response is returned within 60s with no proxy errors
```

Test setup:
- Spawn a mock HTTP server on port 8082 that emulates the proxy health endpoint and basic Anthropic API responses
- Configure OpenClaw with cloudru-fm backend settings
- Exercise the full chain: `resolveCliBackendConfig -> health check -> runCliAgent (mocked subprocess) -> parse response`

#### 2. `tests/integration/cloudru-fm-wizard.test.ts` (~150 lines)

**Wizard integration test:**
- Select cloudru-fm-flash auth choice
- Verify config output structure
- Verify Docker compose generation
- Verify `.gitignore` entries

#### 3. `tests/integration/cloudru-fm-fallback.test.ts` (~120 lines)

**Fallback chain integration test (CRITICAL-006 resolution):**
- Mock primary model (opus) returning 503
- Verify fallback to sonnet (MIDDLE_MODEL)
- Verify fallback to haiku (SMALL_MODEL)
- Verify error after all 3 fail
- Verify fallback uses Claude tier names throughout

#### 4. `tests/integration/cloudru-fm-security.test.ts` (~80 lines)

**Security integration test:**
- Verify subprocess environment does not contain sensitive variables
- Verify Docker compose port binding is localhost-only
- Verify proxy URL validation catches external URLs
- Verify `.env` is not committed (check `.gitignore`)

### Cross-ADR Verification Checklist

| Verification | ADR | Test |
|-------------|-----|------|
| Proxy health check returns 200 within 1s | ADR-004 | `cloudru-fm-e2e.test.ts` |
| TypeScript compiles with new AuthChoice values | ADR-002 | `tsc --noEmit` |
| Wizard renders Cloud.ru FM group with 3 choices | ADR-002 | `cloudru-fm-wizard.test.ts` |
| `runCliAgent()` returns JSON response when backed by proxy | ADR-003 | `cloudru-fm-e2e.test.ts` |
| `verifyProxyHealth()` returns correct results | ADR-004 | `proxy-health.test.ts` |
| Fallback opus->sonnet->haiku works through proxy tiers | ADR-005 | `cloudru-fm-fallback.test.ts` |
| Tool calling claim qualified (not overstated) | ADR-001/003 | Documentation review (manual) |

### QCSD Quality Gates Verification

#### Gate 1: Pre-Implementation (P0 blockers) -- RESOLVED

- [x] ADR-001 tool calling claim corrected (X-001: addressed in documentation)
- [x] ADR-005 fallback chain rewritten using Claude Code tier names (CRITICAL-006: M3+M5)
- [x] ADR-002 integration point corrected (CRITICAL-002: M2)
- [x] ADR-004 health check implementation location specified (CRITICAL-004: M5)

#### Gate 2: Pre-Deployment (P1 should-fix) -- RESOLVED

- [x] Proxy health check implemented and tested (M4+M5)
- [x] Docker image pinned to specific version (M3+M4)
- [x] `clearEnv` extended to cover common sensitive variables (M5)
- [x] Latency budget defined: P95 proxy overhead < 500ms, P95 total < 60s (M5)
- [x] `serialize: true` documented prominently with concurrency limitation (M3)

#### Gate 3: Pre-Multi-User (P2 could-fix) -- ADDRESSED

- [x] Docker prerequisite check in wizard (M4)
- [x] Port conflict detection (M4)
- [x] Wizard regression tests for all existing providers (M2)
- [x] End-to-end integration test automated (M7)

### Acceptance Criteria

1. All unit tests pass: `pnpm test`
2. All integration tests pass: `pnpm run test:integration`
3. TypeScript compiles: `tsc --noEmit`
4. Lint passes: `pnpm run lint`
5. Build succeeds: `pnpm run build`
6. No security issues in generated configs
7. All QCSD quality gates verified

### Quality Gate (Final)

- [ ] 100% of unit tests pass
- [ ] 100% of integration tests pass
- [ ] Build succeeds
- [ ] Lint clean
- [ ] Security checklist verified
- [ ] Documentation complete

---

## Risk Mitigation Summary

### Critical Risks from Shift-Left Analysis

| Risk | Score | Milestone | Mitigation |
|------|-------|-----------|-----------|
| R001: GLM-4.7 tool calling instability | 20 | M5 | Health check + FailoverError classification + DISABLE_THINKING=true |
| R002: Proxy SPOF | 16 | M4+M5 | Pre-flight health check with 30s cache + Docker restart policy |
| R003: API key exposure | 15 | M6 | Extended clearEnv + .gitignore enforcement + Docker secrets recommendation |
| R004: serialize:true bottleneck | 12 | M3 | Documented limitation; future ADR for `serialize: false` evaluation |
| R005: AuthChoiceGroupId type mismatch | 12 | M1 | Both definitions updated simultaneously |
| R006: Proxy protocol translation | 12 | M7 | Integration test with mock proxy |
| R007: clearEnv incomplete | 12 | M5 | Extended from 2 to 8 sensitive variable patterns |
| R012: dangerously-skip-permissions | 10 | M6 | Documented as required; tools disabled via prompt; future ADR for --allowedTools |
| R013: Docker image :latest | 9 | M3+M4 | Pinned to specific version |

### Critical Findings from STRIDE Threat Model

| Threat | Severity | Milestone | Mitigation |
|--------|----------|-----------|-----------|
| E-04: Backend command injection | Critical | M6 | Command allowlist validation |
| E-02: Tool disablement bypass | Critical | M6 | Documented; prompt-based only; future hard flag |
| E-01: Docker container escape | Critical | M4 | Security hardening directives in compose |
| I-01: API key in docker inspect | Critical | M4+M6 | .env file, Docker secrets recommendation |
| S-01: Port hijacking | Critical | M6 | Proxy auth token generation (future proxy support) |

### Deferred Items (Out of Scope for This Plan)

| Item | Reason | Future ADR |
|------|--------|-----------|
| Enable selective Claude Code tools | Security implications require workspace isolation | Yes |
| Streaming to end user | Requires CLI runner architecture change | Yes |
| `serialize: false` evaluation | Requires load testing with proxy | Yes |
| Multi-proxy load balancing | Not needed for single-user deployment | Yes |
| Dynamic model routing by complexity | No proxy support for per-request model switching | Yes |
| Prompt injection detection | Cross-cutting concern, not cloudru-specific | Yes |

---

## Implementation Order Summary

```
Week 1:
  Day 1-2: M1 (Type Foundation)        -- S effort, no dependencies
  Day 2-3: M3 (Constants/Model Mapping) -- S effort, depends on M1
  Day 3-5: M2 (Wizard Flow)            -- M effort, depends on M1
           (M2 and M3 can run in parallel)

Week 2:
  Day 1-3: M4 (Proxy Lifecycle)         -- M effort, depends on M2+M3
  Day 3-5: M5 (Health/Fallback)         -- M effort, depends on M3+M4

Week 3:
  Day 1-2: M6 (Security Hardening)      -- S effort, depends on M4+M5
  Day 2-5: M7 (Integration Testing)     -- L effort, depends on M1-M6
```

**Total estimated calendar time:** 2-3 weeks
**Total estimated effort:** ~40-60 hours

---

## File Inventory

### Files to Create (6 new files)

| File | Milestone | Lines | Purpose |
|------|-----------|-------|---------|
| `upstream/src/config/cloudru-fm.constants.ts` | M3 | ~60 | Centralized model IDs and presets |
| `upstream/src/commands/auth-choice.apply.cloudru-fm.ts` | M2 | ~120 | Auth choice handler |
| `upstream/src/commands/onboard-cloudru-fm.ts` | M2 | ~100 | Wizard utilities (Docker compose, .env) |
| `upstream/src/agents/proxy-health.ts` | M4 | ~90 | Health check with caching |
| `upstream/src/commands/proxy-docker.ts` | M4 | ~130 | Docker prerequisite checks + compose generation |
| `upstream/src/agents/proxy-security.ts` | M6 | ~60 | Security validation utilities |

### Files to Modify (5 existing files)

| File | Milestone | Change |
|------|-----------|--------|
| `upstream/src/commands/onboard-types.ts` | M1 | Add 3 AuthChoice values + 1 AuthChoiceGroupId + OnboardOptions field |
| `upstream/src/commands/auth-choice-options.ts` | M1 | Add 1 AuthChoiceGroupId + 1 group def + 3 choice options |
| `upstream/src/commands/auth-choice.apply.ts` | M2 | Import + register cloudru-fm handler |
| `upstream/src/commands/configure.gateway-auth.ts` | M2 | Add cloudru-fm dispatch before custom-api-key |
| `upstream/src/agents/cli-backends.ts` | M5 | Extend clearEnv array |
| `upstream/src/agents/cli-runner.ts` | M5 | Add pre-flight proxy health check |

### Test Files to Create (8 new test files)

| File | Milestone | Coverage |
|------|-----------|---------|
| `tests/commands/auth-choice-options.cloudru-fm.test.ts` | M1 | Type extensions, group definitions |
| `tests/config/cloudru-fm.constants.test.ts` | M3 | Model IDs, presets, invariants |
| `tests/commands/auth-choice.apply.cloudru-fm.test.ts` | M2 | Handler dispatch, config application |
| `tests/commands/onboard-cloudru-fm.test.ts` | M2 | Docker compose generation, .env writing |
| `tests/agents/proxy-health.test.ts` | M4 | Health check, caching, error handling |
| `tests/commands/proxy-docker.test.ts` | M4 | Docker checks, port checks, YAML generation |
| `tests/agents/proxy-security.test.ts` | M6 | URL validation, command allowlist |
| `tests/integration/cloudru-fm-e2e.test.ts` | M7 | End-to-end integration |

---

## Appendix A: ADR Amendment Recommendations

These amendments should be applied to the ADRs BEFORE implementation begins (as pre-implementation documentation cleanup).

### ADR-001 Amendment

Replace Positive Consequences line:
> "Full multi-agent architecture available (tool calling, MCP, sessions)"

With:
> "Claude Code multi-step reasoning pipeline available (sessions, system prompts, JSON output). Note: Claude Code tool use (file ops, bash) is disabled per ADR-003."

### ADR-002 Amendment

1. Replace integration point 3:
   > ~~`configure.gateway-auth.ts:60` -- Add dispatch for cloudru-fm-* choices~~

   With:
   > `auth-choice.apply.ts:43-55` -- Add `applyAuthChoiceCloudruFm` to the handlers array
   > `configure.gateway-auth.ts:59-60` -- Add pre-check for cloudru-fm-* choices before custom-api-key

2. Rename function:
   > ~~`applyCloudruFmChoice`~~ -> `applyAuthChoiceCloudruFm`

3. Add integration point:
   > Both `AuthChoiceGroupId` definitions (in `onboard-types.ts` AND `auth-choice-options.ts`) must include `"cloudru-fm"`

### ADR-005 Amendment

Rewrite the Fallback Chain section:

```
Fallback chain (Claude Code tier names -> proxy mapping):

  opus (BIG_MODEL) -> sonnet (MIDDLE_MODEL) -> haiku (SMALL_MODEL) -> ERROR

For the "GLM-4.7 Full" preset:
  opus=GLM-4.7 -> sonnet=GLM-4.7-FlashX -> haiku=GLM-4.7-Flash -> ERROR

For the "Qwen3-Coder" preset:
  opus=Qwen3-Coder-480B -> sonnet=GLM-4.7-FlashX -> haiku=GLM-4.7-Flash -> ERROR

Config: agents.defaults.model.fallbacks = ["claude-cli/sonnet", "claude-cli/haiku"]
```

---

## Appendix B: Shift-Left Issue Cross-Reference

| Issue ID | Severity | Resolution Milestone | Status |
|----------|----------|---------------------|--------|
| CRITICAL-001 | Critical | ADR Amendment (Appendix A) | Documented |
| CRITICAL-002 | Critical | M2 | Resolved |
| CRITICAL-003 | Critical | M2 | Resolved |
| CRITICAL-004 | Critical | M4+M5 | Resolved |
| CRITICAL-005 | Critical | M4 (simplified to stateless) | Resolved |
| CRITICAL-006 | Critical | M3+M5 | Resolved |
| CRITICAL-007 | Critical | M3 | Resolved |
| WARNING-001 | Warning | M5 | Resolved |
| WARNING-002 | Warning | M3 (documented) | Documented |
| WARNING-003 | Warning | M4 (documented in compose) | Documented |
| WARNING-004 | Warning | M1 | Resolved |
| WARNING-005 | Warning | M1 (verified count) | Resolved |
| WARNING-006 | Warning | ADR Amendment | Documented |
| WARNING-007 | Warning | M5 (timeout in health check) | Resolved |
| WARNING-008 | Warning | M4 | Resolved |
| WARNING-009 | Warning | M4 | Resolved |
| WARNING-010 | Warning | M3 (centralized constants) | Resolved |
| WARNING-011 | Warning | M5 (logging in classifyFailoverReason) | Resolved |
| X-001 | Critical | ADR Amendment | Documented |
| X-002 | Warning | M2+M4 (clear boundary) | Resolved |
| X-003 | Critical | M3+M5 | Resolved |
| X-004 | Warning | M7 | Resolved |
| X-005 | Warning | M1 | Resolved |
