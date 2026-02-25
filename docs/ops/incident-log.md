# Incident Log - Jubal (ClawdBot)

## How to use this file

When you (Jubal) make config changes and something breaks, check this log first. The same mistakes tend to repeat. Learn from them.

---

## Incident 1: Wrong model name crashed the gateway

**Date:** 2026-02-18
**Error:** `Unknown model: openrouter/anthropic/claude-opus-4-5`
**Impact:** Bot completely down for hours. Mike was on a flight and couldn't fix it.

**What happened:**
Mike asked you to switch from direct Anthropic API to OpenRouter. You changed `agents.defaults.model.primary` to `openrouter/anthropic/claude-opus-4-5`. That model doesn't exist. The current Opus is `claude-opus-4-6`, not `4-5`.

**Root cause:**
You used a model ID that doesn't exist on OpenRouter. You didn't verify the model name before writing it to the config.

**Lesson:**
- Always verify a model ID exists before setting it. Run `clawdbot models list` after any model change to confirm it shows up without a `missing` tag.
- The current Anthropic models are `claude-opus-4-6` and `claude-sonnet-4-5`. Not 4-5 for Opus.

---

## Incident 2: Missing provider definition

**Date:** 2026-02-19
**Error:** `Unknown model: openrouter/anthropic/claude-opus-4-6` (even after fixing the name)
**Impact:** Bot still down after model name was corrected.

**What happened:**
Even with the correct model name, the gateway couldn't find the model. The `auth-profiles.json` had the OpenRouter API key, and `agents.defaults.model.primary` was correct, but there was no model definition in `models.providers`.

**Root cause:**
OpenRouter is not a built-in provider in the pi-ai SDK. It requires an explicit entry in the config under `models.providers.openrouter` with `baseUrl`, `api`, and a `models` array defining each model's capabilities (contextWindow, maxTokens, input types, cost).

Without this, the model registry doesn't know what `anthropic/claude-opus-4-6` is under the `openrouter` provider, even if auth is configured.

**Lesson:**
- When adding a new provider, you need THREE things:
  1. API key in `auth-profiles.json` (and `auth.json`)
  2. Model reference in `agents.defaults.model.primary`
  3. Provider + model definition in `models.providers`
- If `clawdbot models list` shows a model as `missing`, it means the model definition is absent from `models.providers`. Fix that before restarting.

---

## Incident 3: Missing auth.json

**Date:** 2026-02-19
**Error:** `Unknown model` persisted even with correct config
**Impact:** Bot still down.

**What happened:**
The `auth-profiles.json` (OpenClaw format) had the OpenRouter key, but `auth.json` (pi-ai SDK format) didn't exist. The gateway startup is supposed to generate `auth.json` from `auth-profiles.json`, but it wasn't happening.

**Root cause:**
The `auth.json` file in `~/.clawdbot/agents/main/agent/` was never created. The pi-ai SDK reads credentials from `auth.json`, not `auth-profiles.json`. Without it, the provider appears unauthenticated.

**Lesson:**
- After adding credentials to `auth-profiles.json`, verify that `auth.json` exists in the same directory.
- If it doesn't, create it manually. Format:
  ```json
  {
    "openrouter": {"type": "api_key", "key": "sk-or-..."}
  }
  ```
- Run `clawdbot models list` and check the `Auth` column shows `yes` for your provider.

---

## Incident 4: Garbled model name from self-editing config

**Date:** 2026-02-19
**Error:** `agent model: openrouter/anthropicnnet-4-5` (garbled)
**Impact:** Bot down again after attempting to switch to Sonnet.

**What happened:**
Mike asked you to switch primary model to Sonnet. You edited the config and set the model to something garbled - `anthropicnnet-4-5` instead of `anthropic/claude-sonnet-4-5`.

**Root cause:**
You corrupted the model name while editing the config file. Characters were dropped or merged.

**Lesson:**
- When editing model names, use the EXACT string. Copy-paste, don't retype.
- Correct model names:
  - `openrouter/anthropic/claude-sonnet-4-5` (Sonnet - cheap, fast)
  - `openrouter/anthropic/claude-opus-4-6` (Opus - expensive, powerful)
- After ANY config edit, run `clawdbot models list` and verify the model shows up correctly before restarting.

---

## Incident 5: Model added to allowlist but not to provider definitions

**Date:** 2026-02-19
**Error:** `clawdbot models list` showed Sonnet as `missing`
**Impact:** Bot crashed with `Cannot read properties of undefined (reading 'includes')`

**What happened:**
You added Sonnet to `agents.defaults.models` (the allowlist) and set it as the primary model, but didn't add it to `models.providers.openrouter.models` (the provider definition).

**Root cause:**
The allowlist (`agents.defaults.models`) says "this model is allowed." The provider definition (`models.providers.openrouter.models`) says "this model exists and here are its capabilities." You need both.

**Lesson:**
- When adding a new model, you must add it in TWO places:
  1. `agents.defaults.models` - the allowlist (just `"openrouter/anthropic/claude-sonnet-4-5": {}`)
  2. `models.providers.openrouter.models` - the full definition with id, contextWindow, maxTokens, input, cost
- Always check `clawdbot models list` after changes. If a model shows `missing`, it needs a provider definition.

---

## Pre-flight checklist for config changes

Before restarting after ANY config change:

1. **Verify model names are exact** - no typos, correct version numbers
2. **Run `clawdbot models list`** - every model should show `configured` (not `missing`)
3. **Check `Auth` column** - should be `yes` for all providers you're using
4. **Check `auth.json` exists** - `ls ~/.clawdbot/agents/main/agent/auth.json`
5. **Only then restart** - `systemctl --user restart clawdbot-gateway`
6. **After restart, check logs** - `journalctl --user -u clawdbot-gateway --since '1 min ago' --no-pager | grep -i error`

## Current working config (2026-02-19)

- **Primary model:** `openrouter/anthropic/claude-sonnet-4-5`
- **Fallback:** `openrouter/anthropic/claude-opus-4-6`
- **Heartbeat:** every 6h on Gemini Flash
- **Cron:** morning check-in only (8 AM MT)
- **Provider:** OpenRouter (baseUrl: `https://openrouter.ai/api/v1`, api: `openai-completions`)
