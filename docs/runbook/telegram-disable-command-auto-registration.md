---
title: "Disable Telegram Command Auto Registration"
summary: "Stop Telegram setMyCommands attempts that can fail with BOT_COMMAND_INVALID."
---

## Symptoms

- Logs show: `setMyCommands failed (400: Bad Request: BOT_COMMAND_INVALID)`

## Cause

- Telegram bot commands must match regex `^[a-z0-9_]{1,32}$`
- Auto-generated commands (for example, hyphenated or mixed-case skill names) can violate this.

## Workaround (No Code Change)

- Disable native command auto-registration in `~/.openclaw/openclaw.json`:

```json5
{
  commands: {
    native: "off",
    nativeSkills: "off",
  },
}
```

- Restart gateway:

```bash
docker compose --env-file .env.local restart openclaw-gateway
```

This does **not** disable Telegram messaging. It only stops OpenClaw from attempting Telegram `setMyCommands`.

## Verify

```bash
docker compose --env-file .env.local logs --since=5m openclaw-gateway | grep -i telegram
```

- Confirm no `BOT_COMMAND_INVALID` entries.
