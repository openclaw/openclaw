# OpenClaw Health Audit — 2026-04-08

## What We're Investigating

OpenClaw ("Clawd") Telegram bot is unresponsive. User reports it is "sleeping" and doesn't wake up when messaged. Suspected: multiple config issues compounding.

## Root Cause: Gateway Down

The `openclaw-gateway.service` systemd unit is **inactive (dead)** since 2026-04-07T23:59:50 UTC (~10h downtime at time of audit).

### Shutdown Timeline

The gateway was restarted hourly on Apr 7 by an external process (likely vibe-kanban or another automated tool issuing `systemctl --user restart`):

| Time (UTC) | Event |
|------------|-------|
| 06:00:43 | Stop → Start (restart) |
| 19:35:46 | Start |
| 19:44:27 | Stop → Start (restart) |
| 20:48:49 | Stop → Start (restart) |
| 21:54:20 | Stop → Start (restart) |
| 22:55:49 | Stop → Start (restart) |
| **23:59:49** | **Stop → NO START** |

The final stop was a clean SIGTERM (exit status 0). With `Restart=always` in the systemd unit, this would normally auto-restart — but `systemctl stop` explicitly suppresses that. Something issued a `stop` instead of `restart` on the last cycle.

systemd does not log which process made the D-Bus call, so the exact caller is unknown. Audit session 83827 is associated with a `vibe-kanban` process.

### Why Restart=always Didn't Help

`Restart=always` only triggers on unexpected exits (crashes, signals). An explicit `systemctl --user stop` tells systemd to keep the service dead. `NRestarts=0` confirms systemd never attempted an auto-restart.

## Full Issue Registry (16 issues)

### P0 — Service Down

#### 1. Gateway is dead
- **Status**: inactive (dead) since Apr 7 23:59:50 UTC
- **Fix**: `systemctl --user start openclaw-gateway.service`

### P1 — Model Routing Broken

#### 2. `qwen/qwen3.6-plus:free` decommissioned
- Primary model in config and many cron jobs references a model that no longer exists on OpenRouter
- **Fix**: Replace all `qwen/qwen3.6-plus:free` with `qwen/qwen3.6-plus`

#### 3. `minimax/minimax-m2.7` — "Unknown model" in some fallback chains
- The cron job error says "Unknown model: minimax/minimax-m2.7" — may be a transient OpenRouter issue or the model ID changed
- **Fix**: Verify model availability; if valid, ensure it's in fallback chains correctly

#### 4. `openai-codex/gpt-5.4` — rate limited (temporary)
- Hit Codex weekly rate limits yesterday. Should have fallen back to minimax → qwen but fallback chain was broken because qwen:free was decommissioned
- **Fix**: Fix fallback chains so rate limit fallback works: `openai-codex/gpt-5.4` → `minimax/minimax-m2.7` → `qwen/qwen3.6-plus`

#### 5. `gpt` alias — "404 No endpoints available"
- OpenRouter privacy settings only allow `minimax/minimax-m2.7` and `qwen/qwen3.6-plus` — any other model routed through OpenRouter gets 404
- **Fix**: Ensure all OpenRouter-routed model refs use only those two models

### Model Routing Rules (confirmed with user)

| Context | Default Model | Fallbacks |
|---------|--------------|-----------|
| Main agent (Clawd) | `openai-codex/gpt-5.4` | `minimax/minimax-m2.7` → `qwen/qwen3.6-plus` |
| Most cron jobs | `openai-codex/gpt-5.4` | `minimax/minimax-m2.7` → `qwen/qwen3.6-plus` |
| Cron jobs that had specific non-default models | `minimax/minimax-m2.7` | `qwen/qwen3.6-plus` |
| Plugins (brv, etc.) | `minimax/minimax-m2.7` | `qwen/qwen3.6-plus` |
| OpenRouter allowlist | Only `minimax/minimax-m2.7` and `qwen/qwen3.6-plus` |

### P1 — Cron Job Failures

#### 6. Daily Second-Brain Routine — 5 consecutive errors
- All models failed: codex rate-limited, minimax "unknown", qwen:free decommissioned
- **Fix**: Set model to `minimax/minimax-m2.7`, fallback `qwen/qwen3.6-plus` (this job had non-default models)

#### 7. ByteRover Knowledge Miner — `@heartbeat` chat not found
- Delivery target `@heartbeat` cannot be resolved to a Telegram chat ID
- **Fix**: Replace with numeric chat ID `183115134` or correct target

#### 8. Readwise Vault Ingest — missing delivery chatId
- Error: "Delivering to Telegram requires target `<chatId>`"
- User chats directly with the bot (threaded conversations), no dedicated channel
- **Fix**: Add `"to": "183115134"` in delivery config

### P1 — Plugin Failure

#### 9. `acpx` plugin fails to load, retries ~10x per startup
- `Cannot find module 'acpx/dist/runtime.js'` from `/home/codex/projects/moltbot/dist-runtime/extensions/acpx/index.js`
- Triggers on every startup AND on every channel/plugin reload cycle (~10 times per boot)
- **Fix**: Either install/build the acpx extension, or remove/disable it from the plugin registry

### P2 — Configuration Issues

#### 10. Control UI build fails on every startup
- `"Control UI build failed: Node.js v18.19.1"` — the UI build subprocess finds `/usr/bin/node` (v18) instead of mise-managed Node 22
- Systemd PATH includes correct node, but subprocess doesn't inherit it
- **Fix**: Prebuild UI assets (`pnpm ui:build`) or fix subprocess PATH resolution

#### 11. Daily Knowledge Compile — edit operation failed
- `Edit in ~/second-brain/projects/uplix-automation/onboarding/arnaud-mirocha.md failed`
- **Fix**: Check if file exists, fix permissions or path

#### 12. Dual config files with version skew
- `openclaw.json` and `moltbot.json` are near-duplicates
- Model alias mismatch: `claude-opus-4-6` vs `claude-opus-4-5`
- `openclaw.json` has 5 aliases, `moltbot.json` has 2
- **Fix**: Consolidate to single source of truth, or at least sync model aliases

#### 13. Systemd ExecStart points to legacy path
- `/home/codex/projects/moltbot/dist/index.js` — works (file exists at that path) but naming is confusing since project is now "openclaw"
- **Fix**: Low priority; update path if/when the moltbot directory is renamed

#### 14. Context overflow — sessions grow unbounded
- 556 messages caused context overflow with minimax-m2.7
- Auto-compaction failed: "ByteRover does not own compaction; delegating to runtime"
- Fell back to truncating 178 tool results
- **Fix**: Investigate compaction delegation; consider session TTL or max-message limits

### P3 — Warnings

#### 15. `plugins.allow` empty — plugins auto-load without allowlist
- Non-bundled plugins (byterover) auto-load with a warning
- **Fix**: Set `plugins.allow` to explicit list of trusted plugin IDs

#### 16. Browser CDP URL hardcoded to MacBook
- `macbook-pro-de-lonard.taildabf2.ts.net:18791` — only works when Mac is on Tailscale
- **Fix**: Make conditional or remove if not needed on this host

## Additional Observations

### Startup Issues (occur every restart)
1. `acpx` plugin load fails and retries ~10x (log noise)
2. Control UI build fails (Node version mismatch)
3. `plugins.allow` warning logged
4. Skills discovery truncated + 4 skill paths skipped ("resolves outside configured root")

### Infrastructure Notes
- Linger is enabled (good)
- GC timer is healthy (runs every 6h, last run successful)
- Tailscale serve is configured for HTTPS access
- Telegram bot token is valid (format check)
- Gateway auth mode: token-based

## Remediation Plan

### Phase 1: Get Bot Running (P0)
1. Restart gateway: `systemctl --user start openclaw-gateway.service`
2. Verify Telegram responds

### Phase 2: Fix Model Routing (P1)
3. Replace all `qwen/qwen3.6-plus:free` → `qwen/qwen3.6-plus` in all config files
4. Set main agent fallbacks: `openai-codex/gpt-5.4` → `minimax/minimax-m2.7` → `qwen/qwen3.6-plus`
5. Update all cron jobs:
   - Jobs that should use default: set model `openai-codex/gpt-5.4`, fallbacks `minimax/minimax-m2.7`, `qwen/qwen3.6-plus`
   - Jobs that had non-default models: set model `minimax/minimax-m2.7`, fallback `qwen/qwen3.6-plus`
6. Fix model aliases to only use allowed models

### Phase 3: Fix Cron Delivery (P1)
7. Fix ByteRover Knowledge Miner delivery target (`@heartbeat` → numeric chat ID)
8. Fix Readwise Vault Ingest delivery: add `"to": "183115134"`

### Phase 4: Fix Plugin (P1)
9. Rebuild `acpx` plugin (do not remove — it must work)

### Phase 5: Naming Cleanup (P2)
10. Canonicalize naming: "openclaw" is the canonical name (formerly clawdbot, then moltbot). Remove name ambiguity in configs, paths, and systemd units where feasible.

### Phase 6: Config Cleanup (P2-P3)
11. Fix Control UI build (prebuild or fix Node PATH)
12. Fix Daily Knowledge Compile edit path
13. Sync dual config files (or consolidate to single source of truth)
14. Set `plugins.allow` explicit list
15. Address context overflow / compaction

### Phase 7: Prune Decommissioned Software
16. Prune vibe-kanban remnants (it was an agents-assisted coding app, now decommissioned — was the process cycling the gateway hourly)

### Phase 8: Verify
17. Restart gateway with all fixes applied
18. Send test message via Telegram
19. Verify cron jobs run successfully on next schedule

## Key Decisions
- Model routing: three-tier setup (codex default, minimax fallback, qwen last resort)
- OpenRouter allowlist: only minimax and qwen (to prevent token leakage)
- Telegram delivery: user's direct chat ID `183115134` (no dedicated channel)
- vibe-kanban: decommissioned — was the source of the hourly gateway restarts, prune it
- acpx plugin: must be rebuilt, not removed
- Canonical name: "openclaw" (formerly clawdbot → moltbot → openclaw)
- Model aliases: `gpt` → `openai-codex/gpt-5.4`, `minimax` → `minimax/minimax-m2.7`, `qwen` → `qwen/qwen3.6-plus`. Remove decommissioned `opus` and `sonnet` aliases.

## Resolved Questions
1. **vibe-kanban**: Decommissioned agents-assisted coding app. Was cycling the gateway hourly and issued the final stop without restart. Prune its remnants.
2. **acpx plugin**: Must be rebuilt (not removed).
3. **Naming**: openclaw is canonical. Formerly clawdbot → moltbot → openclaw. Clean up ambiguity.
4. **Model aliases**: `opus` and `sonnet` are decommissioned. New aliases: `gpt` → `openai-codex/gpt-5.4`, `minimax` → `minimax/minimax-m2.7`, `qwen` → `qwen/qwen3.6-plus`.
