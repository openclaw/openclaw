# OpenBodhi — Budget Control

API calls cost money. Without limits, a busy day of Telegram messages can burn through a month of budget in hours. This document explains how OpenBodhi's budget control works and how to configure it.

---

## How It Works

Every API call goes through `BudgetTracker` before execution:

1. **Pre-call check** — if today's spend has hit `dailyDollars`, the call is blocked and you get a budget-exhausted reply instead of an API call.
2. **Post-call record** — actual token usage (input, output, cache read, cache write) is recorded to `~/.openclaw/budget-state.json`.
3. **Alert** — when spend crosses `alertAt` percent of the daily limit, you receive a Telegram notification once per threshold crossing.

State is persisted atomically (temp file + rename) so it survives restarts.

---

## Configuration

Add a `budget` block to `openclaw.json`:

```json
{
  "budget": {
    "dailyDollars": 2.00,
    "weeklyDollars": 10.00,
    "alertAt": 0.80,
    "hardStop": true,
    "persistPath": "~/.openclaw/budget-state.json",
    "timezone": "UTC"
  }
}
```

| Field | Default | Description |
|-------|---------|-------------|
| `dailyDollars` | `2.00` | Hard daily ceiling in USD |
| `weeklyDollars` | `10.00` | Hard weekly ceiling in USD |
| `alertAt` | `0.80` | Fraction of daily limit that triggers an alert (0.80 = 80%) |
| `hardStop` | `true` | Block API calls when limit is reached (set `false` to alert-only) |
| `persistPath` | `~/.openclaw/budget-state.json` | Where daily/weekly state is saved |
| `timezone` | `"UTC"` | Timezone for day/week rollover |

**Recommended starting values:** `$2.00` daily, `$10.00` weekly. A wellness capture + enrichment costs roughly `$0.01–0.05` per message at `thinkingDefault: "low"`.

---

## Thinking Depth and Cost

The `thinkingDefault` setting in `agents.defaults` controls how much compute Claude spends per message:

| Level | Thinking tokens | Approx. cost/message |
|-------|----------------|----------------------|
| `low` | ~1 K | ~$0.02 |
| `medium` | ~4 K | ~$0.08 |
| `high` | ~16 K | ~$0.30 |

Set `thinkingDefault: "low"` for everyday captures. Use `/effort high` from the PM skill only when you need deep reasoning on a specific task.

```json
{
  "agents": {
    "defaults": {
      "thinkingDefault": "low"
    }
  }
}
```

---

## Checking Your Spend

Send `/usage` to your bot at any time. The skill reads `budget-state.json` directly — no API call, response in under one second:

```
📊 API Usage
Today:     $0.43 / $2.00  [██░░░░░░░░] 22%
This week: $1.87 / $10.00 [██░░░░░░░░] 19%
Resets:    midnight UTC · Sunday weekly
```

---

## Prompt Caching

OpenBodhi enables Anthropic prompt caching for all Claude models via `cacheRetention: "short"` in `openclaw.json`. Cached tokens (skill instructions that repeat on every message) cost 90% less than normal input tokens.

```json
{
  "agents": {
    "defaults": {
      "models": {
        "anthropic/claude-sonnet-4-6": { "cacheRetention": "short" },
        "anthropic/claude-haiku-4-5":  { "cacheRetention": "short" },
        "anthropic/claude-opus-4-6":   { "cacheRetention": "short" }
      }
    }
  }
}
```

`"short"` = 5-minute TTL. The first call writes to cache; subsequent calls within 5 minutes read from it.

---

## State File Format

`~/.openclaw/budget-state.json` example:

```json
{
  "day": "2026-03-10",
  "daySpend": 0.43,
  "weekStart": "2026-03-09",
  "weekSpend": 1.87,
  "lastAlertLevel": 0
}
```

- `day` — resets `daySpend` to `0` at midnight UTC
- `weekStart` — Sunday of current week; resets `weekSpend` to `0` weekly
- `lastAlertLevel` — prevents duplicate alerts (0 = no alert sent, 80 = 80% alert sent, 100 = limit hit)

**This file contains live spend data. It is in `.gitignore` and must never be committed.**

---

## Adjusting Limits

Edit `openclaw.json` and restart OpenClaw. Config hot-reloads for skill changes, but budget config requires a restart:

```bash
# Raise daily limit to $5
python3 -c "
import json, pathlib
cfg = pathlib.Path('~/.openclaw/openclaw.json').expanduser()
d = json.loads(cfg.read_text())
d['budget']['dailyDollars'] = 5.00
cfg.write_text(json.dumps(d, indent=2))
print('done')
"
pm2 restart openclaw   # or: systemctl restart openclaw
```

Or send `/model sonnet` and `/effort low` from Telegram to reduce per-message cost without touching config.
