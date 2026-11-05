---
name: discord-clawd
description: Use to talk to the Discord-backed OpenClaw agent/session; not for archive search.
---

# Discord Clawd

Use this when the task is to talk with the Discord-backed agent/session, ask it a question, or post through that route.

For Discord archive/history/search, use `$discrawl` instead.

## Transport

Use the installed [OpenClaw relay skill](https://github.com/steipete/agent-scripts/tree/main/skills/openclaw-relay).
Read its instructions and resolve its physical skill directory. Set
`relay_script` below to that directory's `scripts/openclaw_relay.py`; report a
missing installation instead of guessing a checkout path. Keep the selected
OpenClaw checkout as the shell cwd for the default local transport. The relay's
instructions own remote transport and target configuration.

```bash
relay_script="/path/to/installed/openclaw-relay/scripts/openclaw_relay.py"
python3 "$relay_script" targets
python3 "$relay_script" resolve --target maintainers
```

If the target alias exists, prefer a private ask first:

```bash
python3 "$relay_script" ask \
  --target maintainers \
  --message "Reply with exactly OK."
```

Use `publish` when the session should decide whether to post. Use `force-send` only when the user explicitly wants a message posted.

## Guardrails

- Resolve the target before sending real content.
- Report the target and delivery mode used.
- Do not use this for local Discord archive queries.
- Do not expose gateway tokens or session secrets.
