---
name: bodhi-budget
description: Show current API spend vs daily and weekly limits. Degradation warnings at 80%/95%. Budget reset notification support.
user-invocable: true
disable-model-invocation: false
triggers:
  - /usage
  - /budget
  - /spend
---

# bodhi-budget

Shows the current API spend against configured daily and weekly limits. Also surfaces degradation warnings when spend approaches or hits the hard stop.

## On `/usage`, `/budget`, or `/spend`

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/budget-state.json'))
cfg_path = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))

if not state_path.exists():
    print('NO_DATA')
else:
    d = json.loads(state_path.read_text())
    print('STATE:' + json.dumps(d))

if not cfg_path.exists():
    print('NO_CONFIG')
else:
    cfg = json.loads(cfg_path.read_text())
    budget = cfg.get('budget', {})
    print('CONFIG:' + json.dumps(budget))
"
```

Parse the STATE and CONFIG lines. Then compute:

- `daily_pct` = `today_spend / daily_limit × 100`
- `weekly_pct` = `week_spend / weekly_limit × 100`

Format the reply as:

```
📊 API Usage
Today:      $X.XX / $D.DD  [██████░░░░] 60%
This week:  $X.XX / $W.WW  [███░░░░░░░] 30%
Resets: midnight UTC · Sunday weekly
```

Where each `█` = 10% of the limit (10-char bar, always).

---

## Degradation tiers (auto-surface when reading state)

Read budget percentages and append a tier warning when thresholds are crossed:

### Tier 1 — 80%+ daily spend

```
⚠ 80% daily budget used. Consider switching to a lighter model:
/model haiku — saves ~5× on most queries
Current model: [read from openclaw.json agents.defaults.model]
```

### Tier 2 — 95%+ daily spend

```
🔴 95% daily budget — near hard stop.
Remaining: ~$X.XX
Use /log to capture thoughts offline (no LLM cost).
Budget resets at midnight UTC.
```

### Tier 3 — hard stop hit (100%)

When `today_spend >= daily_limit`:

```
🛑 Daily budget exhausted ($D.DD).
Resets in ~Xh Ym (midnight UTC).

Use /log [thought] to capture without API cost.
SiYuan is still reachable at your configured SIYUAN_API_URL — add items manually.
```

To compute "resets in":

```bash
python3 -c "
from datetime import datetime, timezone, timedelta
now = datetime.now(timezone.utc)
midnight = (now + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
delta = midnight - now
hours = int(delta.total_seconds() // 3600)
mins = int((delta.total_seconds() % 3600) // 60)
print(f'{hours}h {mins}m')
"
```

---

## Rules

- No API call needed to read state. File read + format only.
- If `budget-state.json` does not exist: `No usage recorded yet. Send a message to start tracking.`
- If `openclaw.json` has no `budget` block: `Budget tracking not configured. Add a "budget" block to openclaw.json.`
- Never expose raw file paths or API keys.
- Degradation warnings are informational, not alarming. Keep tone calm and specific.
- `/log` is available even when budget is exhausted — always mention it at Tier 2+.
