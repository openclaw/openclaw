# Stage 1: AI Provider Auth → Cortex Apollo

> Strip Athena's auth-profiles system and route all LLM calls through Cortex Apollo.

**Status**: Not started
**Depends on**: Cortex deployed and healthy at `cortex-bice.vercel.app`
**Reference**: [Cortex ATHENA_CORTEX_INTEGRATION.md](../../Cortex/docs/athena/ATHENA_CORTEX_INTEGRATION.md)

---

## Context

Athena's LLM call chain currently has **5 layers of auth resolution** before an API call is made:

```
Config (athena.json)
  → Model Selection (model-selection.ts)
    → Auth Profile Resolution (model-auth.ts → auth-profiles/*)
      → Pi Auth JSON Bridge (pi-auth-json.ts)
        → Pi-Agent-Core Model Registry
          → Actual API Call
```

The auth-profiles system (`src/agents/auth-profiles/`, 17 files) handles:

- Multi-provider credential storage (Anthropic, OpenAI, Google, 20+ providers)
- Failover chains between profiles
- Cooldown/backoff logic for rate-limited keys
- OAuth token management and refresh
- Per-profile usage stats

**Cortex Apollo already provides all of this** for Anthropic:

- Multi-auth key resolution (user key → OAuth → org fallback)
- Rate limiting (RPM, daily tokens, monthly spend)
- Usage tracking with microdollar cost calculation
- Streaming support (SSE)
- SDK-compatible route at `/v1/messages` (already verified with Sonance migration)

---

## Current LLM Call Chain (Detailed)

### 1. Config → Model Selection

- **File**: `src/agents/model-selection.ts`
- **Default**: `anthropic/claude-opus-4-6` (from `src/agents/defaults.ts`)
- Config can override via `agents.defaults.model.primary` in `athena.json`
- Supports aliases, provider/model syntax, allowlists

### 2. Auth Profile Resolution

- **File**: `src/agents/model-auth.ts` → `resolveApiKeyForProvider()`
- Resolution order:
  1. Explicit `profileId` → look up in auth-profiles store
  2. Auth override check (e.g., `aws-sdk`)
  3. `resolveAuthProfileOrder()` → iterate profiles, check cooldowns, try each
  4. Environment variables (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, etc.)
  5. Config `apiKey` field from `athena.json`
  6. AWS SDK fallback for Bedrock
  7. Error if nothing found

### 3. Pi Auth JSON Bridge

- **File**: `src/agents/pi-auth-json.ts` → `ensurePiAuthJsonFromAuthProfiles()`
- Converts OpenClaw auth-profiles to pi-agent-core's `auth.json` format
- Required so pi-agent-core's `ModelRegistry` considers providers "authenticated"

### 4. Model Resolution

- **File**: `src/agents/pi-embedded-runner/model.ts` → `resolveModel()`
- Discovers models via pi-agent-core's `AuthStorage` + `ModelRegistry`
- Falls back to inline models from config providers

### 5. Model Fallback

- **File**: `src/agents/model-fallback.ts`
- Handles failover between providers/profiles on errors
- Uses auth-profiles cooldown system to skip known-bad keys

### 6. Provider Auto-Discovery

- **File**: `src/agents/models-config.providers.ts` → `resolveImplicitProviders()`
- Auto-discovers 15+ providers (Ollama, vLLM, Minimax, Venice, etc.)
- Fills in `apiKey` from env vars or auth-profiles store

---

## The Integration Pattern (Already Proven)

The Cortex integration doc shows the config pattern already works:

```json
// ~/.athena/athena.json
{
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://cortex-bice.vercel.app",
        "apiKey": "ctx_abc12345_secretpart",
        "api": "anthropic-messages",
        "models": [
          { "id": "claude-opus-4-6", "name": "Claude Opus 4.6" },
          { "id": "claude-sonnet-4-6", "name": "Claude Sonnet 4.6" },
          { "id": "claude-haiku-4-5-20251001", "name": "Claude Haiku 4.5" }
        ]
      }
    }
  }
}
```

- **`baseUrl`** points at Cortex (SDK-compat route `/v1/messages` handles the path)
- **`apiKey`** is the Cortex API key (`ctx_...`), passed as `x-api-key` header
- **`api`** stays `anthropic-messages` — Cortex Apollo is Anthropic-compatible
- Auth-profiles resolution will find the `apiKey` in config as a fallback

**This is config-only. No code changes needed to prove it works.**

---

## Implementation Stages

### Stage 1A: Config-Only Wiring (No Code Changes)

**Goal**: Prove Cortex Apollo works as Athena's LLM backend.

**Steps**:

1. Create a Cortex API key named `"athena"` with scopes: `["ai:messages", "ai:messages:stream", "ai:count_tokens", "ai:models"]`
2. Update `~/.athena/athena.json` with the provider config above
3. Remove `ANTHROPIC_API_KEY` from environment (force the config path)
4. Test: send a message via any channel, verify response comes through
5. Test: verify streaming works (auto-reply chunking)
6. Check: `GET /api/v1/ai/usage` on Cortex shows the request

**Files modified**: `~/.athena/athena.json` only (user config, not codebase)

**Verification**:

- [ ] Gateway starts without errors
- [ ] Agent responds to a WhatsApp message
- [ ] Agent responds to a Telegram message
- [ ] Streaming works (long responses arrive in chunks)
- [ ] Cortex usage API shows requests with `consumer_id: "athena"`
- [ ] Rate limiting kicks in at configured thresholds

---

### Stage 1B: Simplify Auth for Cortex Mode

**Goal**: When running with Cortex, bypass the auth-profiles system entirely for Anthropic.

**Key insight**: The auth-profiles resolution in `model-auth.ts:resolveApiKeyForProvider()` already falls through to the config `apiKey` as step 5. But it wastes effort trying auth-profiles first. When Cortex is the backend, there's only one key — the Cortex API key in config.

**Approach**: Add a "cortex mode" check that short-circuits auth resolution.

**Changes**:

1. **`src/agents/model-auth.ts`** — Add early return when provider has a `baseUrl` configured (indicates external proxy like Cortex):

```typescript
// In resolveApiKeyForProvider(), before auth-profile resolution:
const providerConfig = resolveProviderConfig(cfg, provider);
if (providerConfig?.baseUrl && providerConfig?.apiKey) {
  // External proxy (e.g., Cortex Apollo) — use config key directly
  return {
    apiKey: normalizeSecretInput(providerConfig.apiKey),
    source: "config:cortex",
    mode: "api-key",
  };
}
```

This is a surgical change — 5 lines — that short-circuits the entire auth-profiles chain when the provider is configured with an explicit `baseUrl` + `apiKey` (i.e., Cortex mode).

2. **`src/agents/pi-auth-json.ts`** — Skip syncing for providers with `baseUrl` set (they don't need auth.json bridge).

3. **`src/agents/model-fallback.ts`** — Skip profile-based fallback for Cortex-backed providers (there's only one key, no fallback chain).

**Files modified**:

- `src/agents/model-auth.ts` (add early return, ~5 lines)
- `src/agents/pi-auth-json.ts` (skip Cortex providers, ~3 lines)
- `src/agents/model-fallback.ts` (skip profile fallback for Cortex providers, ~5 lines)

**Verification**:

- [ ] Auth-profiles store is never consulted for Anthropic when Cortex config is set
- [ ] Other providers (if configured) still use auth-profiles normally
- [ ] No auth-related errors on startup or during agent runs
- [ ] Existing tests pass (run: `pnpm test --filter=auth-profiles`)

---

### Stage 1C: Strip Auth Profiles (After 1B Is Stable)

**Goal**: Remove the auth-profiles system entirely.

**Prerequisites**: Users are fully on Cortex. No local API keys needed.

**Files to remove** (17 source + 8 test files):

```
src/agents/auth-profiles/
  constants.ts
  display.ts
  doctor.ts
  external-cli-sync.ts
  oauth.ts
  oauth.fallback-to-main-agent.e2e.test.ts
  oauth.test.ts
  order.ts
  paths.ts
  profiles.ts
  repair.ts
  session-override.ts
  session-override.e2e.test.ts
  store.ts
  types.ts
  usage.ts
  usage.test.ts
```

**Files to remove** (top-level auth-profile tests):

```
src/agents/auth-profiles.ts (barrel export)
src/agents/auth-profiles.chutes.e2e.test.ts
src/agents/auth-profiles.cooldown-auto-expiry.test.ts
src/agents/auth-profiles.ensureauthprofilestore.e2e.test.ts
src/agents/auth-profiles.getsoonestcooldownexpiry.test.ts
src/agents/auth-profiles.markauthprofilefailure.e2e.test.ts
src/agents/auth-profiles.resolve-auth-profile-order.*.e2e.test.ts (4 files)
src/agents/auth-profiles.resolve-auth-profile-order.fixtures.ts
```

**Files to simplify**:

| File                                     | Change                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------------------------------- |
| `src/agents/model-auth.ts`               | Remove auth-profile imports, simplify `resolveApiKeyForProvider()` to config + env only |
| `src/agents/model-fallback.ts`           | Remove auth-profile cooldown logic, simplify to model-level fallback only               |
| `src/agents/models-config.providers.ts`  | Remove `resolveApiKeyFromProfiles()` calls, rely on env vars + config only              |
| `src/agents/pi-auth-json.ts`             | Remove entirely (no more auth-profiles to bridge)                                       |
| `src/agents/pi-embedded-runner/model.ts` | Remove `discoverAuthStorage` dependency on auth-profiles                                |
| `src/agents/live-auth-keys.ts`           | Simplify or remove                                                                      |
| `src/agents/cli-credentials.ts`          | Simplify or remove                                                                      |
| `src/agents/auth-health.ts`              | Replace with Cortex health check                                                        |
| `src/agents/model-auth-label.ts`         | Simplify (no more profile labels)                                                       |
| `src/commands/` (onboarding)             | Replace "add API key" with "connect to Cortex"                                          |
| `src/agents/auth-profiles/doctor.ts`     | Replace with Cortex connectivity check                                                  |

**Files to update** (import cleanup):

- Any file that imports from `./auth-profiles.js` or `./auth-profiles/` needs import removal
- Use grep: `auth-profiles` across `src/` to find all references

**Verification**:

- [ ] `pnpm build` succeeds with no errors
- [ ] `pnpm test` — all remaining tests pass
- [ ] `athena gateway` starts and agent responds
- [ ] `athena doctor` checks Cortex health instead of API key validity
- [ ] `athena onboard` guides through Cortex connection
- [ ] No `auth-profiles.json` files created in agent workspaces

---

## Important: Multi-Provider Consideration

Cortex Apollo currently proxies **Anthropic only**. Athena supports 20+ providers. There are two approaches:

**Option A (Recommended for now)**: Cortex handles Anthropic. Other providers keep using env vars + config `apiKey` directly (no auth-profiles needed — `resolveEnvApiKey()` in `model-auth.ts` handles this already).

**Option B (Future)**: Extend Cortex Apollo to proxy multiple providers (OpenAI, Google, etc.). This would make Cortex the universal AI gateway.

For Stage 1, Option A is correct. The auth-profiles system is primarily valuable for:

- Multi-key failover (Cortex handles this)
- Cooldown/backoff (Cortex handles this)
- OAuth token refresh (Cortex handles this for Anthropic)

The simpler `resolveEnvApiKey()` path in `model-auth.ts` already handles env var-based auth for other providers without auth-profiles.

---

## Risk Assessment

| Risk                                             | Likelihood | Impact | Mitigation                                                                         |
| ------------------------------------------------ | ---------- | ------ | ---------------------------------------------------------------------------------- |
| Cortex downtime → Athena can't use AI            | Medium     | High   | Accept tradeoff. Cortex on Vercel has high availability.                           |
| Apollo response format mismatch                  | Low        | High   | Already verified via Sonance migration. SDK-compat route at `/v1/messages` exists. |
| Streaming SSE differences                        | Low        | Medium | Test thoroughly in Stage 1A before any code changes.                               |
| Auth-profiles needed for non-Anthropic providers | Medium     | Low    | Keep `resolveEnvApiKey()` path, only strip auth-profiles store.                    |
| Existing tests depend on auth-profiles           | High       | Medium | Run full test suite after each stage. Fix failures before proceeding.              |

---

## Estimated Impact

| Stage | Files Changed   | Files Removed | LOC Removed        | Risk   |
| ----- | --------------- | ------------- | ------------------ | ------ |
| 1A    | 0 (config only) | 0             | 0                  | None   |
| 1B    | 3               | 0             | 0 (adds ~15 lines) | Low    |
| 1C    | ~10             | ~25           | ~3,000+            | Medium |

---

## Test Commands

```bash
# After Stage 1A — verify config works
athena gateway --port 18789
# Send a test message via channel, check Cortex usage

# After Stage 1B — verify short-circuit works
pnpm test -- --grep "auth-profile"
pnpm test -- --grep "model-auth"

# After Stage 1C — full regression
pnpm build
pnpm test
athena doctor
```
