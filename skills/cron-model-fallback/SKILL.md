# cron-model-fallback

**Cron job model fallback chain for OpenClaw.**

Tries models in priority order until one succeeds. Solves the problem of silent cron job failures when a model provider is unavailable (e.g., local Ollama is offline).

## Problem

OpenClaw cron jobs accept a single `model` string in `payload.model`. If that model is unreachable, the job fails silently with `lastRunStatus: "error"` — no retry, no fallback.

## Solution

A wrapper script that:
1. Checks each model in priority order for reachability
2. Runs the task with the first available model via `openclaw agent --message`
3. Logs which model was used and how many attempts were made

## Installation

```bash
# Manual install
cp fallback.py /usr/local/bin/cron-model-fallback
chmod +x /usr/local/bin/cron-model-fallback

# Or place in your OpenClaw workspace skills directory
```

## Usage

### Direct CLI

```bash
# Test model availability
python3 fallback.py --test --models "ollama-host/gemma3:12b,google/gemini-2.5-flash,groq/llama-3.3-70b"

# Run a task with fallback
python3 fallback.py \
  --models "ollama-host/gemma3:12b,google/gemini-2.5-flash" \
  --prompt "Your cron task prompt here"
```

### In OpenClaw Cron Jobs

Instead of a single model, use this script as the cron task:

```json
{
  "name": "My Nightly Task",
  "schedule": {"kind": "cron", "expr": "0 2 * * *"},
  "payload": {
    "kind": "agentTurn",
    "message": "python3 /path/to/fallback.py --models 'custom-YOUR-OLLAMA-HOST-11434/gemma3:27b-it-qat,google/gemini-2.5-flash,groq/llama-3.3-70b-versatile' --prompt 'Your actual task prompt here'"
  }
}
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--models` | required | Comma-separated model list, first = most preferred |
| `--prompt` | — | Task prompt string |
| `--prompt-file` | — | Path to file containing the prompt |
| `--timeout` | 30 | Seconds to wait per model attempt |
| `--test` | false | Test reachability only, don't run task |
| `--quiet` | false | Suppress progress output |
| `--base-url` | http://127.0.0.1:18789 | OpenClaw gateway URL |

## Architecture

```
fallback.py
  │
  ├─ For each model in priority order:
  │   ├─ Ollama models → GET {ollama_host}/api/tags (check model exists)
  │   └─ Cloud models → GET {openclaw_gateway}/health (check gateway alive)
  │
  └─ First reachable model → subprocess: openclaw agent --message {prompt} --json
```

## Authentication

Token is read from (in priority order):
1. `OPENCLAW_TOKEN` environment variable
2. `~/.openclaw/openclaw.json` → `gateway.auth.token`

**Never hardcode tokens in cron job definitions.**

## Model String Format

| Provider | Format | Example |
|----------|--------|---------|
| Ollama (local) | `custom-HOST-PORT/model:tag` | `custom-YOUR-OLLAMA-HOST-11434/gemma3:27b-it-qat` |
| Google | `google/model-id` | `google/gemini-2.5-flash` |
| Groq | `groq/model-id` | `groq/llama-3.3-70b-versatile` |
| Anthropic | `anthropic/model-id` | `anthropic/claude-haiku-4-5` |

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | All models failed |
| 2 | Configuration error |
| 3 | Test mode: no models reachable |
