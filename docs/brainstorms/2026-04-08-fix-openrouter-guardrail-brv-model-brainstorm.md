---
title: "fix: OpenRouter Guardrail & brv Model Routing"
type: fix
priority: P1
status: completed
created: 2026-04-08
completed: 2026-04-08
origin: Post-remediation remaining issues from health audit
---

# Fix OpenRouter Guardrail & brv Model Routing

## What We Fixed

Two remaining issues after the health audit remediation:

1. **`brv curate` failing** with "No endpoints available matching your guardrail restrictions and data policy"
2. **Suspected `gpt` alias misrouting** through OpenRouter (turned out to be a non-issue)

## Root Cause Analysis

### Issue 1: brv model blocked by guardrail

The OpenRouter guardrail `openclaw-brv` restricts usage to only 2 models (MiniMax M2.7, Qwen3.6 Plus) and explicitly ignores Anthropic and OpenAI providers. brv was configured with `openai/gpt-4.1-mini` as its active model — blocked on both counts (model not in allowlist AND OpenAI provider ignored).

**Fix:** Switched brv's active model from `openai/gpt-4.1-mini` to `minimax/minimax-m2.7` via `brv model switch minimax/minimax-m2.7`.

### Issue 2: gpt alias routing (non-issue)

Investigation of gateway logs showed `openai-codex/gpt-5.4` (the `gpt` alias) routes correctly via `openai-codex:default` OAuth profile — direct to OpenAI, NOT through OpenRouter. The 404 errors in the original audit were from `minimax/minimax-m2.7` (bare ID, billing failures), not the `gpt` alias.

## Key Decisions

1. **OpenRouter guardrail is intentionally restrictive** — keep Anthropic and OpenAI blocked. These providers have their own direct auth profiles (OAuth for OpenAI, API key for Anthropic). OpenRouter is exclusively for minimax and qwen to control costs.

2. **brv uses minimax/minimax-m2.7** — matches the guardrail's allowed models. No need to widen the guardrail.

3. **Rule: Never route Anthropic or OpenAI through OpenRouter** — saved to auto-memory for future sessions.

## OpenRouter Guardrail Settings (reference)

| Setting | Value |
|---------|-------|
| Name | `openclaw-brv` |
| Models allowed | MiniMax M2.7, Qwen3.6 Plus (only 2) |
| Providers ignored | Anthropic, OpenAI |
| ZDR | Default (Disabled) |
| Paid training | Default (Allowed) |
| Free training | Default (Allowed) |
| Free publish | Default (Disallowed) |
| API keys | `brv`, `OpenClaw` |

## Resolved Questions

1. ~~Is the `gpt` alias routing through OpenRouter?~~ No. It correctly uses `openai-codex:default` OAuth. Confirmed by gateway logs showing successful `candidate=openai-codex/gpt-5.4` resolutions.

2. ~~Should we widen the guardrail?~~ No. The restriction is intentional. Fix brv to use an allowed model instead.

## Sources

- Gateway logs (`journalctl --user -u openclaw-gateway.service`)
- brv config (`~/.config/brv/providers.json`)
- OpenClaw config (`~/.openclaw/openclaw.json` — auth.profiles)
- User-provided OpenRouter guardrail settings screenshot
