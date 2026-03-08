# OpenClaw v2026.2.23-beta.1 Release Notes

**Tag:** v2026.2.23-beta.1
**Commit:** 936f244
**Released by:** steipete
**Date:** 2026-02-24

## Key Changes

### New Providers
- **Kilo Gateway**: First-class kilocode provider support (auth, onboarding, implicit provider detection, model defaults, transcript/cache-ttl handling). Default model: `kilocode/anthropic/claude-opus-4.6`. (#20212)
- **Vercel AI Gateway**: Accepts Claude shorthand model refs (`vercel-ai-gateway/claude-*`) by normalizing to canonical Anthropic-routed model IDs. (#23985)

### New Tool/Media Capabilities
- **web_search**: Added `provider: "kimi"` (Moonshot) support with two-step tool flow and citation extraction. (#16616, #18822)
- **Video understanding**: Native Moonshot video provider; refactored video execution to honor baseUrl+header precedence. (#12063)

### Agents
- Per-agent `params` overrides merged on top of model defaults (including `cacheRetention`) for independent cache tuning. (#17470, #17112)
- Bootstrap file snapshots cached per session key and cleared on session reset/delete, reducing prompt-cache invalidations. (#22220)

### Sessions/Maintenance
- `openclaw sessions cleanup` command with per-agent store targeting, disk-budget controls (`session.maintenance.maxDiskBytes` / `highWaterBytes`), and safer transcript/archive cleanup. (#24753)

### Docs
- Dedicated prompt-caching reference covering `cacheRetention`, per-agent params merge precedence, Bedrock/OpenRouter behavior, and cache-ttl + heartbeat tuning.

### Security (Gateway)
- Optional `gateway.http.securityHeaders.strictTransportSecurity` for direct HTTPS deployments.

## Notable Fixes

### Security
- Redact sensitive dynamic catchall keys in `config.get` snapshots.
- Detect obfuscated commands before exec allowlist decisions. (#8592)
- Hardened ACP client permission auto-approval (trusted core tool IDs, scoped read auto-approval). Thanks @nedlir.
- Escape user-controlled values in openai-image-gen HTML gallery to prevent stored XSS. (#12538)
- Harden skill-creator packaging against symlink escapes. (#24260, #16959)
- Redact API keys/tokens from OTEL diagnostics before export. (#12542)
- Pre-commit security hooks for private-key detection and dependency auditing.

### Provider Fixes
- **Anthropic**: Skip context-1m beta injection for OAuth tokens to avoid 401 errors. (#10647, #20354)
- **DashScope**: Send `system` role instead of unsupported `developer` role on Qwen APIs. (#19130)
- **Bedrock**: Disable prompt-cache retention for non-Anthropic models; enable for Anthropic-Claude refs. (#20866, #22303)
- **OpenRouter**: Remove conflicting top-level `reasoning_effort` to prevent 400 errors. (#24120)
- **Groq**: Stop classifying TPM limit errors as context overflow. (#16176)

### Agent/Compaction Fixes
- Pass `agentDir` into manual `/compact` so auth stays scoped. (#24133)
- Pass model metadata through embedded runtime for safeguard summarization. (#3479)
- Cancel safeguard compaction when summary generation cannot run, preserving history. (#10711)
- Detect additional provider context-overflow error shapes including Chinese localized errors. (#9951, #22855)
- Treat HTTP 502/503/504 as failover-eligible transient timeouts. (#20999)

### Telegram Fixes
- Soft-fail reaction action errors; accept `snake_case` message_id. (#20236, #21001)
- Scope polling offsets to bot identity; prevent cross-token offset bleed. (#10850, #11347)
- Suppress reasoning-only delivery when `/reasoning off` is active. (#24626, #24518)
- Keep auto-reasoning disabled unless explicitly enabled when model-default thinking is active. (#24335, #24290)

### Session Fixes
- Canonicalize mixed-case session keys; migrate legacy case-variant entries to lowercase. (#9561)
- Remove auth-key labels from `/new` and `/reset` confirmation messages. (#24384, #24409)

### Config/Gateway Fixes
- Immutable path-copy updates for config writes; reject prototype-key traversal. (#24134)
- Close repeated unauthorized WS request floods per connection. (#20168)
- Fix child listener PID handling during gateway restart health checks. (#24696)

### WhatsApp
- Fix `groupAllowFrom` sender filtering when `groupPolicy: "allowlist"` is set without explicit groups. (#24670)
- Accept `channels.whatsapp.enabled` in config validation. (#24263)

## Release Assets
- OpenClaw-2026.2.23.dmg
- OpenClaw-2026.2.23.dSYM.zip
- OpenClaw-2026.2.23.zip
- Source code (zip / tar.gz)

## Personal Notes
- Planning to test OpenClaw on a separate computer (possibly VPS).
- See also: `docs/vps.md` for existing VPS deployment docs.
