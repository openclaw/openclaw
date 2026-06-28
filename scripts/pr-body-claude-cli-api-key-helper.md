## What Problem This Solves

When Claude CLI is authenticated via `apiKeyHelper` in `~/.claude/settings.json` (the documented mechanism for corporate gateways and dynamic/proxy auth), OpenClaw's pre-spawn auth-gate returns `missing-provider-auth` (`No API key found for provider "anthropic"`), even though the Claude CLI itself authenticates and runs correctly.

The root cause: `readClaudeCliCredentials` / `readClaudeCliCredentialsCached` only reads macOS keychain or `~/.claude/.credentials.json`. There is no path for `apiKeyHelper`. When neither source has credentials, `resolveClaudeCliSyntheticAuth()` returns `undefined` — and both the provider-discovery descriptor and the runtime registration short-circuit before Claude is ever spawned.

## Implementation

This patch adds `api_key_helper` as a third variant of the `ClaudeCliCredential` discriminated union in `src/agents/cli-credentials.ts`. The existing `readClaudeCliCredentials()` now falls through to check `~/.claude/settings.json` when no `.credentials.json` (or keychain) credential is present. If `apiKeyHelper` is declared, it returns an `api_key_helper` credential — a sentinel that tells downstream consumers "auth exists, but the key lives inside the Claude CLI process."

Key design decisions:

1. **Credential-level integration** — Rather than adding a separate `hasClaudeCliApiKeyHelper()` check alongside the existing credential reader, this fix adds the helper check _inside_ the shared `readClaudeCliCredentials()` function. Every consumer automatically benefits: provider-discovery, runtime registration, auth labels, CLI health doctor, auth epochs, profiles, and markers.

2. **No secret exposure** — OpenClaw never reads or stores the helper's output. The `api_key_helper` credential is a `{ type: "api_key_helper", provider: "anthropic" }` marker with no secret field. The true API key is fetched by the Claude CLI helper script at spawn time.

3. **nonSecretAuthMarkers** — The sentinel `openclaw:claude-cli-api-key-helper` is registered in `openclaw.plugin.json` so generic auth paths treat it as a non-secret marker rather than plaintext API key material.

4. **Status surface coverage** — Auth labels show `api-key-helper (claude-cli)`, doctor reports `Headless Claude auth: OK (apiKeyHelper)`, external OAuth profile sync ignores helper-only credentials, and the CLI auth epoch includes helper presence in the local auth-state fingerprint.

5. **Helper path existence guard** — When `apiKeyHelper` points to an absolute (`/...`) or home-relative (`~/...`) path that does not exist on disk, the reader returns `null` instead of accepting a broken config. The auth gate then falls through to `missing-provider-auth` with a logged warning, surfacing the misconfiguration early rather than at spawn time. Sibling implementations (#97497, #97492) accept any non-empty string unconditionally.

## Files Changed

| File                                                 | Δ       | Purpose                                         |
| ---------------------------------------------------- | ------- | ----------------------------------------------- |
| `src/agents/cli-credentials.ts`                      | +46/-2  | Add `api_key_helper` type + reader + path guard |
| `src/agents/cli-credentials.test.ts`                 | +51     | Regression: apiKeyHelper + path existence       |
| `extensions/anthropic/cli-constants.ts`              | +2      | Marker constant                                 |
| `extensions/anthropic/cli-shared.ts`                 | +1      | Re-export marker                                |
| `extensions/anthropic/openclaw.plugin.json`          | +1      | `nonSecretAuthMarkers` entry                    |
| `extensions/anthropic/provider-discovery.ts`         | +19/-3  | Handle api_key_helper in switch + default       |
| `extensions/anthropic/register.runtime.ts`           | +19/-3  | Handle api_key_helper in switch + default       |
| `extensions/anthropic/cli-migration.ts`              | +24/-12 | api_key_helper → empty profiles                 |
| `extensions/anthropic/index.test.ts`                 | +20     | Test synthetic auth for apiKeyHelper            |
| `src/agents/model-auth-label.ts`                     | +16/-5  | Show "api-key-helper (claude-cli)"              |
| `src/agents/model-auth-label.test.ts`                | +23     | Label regression test                           |
| `src/commands/doctor-claude-cli.ts`                  | +6/-1   | Report "apiKeyHelper"                           |
| `src/commands/doctor-claude-cli.test.ts`             | +38     | Doctor regression test                          |
| `src/agents/cli-auth-epoch.ts`                       | +19/-5  | Include helper in epoch comment/coverage        |
| `src/agents/cli-auth-epoch.test.ts`                  | +13     | Epoch regression test                           |
| `src/agents/auth-profiles.external-cli-sync.test.ts` | +13     | Sync ignores helper coverage                    |
| `src/agents/model-auth-markers.test.ts`              | +1      | Marker list coverage                            |
| `src/agents/model-auth.profiles.test.ts`             | +22     | Profile acceptance coverage                     |

## Evidence

**Behavior addressed:** Linux users (or any host without `~/.claude/.credentials.json`) who use `apiKeyHelper` for proxy auth get `missing-provider-auth` before Claude CLI is spawned, blocking all claude-cli model routes.

**Proof script:** `scripts/proof-claude-cli-api-key-helper-auth.mjs` — creates an isolated HOME with only `~/.claude/settings.json` (apiKeyHelper) and deliberately no `.credentials.json`, then verifies:

1. `readClaudeCliCredentialsCached()` returns `api_key_helper` type
2. `resolveSyntheticAuth()` returns the sentinel marker
3. `resolveModelAuthLabel()` shows `api-key-helper (claude-cli)`
4. Auth gate does not throw `missing-provider-auth`

**Run:**

```bash
pnpm exec tsx scripts/proof-claude-cli-api-key-helper-auth.mjs
```

Fixes #97489.
