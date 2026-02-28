# Claude SDK Provider Env Notes

This file documents the env contract used by `provider-env.ts` for Claude Code
subprocess launches in OpenClaw.

## Current Mapping

- Claude SDK runner receives the full auth-resolution object (`ResolvedProviderAuth`)
  from run-time profile resolution (profile id, source, mode, key).
- Runtime selection in `run/attempt.ts` now prefers auth mode/source
  (`system-keychain`) over provider-name matching when available.
- `agents.defaults.claudeSdk.supportedProviders` (or per-agent override) can
  explicitly route provider IDs through Claude SDK runtime. If omitted, only
  default system-keychain providers are routed automatically.
- `claude-sdk` (Claude subscription/system keychain):
  - Uses inherited process env.
  - Strips `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_OAUTH_TOKEN`.
- `anthropic`:
  - Injects `ANTHROPIC_API_KEY` from auth resolver.
  - Removes proxy endpoint vars (`ANTHROPIC_BASE_URL` and `API_TIMEOUT_MS`).
- Non-Anthropic providers (`minimax`, `minimax-portal`, `zai`, `openrouter`):
  - Set `ANTHROPIC_BASE_URL`.
  - Set `API_TIMEOUT_MS=3000000`.
  - Inject credential as `ANTHROPIC_AUTH_TOKEN`.
  - Known providers also set:
    - `ANTHROPIC_DEFAULT_HAIKU_MODEL`
    - `ANTHROPIC_DEFAULT_SONNET_MODEL`
    - `ANTHROPIC_DEFAULT_OPUS_MODEL`
    - `ANTHROPIC_MODEL`
    - `ANTHROPIC_SMALL_FAST_MODEL`
- `custom`:
  - Requires explicit `baseUrl`.
  - Requires `authProfileId` (OpenClaw auth-profile reference).
  - Optional `authHeaderName` sets which env/header key receives the resolved credential.
  - `authHeaderName` defaults to `ANTHROPIC_AUTH_TOKEN`.
  - Requires all three explicit model mappings:
    - `anthropicDefaultHaikuModel`
    - `anthropicDefaultSonnetModel`
    - `anthropicDefaultOpusModel`
  - Never uses provider/model defaults or inherited model alias defaults.
  - Exports:
    - `ANTHROPIC_BASE_URL`
    - one auth env key from `authHeaderName` (default `ANTHROPIC_AUTH_TOKEN`)
    - `ANTHROPIC_DEFAULT_HAIKU_MODEL`
    - `ANTHROPIC_DEFAULT_SONNET_MODEL`
    - `ANTHROPIC_DEFAULT_OPUS_MODEL`
    - `ANTHROPIC_MODEL` (from explicit sonnet mapping)
    - `ANTHROPIC_SMALL_FAST_MODEL` (from explicit haiku mapping)

## OpenRouter Caveat

OpenRouter is kept as best-effort compatibility, not a first-class integrated
provider for Claude Code model discovery/routing semantics. We only set the
Anthropic-compatible endpoint/auth env contract:

- `ANTHROPIC_BASE_URL=https://openrouter.ai/api`
- `ANTHROPIC_AUTH_TOKEN=<OPENROUTER_API_KEY>`
- `ANTHROPIC_API_KEY=""` (explicit empty string, per OpenRouter guidance)

## Telemetry / OTEL Decision (Current)

OpenClaw now hard-sets the following env flags for wrapped Claude SDK launches:

- `CLAUDE_CODE_ENABLE_TELEMETRY=0`
- `DISABLE_TELEMETRY=1`
- `DISABLE_BUG_COMMAND=1`
- `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`

If we add OpenTelemetry support later, keep it explicit opt-in (for example via
config or explicit env override), and avoid silently enabling outbound
telemetry for existing users.

Reference:

- https://code.claude.com/docs/en/monitoring-usage
