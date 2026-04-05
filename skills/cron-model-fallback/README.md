# cron-model-fallback

> Cron job model fallback chain for OpenClaw. Run your scheduled tasks even when your primary model is offline.

## The Problem

OpenClaw cron jobs accept a single model in `payload.model`. If that model fails (e.g., your local Ollama server is offline), the job fails silently — no retry, no fallback, just `lastRunStatus: "error"`.

This is especially painful when you want to use cheap local models (Ollama) as primary, with cloud models as backup.

## The Solution

`fallback.py` wraps your cron task and tries models in priority order:

```
Ollama (free, local) → Gemini Flash (free, cloud) → Groq (free, cloud) → ...
```

Each model is checked for reachability before attempting the task. The first available model runs the job.

## Quick Start

```bash
# Install
git clone https://github.com/YOUR_ORG/cron-model-fallback
cd cron-model-fallback

# Test your models
python3 fallback.py --test --models "google/gemini-2.5-flash,groq/llama-3.3-70b-versatile"

# Run a task
python3 fallback.py \
  --models "google/gemini-2.5-flash,groq/llama-3.3-70b-versatile" \
  --prompt "Summarize today's news and save to /tmp/news.md"
```

## Requirements

- Python 3.11+
- OpenClaw installed and running (`openclaw` in PATH)
- `requests` library: `pip install requests`

## Authentication

Set your OpenClaw token:

```bash
export OPENCLAW_TOKEN="your-token-here"
# Or store in ~/.openclaw/openclaw.json as gateway.auth.token
```

## Architecture

The script uses two strategies to check model reachability:

**Ollama models** (`custom-HOST-PORT/model`): Checks `/api/tags` endpoint directly. Fast, doesn't consume tokens.

**Cloud models** (Google, Groq, Anthropic, etc.): Checks OpenClaw gateway `/health` endpoint. If gateway is alive, cloud models are assumed reachable.

Once a reachable model is found, the task runs via:
```bash
openclaw agent --message "{prompt}" --agent klin --json
```

## Use in OpenClaw Cron Jobs

```json
{
  "name": "Nightly Research",
  "schedule": {"kind": "cron", "expr": "0 2 * * *", "tz": "Europe/Moscow"},
  "payload": {
    "kind": "agentTurn",
    "message": "python3 /path/to/fallback.py --models 'custom-YOUR-OLLAMA-11434/gemma3:27b,google/gemini-2.5-flash' --prompt 'Your research task'"
  }
}
```

## Security

- No hardcoded secrets anywhere in the codebase
- Token read from environment or config file only
- `subprocess` called with list args (no shell injection possible)
- No `eval()` or dynamic code execution

## Contributing

PRs welcome. See [SKILL.md](SKILL.md) for full API reference.

## License

MIT
