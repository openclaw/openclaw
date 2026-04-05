---
name: cron-model-fallback
description: "Cron job model fallback chain for OpenClaw. User-configurable model priority chain — tries each in order until one succeeds. No provider-specific logic."
homepage: https://looi.ru/a/looi-clawd
metadata:
  author: Arthur Arsyonov
  license: MIT
---

# cron-model-fallback

**User-configurable model fallback chain for OpenClaw cron jobs.**

Your cron job says "use model X". Model X is down. Job fails silently. This script fixes that — configure a priority chain, it tries each model until one works.

## Problem

OpenClaw cron jobs accept a single model. If that model is unreachable, the job fails silently — no retry, no fallback, just `lastRunStatus: "error"`.

## Solution

A zero-dependency wrapper that:
1. Takes a list of models in priority order (CLI flag or config file)
2. Calls `openclaw agent --model <model>` for each, in order
3. Returns the first successful response
4. No provider-specific logic — works with any model OpenClaw supports

## Usage

```bash
# Explicit chain
python3 fallback.py \
  --models "anthropic/claude-sonnet-4,google/gemini-2.5-flash,groq/llama-3.3-70b" \
  --prompt "Summarize today's news"

# Defaults from config (see Configuration below)
python3 fallback.py --prompt "Your task"

# With a specific agent
python3 fallback.py \
  --models "google/gemini-2.5-flash,anthropic/claude-haiku-4-5" \
  --agent my-agent --prompt "Your task"
```

## Configuration

### Default fallback chain (optional)

Add to `~/.openclaw/openclaw.json`:

```json
{
  "cron": {
    "fallbackModels": [
      "anthropic/claude-sonnet-4",
      "google/gemini-2.5-flash",
      "groq/llama-3.3-70b-versatile"
    ]
  }
}
```

When `--models` is omitted, the script reads this array. This means every cron job inherits the same fallback chain without per-job configuration.

### Authentication

Token is read from (in priority order):
1. `OPENCLAW_TOKEN` environment variable
2. `~/.openclaw/openclaw.json` → `gateway.auth.token`

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--models` | from config | Comma-separated model list, first = most preferred |
| `--prompt` | — | Task prompt string |
| `--prompt-file` | — | Path to file containing the prompt |
| `--agent` | (default) | OpenClaw agent name (optional) |
| `--timeout` | 120 | Seconds to wait per model attempt |
| `--max-tokens` | 4096 | Maximum tokens in the response |
| `--quiet` | false | Suppress progress output |

## Architecture

```
fallback.py
  │
  ├─ Resolve model chain: --models flag → cron.fallbackModels config
  │
  └─ For each model:
       └─ openclaw agent --model {model} --message {prompt} --json
          ├─ Success → print result, exit 0
          └─ Failure → try next model
```

No provider-specific code. No health checks. No API parsing. Just: call the CLI, check the exit code.

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | All models failed |
| 2 | Configuration error (no models, no token, no prompt) |

## Requirements

- Python 3.8+ (stdlib only, no pip dependencies)
- OpenClaw CLI in PATH
