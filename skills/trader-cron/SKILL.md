---
name: trader-cron
description: Scheduled trading routines — daily briefing, market open/close rituals, weekly review, cron management.
user-invocable: true
disable-model-invocation: false
triggers:
  - /cron
  - /schedule
  - /routine
---

# trader-cron

Scheduled market routines. Morning briefing, EOD review, weekly P&L summary.

Cron state: `~/.openclaw/trader/cron-config.json`
All times UTC.

## On `/cron status`

What routines are scheduled. Next run times.

```bash
python3 -c "
import json, pathlib, os

config_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/cron-config.json'))
if not config_path.exists():
    print('No cron config. Use /cron setup to initialize default routines.')
    exit()

config = json.loads(config_path.read_text())
routines = config.get('routines', [])
print(f'{len(routines)} scheduled routines:')
for r in routines:
    name = r.get('name', '?')
    schedule = r.get('schedule', '?')
    enabled = '✓' if r.get('enabled', False) else '✗'
    last_run = r.get('last_run', 'never')[:16]
    print(f'  {enabled} {name} | {schedule} | last: {last_run}')
"
```

## On `/cron setup`

Initialize default trading routine schedule.

```bash
python3 -c "
import json, pathlib, os

config_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/cron-config.json'))
config_path.parent.mkdir(parents=True, exist_ok=True)

default_routines = [
    {
        'name': 'morning-briefing',
        'schedule': '0 8 * * 1-5',
        'description': 'Pre-market scan — overnight moves, macro news, key levels for the day',
        'enabled': True,
        'last_run': None,
        'skill': 'trader-scan',
        'command': '/scan crypto 4h'
    },
    {
        'name': 'eod-review',
        'schedule': '0 22 * * 1-5',
        'description': 'End-of-day: P&L check, open positions, setups for tomorrow',
        'enabled': True,
        'last_run': None,
        'skill': 'trader-dashboard',
        'command': '/dashboard eod'
    },
    {
        'name': 'weekly-review',
        'schedule': '0 10 * * 0',
        'description': 'Weekly edge audit — win rate, R:R realized, what worked, what decayed',
        'enabled': True,
        'last_run': None,
        'skill': 'trader-risk',
        'command': '/risk weekly'
    },
    {
        'name': 'polymarket-pulse',
        'schedule': '0 */4 * * *',
        'description': 'Every 4h Polymarket scan for arb and high-edge markets',
        'enabled': False,
        'last_run': None,
        'skill': 'trader-scan',
        'command': '/scan polymarket'
    }
]

config = {'routines': default_routines}
tmp = config_path.with_suffix('.tmp')
tmp.write_text(json.dumps(config, indent=2))
os.replace(tmp, config_path)
print('Default routines initialized:')
for r in default_routines:
    status = '✓' if r['enabled'] else '✗'
    print(f'  {status} {r[\"name\"]} — {r[\"schedule\"]}')
"
```

## On `/cron enable [routine]` / `/cron disable [routine]`

Toggle a routine on or off.

```bash
python3 -c "
import json, pathlib, os, sys

if len(sys.argv) < 3:
    print('Usage: /cron enable|disable <routine-name>')
    exit()

action = sys.argv[1]
name = sys.argv[2]
enable = action == 'enable'

config_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/cron-config.json'))
if not config_path.exists():
    print('No cron config. Run /cron setup first.')
    exit()

config = json.loads(config_path.read_text())
found = False
for r in config.get('routines', []):
    if r.get('name') == name:
        r['enabled'] = enable
        found = True
        break

if not found:
    print(f'Routine \"{name}\" not found.')
    exit()

tmp = config_path.with_suffix('.tmp')
tmp.write_text(json.dumps(config, indent=2))
os.replace(tmp, config_path)
print(f'{name}: {\"enabled\" if enable else \"disabled\"}')
" <action> <routine>
```

## On `/cron run [routine]`

Manually trigger a routine now, outside its schedule.

Parse the `command` field from the routine config and route to the appropriate skill.
Example: `morning-briefing` runs `/scan crypto 4h`.

Output: same as the underlying skill command, prefixed with `[MANUAL RUN] morning-briefing:`

## Default Routine Behaviors

**morning-briefing** (08:00 UTC, weekdays):
1. Pull overnight BTC/ETH/SOL moves
2. Scan for 4h setups formed overnight
3. Flag any Polymarket arb opportunities
4. Key support/resistance levels to watch
5. Format: concise brief, numbers first, max 10 lines

**eod-review** (22:00 UTC, weekdays):
1. Open positions and their current status
2. P&L for the day (paper only until live mode enabled)
3. Any signals that triggered or expired
4. Setup candidates for tomorrow

**weekly-review** (10:00 UTC, Sunday):
1. Win rate for the week
2. Average R:R realized vs. planned
3. Best and worst trades
4. Edge decay check: are strategies still working?
5. Adjustments for next week

**polymarket-pulse** (every 4h, disabled by default):
1. Quick arb scan — any YES + NO < $1.00?
2. High-edge markets (odds diverge >15% from base rate)
3. Closing-soon markets with volatile odds

## Rules

- Routines fire via n8n or OpenClaw cron — this skill manages config only.
- Telegram delivery: all routine outputs push to Telegram as scheduled messages.
- If a routine errors: `[CRON ERROR] <routine-name> — check trader/cron-config.json`
- Weekend routines: only weekly-review runs. Morning briefing and EOD are weekday-only.
- All times UTC. No local timezone assumptions.
- "Paper first always" applies to all routine output — no live position suggestions without explicit enable.
