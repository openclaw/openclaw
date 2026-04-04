---
name: freeride
description: Manages free AI models from OpenRouter for OpenClaw. Automatically ranks models by quality, configures fallbacks for rate-limit handling, and updates openclaw.json. Use when the user mentions free AI, OpenRouter, model switching, rate limits, or wants to reduce AI costs.
---

# FreeRide - Free AI for OpenClaw

## What This Skill Does

Configures OpenClaw to use **free** AI models from OpenRouter. Sets the best free model as primary, adds ranked fallbacks so rate limits don't interrupt the user, and preserves existing config.

## Prerequisites

Before running any FreeRide command, ensure:

1. **OPENROUTER_API_KEY is set.** Check with `echo $OPENROUTER_API_KEY`. If empty, the user must get a free key at https://openrouter.ai/keys and set it:

   ```bash
   export OPENROUTER_API_KEY="sk-or-v1-..."
   # Or persist it:
   openclaw config set env.OPENROUTER_API_KEY "sk-or-v1-..."
   ```

2. **The `freeride` CLI is installed.** Check with `which freeride`. If not found:
   ```bash
   cd ~/.openclaw/workspace/skills/free-ride
   pip install -e .
   ```

## Primary Workflow

When the user wants free AI, run these steps in order:

```bash
# Step 1: Configure best free model + fallbacks
freeride auto

# Step 2: Restart gateway so OpenClaw picks up the changes
openclaw gateway restart
```

That's it. The user now has free AI with automatic fallback switching.

Verify by telling the user to send `/status` to check the active model.

## Commands Reference

| Command                      | When to use it                                                     |
| ---------------------------- | ------------------------------------------------------------------ |
| `freeride auto`              | User wants free AI set up (most common)                            |
| `freeride auto -f`           | User wants fallbacks but wants to keep their current primary model |
| `freeride auto -c 10`        | User wants more fallbacks (default is 5)                           |
| `freeride list`              | User wants to see available free models                            |
| `freeride list -n 30`        | User wants to see all free models                                  |
| `freeride switch <model>`    | User wants a specific model (e.g. `freeride switch qwen3-coder`)   |
| `freeride switch <model> -f` | Add specific model as fallback only                                |
| `freeride status`            | Check current FreeRide configuration                               |
| `freeride fallbacks`         | Update only the fallback models                                    |
| `freeride refresh`           | Force refresh the cached model list                                |

**After any command that changes config, always run `openclaw gateway restart`.**

## What It Writes to Config

FreeRide updates only these keys in `~/.openclaw/openclaw.json`:

- `agents.defaults.model.primary` — e.g. `openrouter/qwen/qwen3-coder:free`
- `agents.defaults.model.fallbacks` — e.g. `["openrouter/free", "nvidia/nemotron:free", ...]`
- `agents.defaults.models` — allowlist so `/model` command shows the free models

Everything else (gateway, channels, plugins, env, customInstructions, named agents) is preserved.

The first fallback is always `openrouter/free` — OpenRouter's smart router that auto-picks the best available model based on the request.

## Watcher (Optional)

For auto-rotation when rate limited, the user can run:

```bash
freeride-watcher --daemon    # Continuous monitoring
freeride-watcher --rotate    # Force rotate now
freeride-watcher --status    # Check rotation history
```

## Troubleshooting

| Problem                       | Fix                                                                              |
| ----------------------------- | -------------------------------------------------------------------------------- |
| `freeride: command not found` | `cd ~/.openclaw/workspace/skills/free-ride && pip install -e .`                  |
| `OPENROUTER_API_KEY not set`  | User needs a key from https://openrouter.ai/keys                                 |
| Changes not taking effect     | `openclaw gateway restart` then `/new` for fresh session                         |
| Agent shows 0 tokens          | Check `freeride status` — primary should be `openrouter/<provider>/<model>:free` |
