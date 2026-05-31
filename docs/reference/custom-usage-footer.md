---
summary: "Customize the per-response /usage footer with a local renderer command"
read_when:
  - You want to customize the /usage footer
  - You are writing a messages.usageLine renderer
  - You need the usageLine JSON input contract
title: "Custom /usage footer"
---

OpenClaw can render the existing per-response `/usage` footer with a local
command. The command receives usage/context JSON on stdin and prints the footer
text on stdout.

The normal `/usage` command still controls whether a footer appears:

- `/usage off` disables the footer for the current session.
- `/usage tokens` appends a compact footer to normal replies.
- `/usage full` appends a fuller built-in footer to normal replies.

`messages.usageLine` only changes how that footer is rendered. A custom renderer
receives the same available JSON fields in both `tokens` and `full` modes; the
`mode` field is just a hint about the verbosity the user requested. If the
renderer fails, times out, prints nothing, or prints too much, OpenClaw falls
back to the built-in `Usage: ...` footer.

## Configure A Renderer

Use `messages.usageLine`:

```json
{
  "messages": {
    "usageLine": {
      "enabled": true,
      "timeoutMs": 1500,
      "maxOutputChars": 500,
      "maxOutputLines": 2,
      "command": "/home/me/.openclaw/usage-line/footer.py",
      "args": [],
      "format": "plain"
    }
  }
}
```

Surface-specific overrides let Discord, Telegram, TUI, or another surface use
different scripts:

```json
{
  "messages": {
    "usageLine": {
      "enabled": true,
      "timeoutMs": 1500,
      "maxOutputChars": 500,
      "maxOutputLines": 2,
      "surfaces": {
        "discord": {
          "command": "/home/me/.openclaw/usage-line/discord.py",
          "format": "plain"
        },
        "telegram": {
          "command": "/home/me/.openclaw/usage-line/telegram.py",
          "format": "preformatted"
        }
      }
    }
  }
}
```

Fields:

- `enabled`: set `false` to disable the renderer while preserving config.
- `command`: executable path. This is not a shell string.
- `args`: arguments passed to the executable without shell parsing.
- `format`: `plain`, `preformatted`, or `raw`.
- `timeoutMs`: renderer timeout. Default: `1500`.
- `maxOutputChars`: maximum accepted stdout characters. Default: `500`.
- `maxOutputLines`: maximum accepted stdout lines. Default: `2`.
- `surfaces`: per-surface overrides keyed by surface id, for example
  `discord` or `telegram`.

`plain` appends stdout as-is. `preformatted` wraps stdout in a `text` code block.
`raw` appends stdout as-is for scripts that deliberately own all formatting.

## Write A Renderer

Renderers read JSON from stdin and print the footer to stdout.

Minimal Python example:

```python
#!/usr/bin/env python3
import json
import sys

ctx = json.load(sys.stdin)
model = (ctx.get("model") or {}).get("display_name") or "model"
usage = ctx.get("usage") or {}
context = ctx.get("context") or {}

input_tokens = usage.get("input_tokens") or 0
output_tokens = usage.get("output_tokens") or 0
max_tokens = context.get("max_tokens") or "?"

print(f"{model} | ctx {max_tokens} | i/o {input_tokens}/{output_tokens}")
```

Make it executable:

```bash
chmod +x ~/.openclaw/usage-line/footer.py
```

Then enable the footer in the target chat:

```text
/usage tokens
```

The next normal reply should include the custom footer.

## JSON Input

The renderer receives a JSON object like this:

```json
{
  "schema": "openclaw.usageLine.v1",
  "mode": "tokens",
  "surface": "discord",
  "chat_type": "direct",
  "model": {
    "id": "gpt-5.5",
    "display_name": "gpt-5.5",
    "provider": "openai",
    "reasoning": "medium"
  },
  "usage": {
    "input_tokens": 774,
    "output_tokens": 196,
    "cache_read_tokens": 89000,
    "cache_write_tokens": 0,
    "total_tokens": 89970
  },
  "context": {
    "used_tokens": 147000,
    "max_tokens": 272000,
    "pct_used": 54
  },
  "cost": {
    "turn_usd": null,
    "available": true
  },
  "rendering": {
    "max_reasonable_chars": 220
  },
  "session": {
    "key": "agent:main:discord:direct:...",
    "id": "..."
  },
  "workspace": {
    "current_dir": "/home/me/project",
    "project_dir": "/home/me/project"
  },
  "timing": {
    "duration_ms": 9200
  }
}
```

Scripts should tolerate missing or null fields. Some providers do not report
every usage counter.

## Smoke Test

Run the script directly with sample JSON:

```bash
~/.openclaw/usage-line/footer.py <<'JSON'
{
  "schema": "openclaw.usageLine.v1",
  "mode": "tokens",
  "surface": "discord",
  "chat_type": "direct",
  "model": { "id": "gpt-5.5", "display_name": "GPT-5.5" },
  "usage": {
    "input_tokens": 774,
    "output_tokens": 196,
    "cache_read_tokens": 89000,
    "cache_write_tokens": 0,
    "total_tokens": 89970
  },
  "context": {
    "used_tokens": 147000,
    "max_tokens": 272000,
    "pct_used": 54
  },
  "cost": { "turn_usd": null, "available": true },
  "rendering": { "max_reasonable_chars": 220 }
}
JSON
```

Validate config after changing it:

```bash
openclaw config validate
```

## Safety Notes

The renderer runs as a local command from local config. Keep scripts lightweight
and deterministic:

- avoid network calls in the hot reply path;
- keep output within the configured line and character caps;
- handle missing values;
- exit nonzero when the script cannot render a valid footer so OpenClaw can
  fall back cleanly.

## Related

- [Token use and costs](/reference/token-use)
- [Usage tracking](/concepts/usage-tracking)
- [Slash commands](/tools/slash-commands)
