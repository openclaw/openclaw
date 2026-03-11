---
name: bodhi-budget
description: Show current API spend vs daily and weekly limits. Read budget-state.json and format as a usage report.
user-invocable: true
disable-model-invocation: false
triggers:
  - /usage
  - /budget
  - /spend
---

# bodhi-budget

Shows the current API spend against configured daily and weekly limits.

## On `/usage`, `/budget`, or `/spend`

Run:

```bash
python3 -c "
import json, pathlib, os
state_path = pathlib.Path(os.path.expanduser('~/.openclaw/budget-state.json'))
if not state_path.exists():
    print('NO_DATA')
else:
    d = json.loads(state_path.read_text())
    print(json.dumps(d))
"
```

Then also read the budget config from `~/.openclaw/openclaw.json`:

```bash
python3 -c "
import json, pathlib, os
cfg_path = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
if not cfg_path.exists():
    print('NO_CONFIG')
else:
    d = json.loads(cfg_path.read_text())
    budget = d.get('budget', {})
    print(json.dumps(budget))
"
```

Format the reply as:

```
📊 API Usage
Today:      $X.XX / $D.DD  [██████░░░░] 60%
This week:  $X.XX / $W.WW  [███░░░░░░░] 30%
Resets: midnight UTC · Sunday weekly
```

Where:
- Each `█` represents 10% of the limit
- The bar is always 10 chars wide
- Percentages are rounded to the nearest integer

## Rules

- No API call needed. Read files and format output only.
- If `budget-state.json` does not exist, reply: `No usage recorded yet. Send a message to start tracking.`
- If `openclaw.json` has no `budget` block, reply: `Budget tracking not configured. Add a "budget" block to openclaw.json.`
- Never expose raw file paths or API keys in the reply.
- Keep the reply short — just the formatted block above.
