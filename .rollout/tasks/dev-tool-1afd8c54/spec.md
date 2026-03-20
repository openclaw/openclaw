# Spec: Fix Ollama API Key Preflight Regression (#50759)

## Problem

When a user configures `ollama` as the primary model provider, the gateway auth fails with:

```
No API key found for provider "ollama".
```

Two complementary scenarios trigger this regression:

1. **No explicit `models.providers.ollama` section**: User sets `models.primary: "ollama/llama3.1:8b"` but has no provider config entry. `resolveSyntheticLocalProviderAuth()` returns `null` because `resolveProviderConfig(cfg, "ollama")` is `undefined`.

2. **Sparse provider config** (e.g. `{ apiKey: "OLLAMA_API_KEY" }` only, no `baseUrl`/`api`/`models`): The `hasApiConfig` gate at line 179 returns `false`, short-circuiting before the ollama-specific override at line 184. This path was previously masked by step 5 (`resolveUsableCustomProviderApiKey`) treating the literal string `"OLLAMA_API_KEY"` as a usable key, but commit `8ab01c5c93` broke that fallback (see Root Cause below).

## Root Cause Location

**File:** `src/agents/model-auth.ts`
**Function:** `resolveSyntheticLocalProviderAuth` (line ~166)

**Primary regression**: commit `8ab01c5c93` ("refactor(core): land plugin auth and startup cleanup", 2026-03-15) added `providerAuthEnvVars: { "ollama": ["OLLAMA_API_KEY"] }` to the ollama plugin manifest (`extensions/ollama/openclaw.plugin.json`). This caused `"OLLAMA_API_KEY"` to be added to `BUNDLED_PROVIDER_AUTH_ENV_VAR_CANDIDATES` (`src/plugins/bundled-provider-auth-env-vars.generated.ts:23`) and thus to `KNOWN_ENV_API_KEY_MARKERS`.

**Before** the change: `isNonSecretApiKeyMarker("OLLAMA_API_KEY")` returned `false` (not in known markers). So `resolveUsableCustomProviderApiKey()` treated the string `"OLLAMA_API_KEY"` as a literal API key value and returned it at step 5. Ollama doesn't validate keys, so this dummy string worked.

**After** the change: `isNonSecretApiKeyMarker("OLLAMA_API_KEY")` returns `true` (it's now a known env-var marker). `resolveUsableCustomProviderApiKey()` enters the env-marker resolution branch, tries to read `process.env.OLLAMA_API_KEY`, finds nothing, and returns `null`. The flow falls through to step 6 (`resolveSyntheticLocalProviderAuth`), which fails when the provider config is missing or sparse (no `api`/`baseUrl`/`models`).

**Contributing factor**: `resolveSyntheticLocalProviderAuth` checks `hasApiConfig` (requires `api`, `baseUrl`, or non-empty `models`) BEFORE the `normalizedProvider === "ollama"` check. For sparse configs, `hasApiConfig` is `false` and the function returns `null` without ever reaching the ollama-specific override.

## Current Flow (Broken)

```
resolveApiKeyForProvider({ provider: "ollama", cfg: { models: { providers: { ollama: { apiKey: "OLLAMA_API_KEY" } } } } })
  step 3: no auth profiles → skip
  step 4: resolveEnvApiKey("ollama") → OLLAMA_API_KEY not in env → null
  step 5: resolveUsableCustomProviderApiKey → "OLLAMA_API_KEY" is known env marker → env not set → null
  step 6: resolveSyntheticLocalProviderAuth → hasApiConfig is false (no baseUrl/api/models) → null
  step 9: throw "No API key found for provider 'ollama'"
```

## Desired Flow (Fixed)

```
resolveSyntheticLocalProviderAuth({ cfg, provider: "ollama" })
  → normalizeProviderId("ollama") === "ollama"
  → return { apiKey: OLLAMA_LOCAL_AUTH_MARKER, ... }  ← Always for Ollama
```

## Fix

In `resolveSyntheticLocalProviderAuth`, move the `normalizedProvider === "ollama"` check **before** the `providerConfig` existence check. Ollama is inherently a local provider — it should always receive a synthetic local auth key, regardless of whether `models.providers.ollama` is explicitly configured.

### Code Change

In `src/agents/model-auth.ts`, function `resolveSyntheticLocalProviderAuth`:

```typescript
function resolveSyntheticLocalProviderAuth(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
}): ResolvedProviderAuth | null {
+ // Ollama is always a local provider; synthesize a local key even when
+ // models.providers.ollama is not explicitly configured.
+ const normalizedProvider = normalizeProviderId(params.provider);
+ if (normalizedProvider === "ollama") {
+   return {
+     apiKey: OLLAMA_LOCAL_AUTH_MARKER,
+     source: "models.providers.ollama (synthetic local key)",
+     mode: "api-key",
+   };
+ }
+
  const providerConfig = resolveProviderConfig(params.cfg, params.provider);
  if (!providerConfig) {
    return null;
  }
  // ... hasApiConfig check ...
- const normalizedProvider = normalizeProviderId(params.provider);
- if (normalizedProvider === "ollama") {
-   return {
-     apiKey: OLLAMA_LOCAL_AUTH_MARKER,
-     source: "models.providers.ollama (synthetic local key)",
-     mode: "api-key",
-   };
- }
  // ... rest of custom local provider logic ...
```

### Test Change

In `src/agents/model-auth.profiles.test.ts`, update the test at line ~333:

```typescript
// Before: expected to throw when no provider config
it("still throws for ollama when no env/profile/config provider is available", ...)

// After: should resolve synthetic local key even without explicit provider config
it("resolves synthetic local auth key for ollama even without explicit provider config", async () => {
  await withEnvAsync({ OLLAMA_API_KEY: undefined }, async () => {
    const resolved = await resolveApiKeyForProvider({
      provider: "ollama",
      store: { version: 1, profiles: {} },
    });
    expect(resolved.apiKey).toBe("ollama-local");
    expect(resolved.mode).toBe("api-key");
  });
});
```

## Relevant Files

| File                                                         | Purpose                                                                                              |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `src/agents/model-auth.ts:166-215`                           | `resolveSyntheticLocalProviderAuth()` - synthesizes local auth for ollama and custom local providers |
| `src/agents/model-auth.ts:82-118`                            | `resolveUsableCustomProviderApiKey()` - resolves env-marker apiKeys from provider config             |
| `src/agents/model-auth.ts:282-394`                           | `resolveApiKeyForProvider()` - main auth resolution pipeline                                         |
| `src/agents/model-auth-markers.ts:7,72-97`                   | `OLLAMA_LOCAL_AUTH_MARKER` and `isNonSecretApiKeyMarker()`                                           |
| `src/plugins/bundled-provider-auth-env-vars.generated.ts:23` | `ollama: ["OLLAMA_API_KEY"]` (added by `8ab01c5c93`)                                                 |
| `extensions/ollama/openclaw.plugin.json:4-6`                 | `providerAuthEnvVars` manifest entry (added by `8ab01c5c93`)                                         |
| `src/plugins/provider-ollama-setup.ts:263-279`               | Onboarding saves `apiKey: "OLLAMA_API_KEY"` marker                                                   |
| `src/agents/model-auth.test.ts:231-490`                      | Synthetic local auth tests                                                                           |
| `src/agents/model-auth.profiles.test.ts:287-341`             | Ollama auth tests                                                                                    |

## Constraints

- The `OLLAMA_API_KEY` env var and auth profile should still be **preferred** over the synthetic key when present (the existing resolution order handles this: profiles → env → custom config → synthetic).
- The fix must not change behavior for non-Ollama local providers (custom local providers with `baseUrl` pointing to localhost still require `providerConfig` to exist).
- The `pi-embedded-runner/model.ts` error hint for missing `OLLAMA_API_KEY` (line ~423) may become unreachable for the pure "no config, no env" case, but the hint is still useful for cases where the model isn't registered in the ModelRegistry.
- `hasAvailableAuthForProvider()` (line 490) also calls `resolveSyntheticLocalProviderAuth` and needs the same fix coverage.

## Validation

- `pnpm test -- src/agents/model-auth.profiles.test.ts`
- `pnpm test -- src/agents/model-auth.test.ts`
- `pnpm test -- extensions/ollama/index.test.ts`
- `pnpm test -- src/agents/models-config.providers.ollama.test.ts`
