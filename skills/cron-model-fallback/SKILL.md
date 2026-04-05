---
name: cron-model-fallback
description: "Cron job model fallback chain for OpenClaw. Tries models in priority order until one succeeds. Solves silent cron failures when a provider is unavailable."
homepage: https://looi.ru/a/looi-clawd
metadata:
  author: Arthur Arsyonov
  license: MIT
---

# cron-model-fallback

**Cron job model fallback chain for OpenClaw.**

Tries models in priority order until one succeeds. Solves the problem of silent cron job failures when a model provider is unavailable (e.g., local Ollama is offline).

## Problem

OpenClaw cron jobs accept a single `model` string in `payload.model`. If that model is unreachable, the job fails silently with `lastRunStatus: "error"` — no retry, no fallback.

## Solution

A wrapper script that:
1. Checks each model for reachability before attempting (skippable with `--skip-reachability`)
2. Passes the selected model explicitly via `--model` flag to `openclaw agent`
3. Tries the next model in the chain if the current one fails
4. Logs which model was used and how many attempts were made

## Installation

```bash
# Place in your OpenClaw workspace skills directory
cp -r cron-model-fallback/ ~/.openclaw/workspace/skills/

# Install dependency
pip3 install requests
```

## Usage

### Direct CLI

```bash
# Test model availability
python3 fallback.py --test --models "ollama/gemma3:12b,google/gemini-2.5-flash,groq/llama-3.3-70b"

# Run a task with fallback
python3 fallback.py \
  --models "ollama/gemma3:12b,google/gemini-2.5-flash" \
  --prompt "Your cron task prompt here"

# Use a specific agent
python3 fallback.py \
  --models "ollama/gemma3:12b,google/gemini-2.5-flash" \
  --agent my-agent --prompt "Your task"
```

## Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--models` | required | Comma-separated model list, first = most preferred |
| `--prompt` | — | Task prompt string |
| `--prompt-file` | — | Path to file containing the prompt |
| `--agent` | (default agent) | OpenClaw agent name (optional) |
| `--timeout` | 120 | Seconds to wait per model attempt |
| `--max-tokens` | 4096 | Maximum tokens in the response |
| `--test` | false | Test reachability only, don't run task |
| `--quiet` | false | Suppress progress output |
| `--skip-reachability` | false | Skip pre-checks, just try each model |
| `--base-url` | from env or localhost | OpenClaw gateway URL |

## Architecture

```
fallback.py
  │
  ├─ For each model in priority order:
  │   ├─ Check reachability (unless --skip-reachability):
  │   │   ├─ Ollama models → GET {ollama_host}/api/tags
  │   │   └─ Cloud models → GET {gateway}/health
  │   │
  │   └─ Run task: openclaw agent --message {prompt} --model {model} --json
  │
  └─ First successful response → stdout
```

## Authentication

Token is read from (in priority order):
1. `OPENCLAW_TOKEN` environment variable
2. `~/.openclaw/openclaw.json` → `gateway.auth.token`

**Never hardcode tokens in cron job definitions.**

## Model String Format

| Provider | Format | Example |
|----------|--------|---------|
| Ollama (local) | `custom-HOST-PORT/model:tag` | `custom-localhost-11434/gemma3:27b` |
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
