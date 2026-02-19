# Brutal-Honesty Code Review: Cloud.ru FM Integration

| Field             | Value                                       |
| ----------------- | ------------------------------------------- |
| **Date**          | 2026-02-13                                  |
| **Reviewer**      | Senior Code Review Agent                    |
| **Scope**         | 10 implementation files (7 new, 3 modified) |
| **Context Files** | 4 existing files + 2 design docs            |

---

## 1. VERDICT: CONDITIONAL PASS

## 2. Score: 68/100

This is competent work with a clear understanding of the codebase patterns, but it has significant structural defects that would cause runtime failures. The implementation looks like someone who read the docs thoroughly and then coded without compiling. Several files are dead code (never imported), two Docker Compose templates exist with contradictory configurations, a type literal that does not exist in the union type would fail `tsc --strict`, and the `CLOUDRU_CLEAR_ENV_EXTRAS` constant is exported but never consumed by any code. The good parts are genuinely good. The bad parts would break the build.

---

## 3. Critical Issues (Must Fix Before Merge)

### CRIT-01: `ensureProxyHealthy` in `cloudru-proxy-health.ts` throws plain Error -- but it is NEVER CALLED anywhere

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-proxy-health.ts`

The entire `cloudru-proxy-health.ts` file is dead code. No file in the implementation imports `checkProxyHealth`, `ensureProxyHealthy`, or `clearProxyHealthCache`. Grep confirms zero references to `cloudru-proxy-health` across the entire codebase.

The IMPLEMENTATION-PLAN.md (M5) specifies that a pre-flight health check should be inserted into `cli-runner.ts` after backend resolution. **This was never done.** The `cli-runner.ts` file was not modified. The proxy health check -- the entire point of BLOCKING GAP #4 and CRITICAL-004 from the shift-left analysis -- exists only as an orphaned module.

**Impact:** Proxy failures will result in opaque subprocess errors instead of actionable diagnostics. The 30-second cache optimization is wasted. The design goal of preventing model fallback on proxy failure is completely unimplemented.

**Fix:** Import and call `ensureProxyHealthy(proxyUrl)` inside `cli-runner.ts` after `resolveCliBackendConfig()` completes and before subprocess spawn (approximately after line 76). The call should be conditional on `backend.env?.ANTHROPIC_BASE_URL` containing `"localhost"`.

---

### CRIT-02: `cloudru-model-mapping.ts` is dead code -- never imported anywhere

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-model-mapping.ts`

This file exports `CLOUDRU_MODEL_PRESETS`, `CLOUDRU_FALLBACK_CHAINS`, `getCloudruFallbackChain()`, and `resolveCloudruPreset()`. Grep confirms zero imports from `cloudru-model-mapping` anywhere in the codebase. The file duplicates preset definitions already in `cloudru-fm.constants.ts` (using a different key format: `"glm47-full"` vs `"cloudru-fm-glm47"`).

The `CLOUDRU_FALLBACK_CHAINS` data structure is conceptually useful (per-model fallback within proxy tiers), but nothing reads it. The `resolveCloudruPreset()` function duplicates `resolveCloudruModelPreset()` in `onboard-cloudru-fm.ts` but with a different return behavior (`undefined` vs throw).

**Impact:** 95 lines of untested, unused code that creates confusion about the canonical source of truth for model presets. Two files define "presets" with different key names and different behaviors.

**Fix:** Either delete this file entirely (the constants file already serves as single source of truth) or wire it into the proxy template generation and health check modules. If kept, reconcile the preset key naming (`"glm47-full"` vs `"cloudru-fm-glm47"`) and eliminate the duplication with `onboard-cloudru-fm.ts`.

---

### CRIT-03: `cloudru-proxy-template.ts` is dead code -- never imported anywhere

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-proxy-template.ts`

This file exports `generateProxyDockerCompose()` and `CLOUDRU_COMPOSE_FILENAME`. Grep confirms zero references to `cloudru-proxy-template` anywhere. Meanwhile, `onboard-cloudru-fm.ts` (line 66) has its OWN `generateDockerComposeTemplate()` function that produces a DIFFERENT Docker Compose template.

The two templates are contradictory:

| Aspect           | `cloudru-proxy-template.ts`             | `onboard-cloudru-fm.ts`                   |
| ---------------- | --------------------------------------- | ----------------------------------------- |
| Service name     | `claude-code-proxy`                     | `cloudru-proxy`                           |
| Container name   | `claude-code-proxy`                     | `openclaw-cloudru-proxy`                  |
| Docker image     | `legard/claude-code-proxy:v1.0.0`       | `ghcr.io/nicepkg/cloudru-fm-proxy:v1.0.0` |
| Internal port    | `8082`                                  | `8080`                                    |
| API base URL env | `API_BASE_URL`                          | Not present                               |
| API key env      | `API_KEY: "${CLOUDRU_API_KEY}"`         | `CLOUDRU_API_KEY: "${CLOUDRU_API_KEY}"`   |
| Health check     | `curl -sf http://localhost:8082/health` | Not present                               |
| User directive   | `user: "1000:1000"`                     | Not present                               |
| `version` key    | Not present                             | `version: "3.8"` (deprecated)             |

**Impact:** Two completely different Docker Compose configurations, one of which is dead. The live one (`onboard-cloudru-fm.ts`) uses a different Docker image, a different internal port, no health check, no user directive, and the deprecated `version` key. The dead one (`cloudru-proxy-template.ts`) has better security posture but is never used.

**Fix:** Delete one template. The `cloudru-proxy-template.ts` version is more complete (health check, user directive, no deprecated version key), so if anything, `onboard-cloudru-fm.ts` should import from it rather than defining its own. But the Docker image and internal port must be reconciled first -- only one can be correct.

---

### CRIT-04: `cloudru-rollback.ts` is dead code -- never imported anywhere

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/cloudru-rollback.ts`

Grep confirms zero references to `cloudru-rollback` or `rollbackCloudruFmConfig` anywhere. This was supposed to resolve BLOCKING GAP #3 ("No rollback procedures defined") but the function is never wired into any command, CLI handler, or wizard flow.

**Impact:** Rollback capability exists on paper but is completely inaccessible to users. BLOCKING GAP #3 from REQUIREMENTS-VALIDATION remains unresolved in practice.

**Fix:** Wire `rollbackCloudruFmConfig` into a CLI command or expose it through the wizard. At minimum, document how a user can invoke it manually (e.g., `npx openclaw cloudru-rollback` or similar).

---

### CRIT-05: `auth-choice.apply.cloudru-fm.ts` accesses `opts.cloudruApiKey` but the `ApplyAuthChoiceParams.opts` type does NOT include `cloudruApiKey`

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice.apply.cloudru-fm.ts`, line 46

```typescript
const optsKey = (params.opts as Record<string, unknown> | undefined)?.cloudruApiKey;
```

The `ApplyAuthChoiceParams` type (in `auth-choice.apply.ts` lines 26-33) defines `opts` as:

```typescript
opts?: {
  tokenProvider?: string;
  token?: string;
  cloudflareAiGatewayAccountId?: string;
  cloudflareAiGatewayGatewayId?: string;
  cloudflareAiGatewayApiKey?: string;
  xaiApiKey?: string;
};
```

There is no `cloudruApiKey` property. The implementation casts `params.opts` to `Record<string, unknown>` to bypass type checking -- this is a deliberate escape hatch around the type system.

Compare with the XAI handler (`auth-choice.apply.xai.ts` line 37) which accesses `params.opts?.xaiApiKey` directly because `xaiApiKey` IS in the type definition. The cloudru-fm handler is cheating.

Meanwhile, `OnboardOptions` in `onboard-types.ts` line 110 correctly defines `cloudruApiKey?: string`, but `OnboardOptions` is not the same type as `ApplyAuthChoiceParams.opts`.

**Impact:** Under `tsc --strict`, this cast is legal but defeats the purpose of TypeScript. More importantly, there is no path from `OnboardOptions.cloudruApiKey` to `ApplyAuthChoiceParams.opts.cloudruApiKey` -- the data never flows. Non-interactive mode (`--cloudruApiKey` flag) silently fails because the opts bridge is missing.

**Fix:** Add `cloudruApiKey?: string;` to the `ApplyAuthChoiceParams.opts` type definition, and remove the `Record<string, unknown>` cast. Then verify the CLI argument parsing actually passes it through.

---

### CRIT-06: `CLOUDRU_CLEAR_ENV_EXTRAS` is defined but never consumed

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/config/cloudru-fm.constants.ts`, lines 89-96

```typescript
export const CLOUDRU_CLEAR_ENV_EXTRAS: readonly string[] = [
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "AWS_SECRET_ACCESS_KEY",
  "AZURE_OPENAI_API_KEY",
  "CLOUDRU_API_KEY",
] as const;
```

This constant is never imported by any file. Grep confirms the only reference is in the definition file itself. The IMPLEMENTATION-PLAN M5 specified extending `clearEnv` in `DEFAULT_CLAUDE_BACKEND` to include these values. This was never done -- `cli-backends.ts` still has the original two-entry `clearEnv`:

```typescript
clearEnv: ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"],
```

The REQUIREMENTS-VALIDATION (GAP-02) specifically warned that modifying the global `DEFAULT_CLAUDE_BACKEND` would be dangerous and suggested using `mergeBackendConfig()` instead. Neither approach was implemented.

**Impact:** When the proxy is configured, the `claude` subprocess will inherit the user's `CLOUDRU_API_KEY`, `OPENAI_API_KEY`, etc. from the process environment. This is the exact security gap that R007 identified. The `CLOUDRU_API_KEY` is particularly dangerous -- it could leak through the subprocess to Claude's telemetry.

**Fix:** In `auth-choice.apply.cloudru-fm.ts`, add the extended `clearEnv` to the cloudru-fm-specific backend override config (not the global default). This is the GAP-02 option (c) approach:

```typescript
"claude-cli": {
  ...existingConfig,
  env: { ... },
  clearEnv: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY_OLD",
    ...CLOUDRU_CLEAR_ENV_EXTRAS,
  ],
},
```

---

### CRIT-07: `ensureProxyHealthy` throws plain Error, but `FailoverReason` type does not include `"proxy-unhealthy"`

**Files:**

- `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-proxy-health.ts` (lines 87-97)
- `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/pi-embedded-helpers/types.ts`

The `FailoverReason` union type is:

```typescript
export type FailoverReason = "auth" | "format" | "rate_limit" | "billing" | "timeout" | "unknown";
```

The IMPLEMENTATION-PLAN M5 specifies throwing `FailoverError` with reason `"proxy-unhealthy"` -- a value that DOES NOT EXIST in the `FailoverReason` type. This would be a compile error.

The current implementation in `cloudru-proxy-health.ts` works around this by throwing a plain `Error` instead of `FailoverError`. The design comment says this is intentional (plain errors bypass the fallback loop). However, this means the `resolveFailoverStatus()` function in `failover-error.ts` returns `undefined` for the switch default case, meaning there is no HTTP status code associated with the failure.

**Impact:** The workaround is actually architecturally sound (plain Error to bypass fallback), but it contradicts the IMPLEMENTATION-PLAN which specifies `FailoverError`. If someone later "fixes" this to use `FailoverError` per the plan, they'll hit a type error or, worse, trigger pointless fallback cycling through sonnet/haiku against the same dead proxy. The `FailoverReason` type was never extended to include `"proxy-unhealthy"`, which means the plan's M5 error classification additions (`classifyFailoverReason`) were also never implemented.

**Fix:** Either: (a) document that plain Error is the correct behavior and update the IMPLEMENTATION-PLAN, or (b) add `"proxy-unhealthy"` to `FailoverReason` and handle it specially in `model-fallback.ts` to skip fallback when all candidates share the same proxy URL.

---

## 4. Major Issues (Should Fix Before Merge)

### MAJ-01: Duplicate `CloudruModelPreset` type definition

**Files:**

- `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/config/cloudru-fm.constants.ts` (lines 23-34)
- `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts` (lines 8-19)

Two identical `CloudruModelPreset` types are defined. The constants file exports one. The onboard file defines its own locally (not exported by that name, but the `resolveCloudruModelPreset` function returns it). The auth-choice handler imports from `onboard-cloudru-fm.ts`, not from `cloudru-fm.constants.ts`.

The Docker template file (`cloudru-proxy-template.ts`) imports `CloudruModelPreset` from `cloudru-fm.constants.ts`. But since it is dead code (CRIT-03), this import is never exercised.

**Impact:** Two divergent sources of truth for the same type. If one is modified (e.g., adding a `contextWindow` field), the other will not follow. This violates DRY and the IMPLEMENTATION-PLAN's own M3 goal of "centralized constants as single source of truth."

**Fix:** Delete the type definition in `onboard-cloudru-fm.ts` and import `CloudruModelPreset` from `../config/cloudru-fm.constants.js`. Update the local `CLOUDRU_PRESETS` record to use the imported type.

---

### MAJ-02: Duplicate preset data -- three independent preset definitions

**Files:**

1. `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/config/cloudru-fm.constants.ts` -- `CLOUDRU_FM_PRESETS` (keys: `"cloudru-fm-glm47"`, `"cloudru-fm-flash"`, `"cloudru-fm-qwen"`)
2. `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts` -- `CLOUDRU_PRESETS` (keys: `"cloudru-fm-glm47"`, `"cloudru-fm-flash"`, `"cloudru-fm-qwen"`)
3. `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-model-mapping.ts` -- `CLOUDRU_MODEL_PRESETS` (keys: `"glm47-full"`, `"glm47-flash-free"`, `"qwen3-coder"`)

Three copies of essentially the same data with slightly different key names. The constants file labels are also different from the onboard file labels:

| Preset | constants.ts label       | onboard-cloudru-fm.ts label        |
| ------ | ------------------------ | ---------------------------------- |
| glm47  | `"GLM-4.7 (Full)"`       | `"GLM-4.7 (recommended)"`          |
| flash  | `"GLM-4.7-Flash (Free)"` | `"GLM-4.7 Flash (free tier)"`      |
| qwen   | `"Qwen3-Coder-480B"`     | `"Qwen3-Coder (coding-optimized)"` |

**Impact:** Label inconsistency means the wizard displays different text depending on which code path resolves the preset. If the `auth-choice.apply.cloudru-fm.ts` handler calls `resolveCloudruModelPreset()` from `onboard-cloudru-fm.ts`, the user sees "GLM-4.7 (recommended)". If anything were to use the constants file, they'd see "GLM-4.7 (Full)".

**Fix:** Use `CLOUDRU_FM_PRESETS` from `cloudru-fm.constants.ts` as the ONLY source. Delete `CLOUDRU_PRESETS` from `onboard-cloudru-fm.ts` and `CLOUDRU_MODEL_PRESETS` from `cloudru-model-mapping.ts`. Have `resolveCloudruModelPreset()` import from the constants file.

---

### MAJ-03: `onboard-cloudru-fm.ts` Docker Compose template uses deprecated `version: "3.8"` key

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, line 73

```yaml
version: "3.8"
```

Docker Compose v2 (the current standard as of Docker Compose v2.20+) explicitly warns that the `version` key is obsolete and ignored. Including it causes a deprecation warning on every `docker compose` invocation, which will confuse users.

The dead `cloudru-proxy-template.ts` correctly omits this key.

**Impact:** Every `docker compose up` prints a deprecation warning. Unprofessional and noisy.

**Fix:** Remove the `version: "3.8"` line from the template.

---

### MAJ-04: `onboard-cloudru-fm.ts` Docker Compose template missing health check

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, lines 66-101

The active Docker Compose template (the one actually used by the wizard) has no `healthcheck` directive. The IMPLEMENTATION-PLAN M4 explicitly requires:

```yaml
healthcheck:
  test: ["CMD", "curl", "-sf", "http://localhost:8082/health"]
  interval: 10s
  timeout: 5s
  retries: 3
  start_period: 10s
```

This is present in the dead `cloudru-proxy-template.ts` but absent from the live template. Docker will not report the container as healthy/unhealthy, and `docker compose ps` will show "Up" instead of "Up (healthy)".

**Impact:** No Docker-level health monitoring. If the proxy process inside the container crashes but the container stays running, Docker will not restart it. The `restart: unless-stopped` policy only triggers on container exit, not on process failure within a running container.

**Fix:** Add the `healthcheck` block to the template in `onboard-cloudru-fm.ts`.

---

### MAJ-05: `onboard-cloudru-fm.ts` Docker Compose template missing `user: "1000:1000"` directive

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, lines 66-101

The IMPLEMENTATION-PLAN M6 specifies running the container as non-root with `user: "1000:1000"`. This is present in the dead template but absent from the live one. The container runs as root by default.

**Impact:** Reduced defense-in-depth. Container breakout attacks are more impactful when running as root. This was a specific STRIDE finding (E-01).

**Fix:** Add `user: "1000:1000"` to the template.

---

### MAJ-06: `.env` file written without restrictive permissions

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, line 129

```typescript
await fs.writeFile(envPath, content, "utf-8");
```

The `.env` file containing the cloud.ru API key is written with default permissions (typically 0o644 on Linux -- world-readable). Compare with the rollback file (`cloudru-rollback.ts` line 94) which correctly uses `mode: 0o600`:

```typescript
await fs.promises.writeFile(configPath, json, { encoding: "utf-8", mode: 0o600 });
```

**Impact:** The API key is readable by any user on the system. On shared development servers, this is a credential exposure risk.

**Fix:** Change to:

```typescript
await fs.writeFile(envPath, content, { encoding: "utf-8", mode: 0o600 });
```

---

### MAJ-07: Health check caches negative results for 30 seconds

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-proxy-health.ts`, lines 60-73

Both successful AND failed health checks are cached for 30 seconds:

```typescript
// On success:
cachedResult = { url: proxyUrl, result, expiresAt: Date.now() + CACHE_TTL_MS };
// On failure:
cachedResult = { url: proxyUrl, result, expiresAt: Date.now() + CACHE_TTL_MS };
```

If the proxy temporarily goes down and comes back up 5 seconds later, the cached failure result will prevent all requests for the remaining 25 seconds.

**Impact:** A brief proxy hiccup (e.g., during Docker restart) causes a 30-second blackout window where all requests fail immediately.

**Fix:** Use a shorter TTL for negative results (e.g., 5 seconds) or do not cache failures:

```typescript
if (!result.ok) {
  // Don't cache failures -- allow immediate retry after recovery
  return result;
}
cachedResult = { url: proxyUrl, result, expiresAt: Date.now() + CACHE_TTL_MS };
```

---

### MAJ-08: Module-level mutable state for health cache is not concurrency-safe

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-proxy-health.ts`, line 27

```typescript
let cachedResult: { url: string; result: ProxyHealthResult; expiresAt: number } | null = null;
```

Module-level mutable singleton. If two async calls to `checkProxyHealth` execute concurrently (e.g., in Node.js event loop interleaving during the `await fetch`), the first call's cache write can be overwritten by the second before the first caller reads it. More importantly, both calls will fire HTTP requests simultaneously, defeating the cache purpose.

While `serialize: true` in the CLI backend config means sequential agent runs, the health check could be called from other contexts (test setup, wizard flow, background monitoring).

**Impact:** Theoretical race condition under concurrent access. Low probability in current single-threaded usage but fragile.

**Fix:** Add an in-flight promise guard:

```typescript
let inflightPromise: Promise<ProxyHealthResult> | null = null;

export async function checkProxyHealth(proxyUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (cachedResult && cachedResult.url === proxyUrl && Date.now() < cachedResult.expiresAt) {
    return cachedResult.result;
  }
  if (!inflightPromise) {
    inflightPromise = doCheck(proxyUrl, timeoutMs).finally(() => {
      inflightPromise = null;
    });
  }
  return inflightPromise;
}
```

---

## 5. Minor Issues (Nice to Fix)

### MIN-01: `auth-choice.apply.cloudru-fm.ts` uses string literal `"anthropic-messages"` without verifying it is a valid `api` value

Line 98: `api: "anthropic-messages" as const`

The `as const` cast suggests the author was not sure this was a valid value for the `api` field. Without checking the `OpenClawConfig` type's model provider schema, this could silently produce a config value that is ignored at runtime.

---

### MIN-02: `cloudru-proxy-health.ts` health check URL construction is fragile

Line 53:

```typescript
const healthUrl = proxyUrl.replace(/\/+$/, "") + "/health";
```

This handles trailing slashes but not schemes, ports, or paths. If `proxyUrl` is `"http://localhost:8082/v1"`, the health URL becomes `"http://localhost:8082/v1/health"` instead of `"http://localhost:8082/health"`. Using the `URL` constructor would be safer.

---

### MIN-03: `cloudru-rollback.ts` imports `JSON5` for config parsing

Line 13: `import JSON5 from "json5";`

If the codebase does not already depend on `json5`, this adds a new dependency. If it does, this is fine. But the rollback writes back using `JSON.stringify`, not `JSON5.stringify`, which means comments and trailing commas in the original file are silently stripped on rollback.

---

### MIN-04: `auth-choice.apply.cloudru-fm.ts` hardcodes `contextWindow: 128_000` for all models

Lines 103, 112, 121: `contextWindow: 128_000`

GLM-4.7 actually supports 200K context (the wizard hint even says "200K context"). Hardcoding 128K for all three tiers is incorrect for the GLM-4.7 Full preset. This should come from model-specific data, not a blanket constant.

---

### MIN-05: `auth-choice.apply.cloudru-fm.ts` sets all costs to zero

Lines 106, 115, 124: `cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }`

This means the cost tracking and budget features will report zero spend for cloud.ru FM usage, even though the paid tier (GLM-4.7, Qwen3-Coder) has non-zero costs. This is acceptable for the free tier preset but misleading for paid presets.

---

### MIN-06: No input validation on API key in `auth-choice.apply.cloudru-fm.ts`

The handler accepts `optsKey` from process environment or CLI flags without any format validation (other than `validateApiKeyInput` on the interactive path). The non-interactive path (`optsKey` from opts, `envValue` from environment) does not call `validateApiKeyInput`.

Compare with the interactive path at line 79 which does validate. The env path at lines 54-56 accepts the key without validation.

---

### MIN-07: `ensureGitignoreEntries` does not handle comment lines or negation patterns

**File:** `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, lines 141-162

The function checks for exact line matches. If `.gitignore` contains `# .env` (a commented-out entry), the Set will include `"# .env"`, and `.env` will correctly be identified as missing. But if `.gitignore` contains `!.env` (a negation pattern), the function will add `.env` below the negation, which in gitignore semantics means the negation is overridden and `.env` is now ignored. This is the desired behavior but is accidental rather than intentional.

---

### MIN-08: `auth-choice.apply.cloudru-fm.ts` line 93 uses fallback `mode: nextConfig.models?.mode ?? "merge"` without understanding implications

If the user already had `mode: "replace"` set, this preserves it. But `"merge"` as a default for a proxy integration is questionable -- it means the cloud.ru FM provider is merged alongside existing providers, which could cause model ID collisions if another provider also defines `opus`/`sonnet`/`haiku` model IDs.

---

## 6. What's Good (Credit Where Due)

### GOOD-01: The auth-choice handler pattern is correctly followed

`auth-choice.apply.cloudru-fm.ts` correctly implements the null-return-if-not-mine pattern, correctly accesses `params.prompter` for interactive prompts, and correctly returns `{ config: nextConfig }`. The handler is registered last in the array (line 56 of `auth-choice.apply.ts`), which is the correct position for a new provider that should not shadow earlier handlers.

### GOOD-02: The type system modifications are clean and complete

`onboard-types.ts` correctly adds all three `AuthChoice` values and the `AuthChoiceGroupId` value. `auth-choice-options.ts` correctly adds the group definition with all three choices, and adds the individual choice options to `buildAuthChoiceOptions()`. Both `AuthChoiceGroupId` definitions (the duplicate in `onboard-types.ts` and `auth-choice-options.ts`) include `"cloudru-fm"`. This is the X-005 fix done correctly.

### GOOD-03: `.gitignore` management is idempotent and defensive

`ensureGitignoreEntries()` correctly reads existing entries, deduplicates, and only appends missing ones. It handles the case where `.gitignore` does not exist yet. The wizard adds both `.env` and `docker-compose.cloudru-proxy.yml` to `.gitignore`, which prevents accidental credential and infrastructure commits.

### GOOD-04: Sentinel key approach is sound

Using `"not-a-real-key-proxy-only"` as the `ANTHROPIC_API_KEY` value in the config is the correct pattern -- the Claude CLI requires a non-empty key, but the proxy ignores it. The key name makes it obvious this is not a real credential, reducing the chance of incident reports about "leaked keys."

### GOOD-05: `cloudru-proxy-health.ts` error handling is thorough

The health check correctly handles timeouts (via `AbortController`), HTTP errors (non-2xx status codes), and network errors (ECONNREFUSED). It never throws (returns result objects), which is good API design. The `clearProxyHealthCache()` export for test cleanup is a thoughtful addition.

### GOOD-06: Rollback function is well-designed

`cloudru-rollback.ts` is idempotent, handles missing files gracefully, uses JSON5 for reading (supporting comments in config), cleans up empty objects after deletion, and writes with restrictive permissions (0o600). The scope of cleanup is appropriate -- it removes only what the wizard added and leaves user-configured settings alone.

### GOOD-07: The constants file (`cloudru-fm.constants.ts`) is well-organized

Single source of truth for model IDs, with `as const` for type narrowing. The `CLOUDRU_FM_MODELS` record provides friendly short names mapped to full API model IDs, and the presets reference these consistently. The SMALL_MODEL invariant (always GLM-4.7-Flash per ADR-005) is maintained across all three presets.

### GOOD-08: Security hardening in the dead Docker template is excellent

The dead `cloudru-proxy-template.ts` has: `no-new-privileges`, `cap_drop: ALL`, `read_only: true`, `user: 1000:1000`, resource limits, health check, localhost-only binding, and no embedded secrets. If this were the actual template, the security posture would be strong.

---

## 7. Specific Fix Instructions

### For CRIT-01 (Health check never called):

In `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cli-runner.ts`, after line 76 (`const backend = backendResolved.config;`), add:

```typescript
// Pre-flight proxy health check for backends routing through a local proxy.
const proxyBaseUrl = backend.env?.ANTHROPIC_BASE_URL;
if (proxyBaseUrl && /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(proxyBaseUrl)) {
  const { ensureProxyHealthy } = await import("./cloudru-proxy-health.js");
  await ensureProxyHealthy(proxyBaseUrl);
}
```

### For CRIT-02, CRIT-03 (Dead files):

Delete:

- `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-model-mapping.ts`
- `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/agents/cloudru-proxy-template.ts`

Or wire them in by having `onboard-cloudru-fm.ts` import from them instead of defining its own duplicates.

### For CRIT-04 (Rollback never called):

Create a command entry point or add to an existing CLI command that calls:

```typescript
import { rollbackCloudruFmConfig } from "./cloudru-rollback.js";
await rollbackCloudruFmConfig(configPath);
```

### For CRIT-05 (opts type mismatch):

In `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice.apply.ts`, add `cloudruApiKey?: string;` to the `opts` type:

```typescript
opts?: {
  tokenProvider?: string;
  token?: string;
  cloudflareAiGatewayAccountId?: string;
  cloudflareAiGatewayGatewayId?: string;
  cloudflareAiGatewayApiKey?: string;
  xaiApiKey?: string;
  cloudruApiKey?: string;  // <-- add this
};
```

Then in `auth-choice.apply.cloudru-fm.ts`, line 46, remove the cast:

```typescript
const optsKey = params.opts?.cloudruApiKey;
```

### For CRIT-06 (clearEnv not applied):

In `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/auth-choice.apply.cloudru-fm.ts`, inside the `cliBackends` config object, add `clearEnv`:

```typescript
import { CLOUDRU_CLEAR_ENV_EXTRAS } from "../config/cloudru-fm.constants.js";

// In the cliBackends override:
"claude-cli": {
  ...nextConfig.agents?.defaults?.cliBackends?.["claude-cli"],
  command: nextConfig.agents?.defaults?.cliBackends?.["claude-cli"]?.command ?? "claude",
  env: {
    ...nextConfig.agents?.defaults?.cliBackends?.["claude-cli"]?.env,
    ANTHROPIC_BASE_URL: CLOUDRU_PROXY_BASE_URL,
    ANTHROPIC_API_KEY: PROXY_SENTINEL_KEY,
  },
  clearEnv: [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_API_KEY_OLD",
    ...CLOUDRU_CLEAR_ENV_EXTRAS,
  ],
},
```

### For MAJ-03 (deprecated version key):

In `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, remove the `version: "3.8"` line from the template string at line 73.

### For MAJ-06 (.env permissions):

In `/home/user/ceo-vibe-coding/src/openclaw-extended/upstream/src/commands/onboard-cloudru-fm.ts`, line 129, change:

```typescript
await fs.writeFile(envPath, content, "utf-8");
```

to:

```typescript
await fs.writeFile(envPath, content, { encoding: "utf-8", mode: 0o600 });
```

---

## 8. Implementation Plan Coverage Assessment

### Milestones Implemented vs Planned

| Milestone                   | Status                  | Notes                                                                                                                         |
| --------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| M1: Type Foundation         | DONE                    | `onboard-types.ts` and `auth-choice-options.ts` correctly extended                                                            |
| M2: Wizard Onboarding       | MOSTLY DONE             | Auth handler works; Docker template has defects (MAJ-03/04/05); `configure.gateway-auth.ts` NOT modified per plan             |
| M3: Constants/Model Mapping | DONE (with duplication) | Constants file is correct; model-mapping file is dead code                                                                    |
| M4: Proxy Lifecycle         | PARTIALLY DONE          | Health check module exists but is dead code; proxy-docker.ts was never created; Docker template is in wrong file with defects |
| M5: Health/Fallback         | NOT DONE                | cli-runner.ts was not modified; clearEnv not extended; classifyFailoverReason not extended                                    |
| M6: Security Hardening      | NOT DONE                | proxy-security.ts was never created; URL validation not added to cli-backends.ts                                              |
| M7: Integration Testing     | NOT DONE                | No test files created                                                                                                         |

### BLOCKING GAPs from REQUIREMENTS-VALIDATION

| Gap                                                 | Status             | Notes                                                                                                                                        |
| --------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-01: Dual dispatch ambiguity                     | AVOIDED            | Only the handler chain path was implemented; `configure.gateway-auth.ts` was not modified. This is actually the simpler and better approach. |
| GAP-02: clearEnv global scope                       | UNRESOLVED         | Neither the global nor the scoped approach was implemented                                                                                   |
| GAP-03: No rollback procedure                       | PARTIALLY RESOLVED | Rollback function exists but is dead code (CRIT-04)                                                                                          |
| GAP-04: FailoverError proxy-unhealthy contradiction | PARTIALLY RESOLVED | Plain Error approach taken (correct), but never wired in (CRIT-01)                                                                           |

---

## 9. Summary Table

| Category        | Count |
| --------------- | :---: |
| Critical Issues |   7   |
| Major Issues    |   8   |
| Minor Issues    |   8   |
| Strengths       |   8   |

The implementation has a solid foundation -- the type system changes, the auth handler, and the constants file are well-done. But roughly 50% of the new code (3 out of 7 new files) is completely dead, the live Docker template is missing security features that exist in the dead template, and the two most important M5 integration points (health check in cli-runner.ts, clearEnv extension) were never implemented. The code reads like milestones M1-M3 were completed, M4 was partially done, and M5-M7 were abandoned mid-flight.

Fix the 7 critical issues, consolidate the duplicate type/preset definitions, and this becomes a solid integration.
