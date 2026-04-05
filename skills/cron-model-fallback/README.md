# cron-model-fallback

> Model fallback chain for OpenClaw cron jobs. Configure your priority list — the script tries each model until one works.

**Author:** [Arthur Arsyonov](https://looi.ru) · **License:** MIT

## The Problem

OpenClaw cron jobs use a single model. When that model's provider is down, the job fails silently. No retry, no fallback.

## The Solution

A Python script (stdlib only, zero dependencies) that wraps `openclaw agent` with a configurable fallback chain:

```
anthropic/claude-sonnet-4 → FAIL → google/gemini-2.5-flash → FAIL → groq/llama-3.3-70b → SUCCESS
```

## Quick Start

```bash
# 1. Place in your skills directory
cp -r cron-model-fallback/ ~/.openclaw/workspace/skills/

# 2. Run with explicit models
python3 fallback.py \
  --models "anthropic/claude-sonnet-4,google/gemini-2.5-flash" \
  --prompt "Summarize today's events"

# 3. Or configure defaults in openclaw.json
```

### Configure default chain

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

Then every cron job gets fallback for free:

```bash
python3 fallback.py --prompt "Your cron task"
```

## How It Works

1. Reads model list from `--models` flag or `cron.fallbackModels` config
2. For each model, calls: `openclaw agent --model <model> --message <prompt> --json`
3. If the CLI returns non-zero or empty output → try the next model
4. First successful response goes to stdout

No provider-specific logic. No HTTP health checks. No external dependencies. Just the OpenClaw CLI and a for-loop.

## Requirements

- Python 3.8+
- OpenClaw CLI in PATH
- Auth token (env var `OPENCLAW_TOKEN` or in `openclaw.json`)

## Related

- [Full guide](https://looi.ru/a/looi-clawd) — detailed article on the architecture
