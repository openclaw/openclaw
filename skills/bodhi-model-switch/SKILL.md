---
name: bodhi-model-switch
description: Switch the active AI model. Supports Anthropic and all OpenRouter models.
triggers:
  - /claude
user-invocable: true
disable-model-invocation: false
---

# bodhi-model-switch

Switches the gateway model by editing `~/.openclaw/openclaw.json`. The gateway hot-reloads within ~3 seconds — no restart needed.

## On `/claude`

Switch to Anthropic Claude Sonnet (direct API, vision enabled).

```bash
python3 -c "
import json, os, pathlib
cfg = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
d = json.loads(cfg.read_text())
d['agents']['defaults']['model'] = {'primary': 'anthropic/claude-sonnet-4-6', 'fallbacks': ['openrouter/kimi/kimi-2.5:free']}
d['agents']['defaults']['thinkingDefault'] = 'low'
tmp = cfg.with_suffix('.tmp')
tmp.write_text(json.dumps(d, indent=2))
tmp.replace(cfg)
print('switched')
"
```

Reply: `Model → anthropic/claude-sonnet-4-6 🟢`

## Rules

- Run the bash command, then reply with the status line. Nothing else.
- Never expose the config file path or token in the reply.
- If the command fails, reply: `Switch failed — check server logs.`
