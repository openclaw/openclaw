---
name: trader-signals
description: Real-time signal feed — active alerts, TradingView webhook intake, Telegram push for edge setups.
user-invocable: true
disable-model-invocation: false
triggers:
  - /signals
  - /alerts
---

# trader-signals

Active trading signals and alert management. Receives TradingView webhooks, stores signals, pushes to Telegram when edge threshold met.

Signal state file: `~/.openclaw/trader/signals.json`
Config file: `~/.openclaw/trader/config.json`

## On `/signals`

Show active signals. What's live right now.

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, timezone

signals_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/signals.json'))
if not signals_path.exists():
    print('No signals yet. Set up TradingView alerts with n8n webhook.')
    exit()

data = json.loads(signals_path.read_text())
signals = data.get('signals', [])
active = [s for s in signals if s.get('status') == 'active']

if not active:
    print('No active signals. Markets quiet or no setups with edge.')
else:
    print(f'{len(active)} active signals:')
    for s in active[:10]:
        symbol = s.get('symbol', '?')
        direction = s.get('direction', '?')
        entry = s.get('entry', '?')
        rr = s.get('rr', '?')
        confidence = s.get('confidence', '?')
        age = s.get('timestamp', '')[:16]
        print(f'  {symbol} {direction} | entry {entry} | R:R {rr} | {confidence} | {age}')
"
```

## On `/signals history [n]`

Last N signals (default 20). All statuses — hit, stopped, expired.

```bash
python3 -c "
import json, pathlib, os, sys

n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
signals_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/signals.json'))
if not signals_path.exists():
    print('No signal history.')
    exit()

data = json.loads(signals_path.read_text())
signals = sorted(data.get('signals', []), key=lambda x: x.get('timestamp', ''), reverse=True)

print(f'Last {min(n, len(signals))} signals:')
for s in signals[:n]:
    symbol = s.get('symbol', '?')
    direction = s.get('direction', '?')
    status = s.get('status', '?')
    rr = s.get('rr', '?')
    ts = s.get('timestamp', '')[:10]
    print(f'  {ts} | {symbol} {direction} | R:R {rr} | {status}')
" <n>
```

## On `/signals add [symbol] [direction] [entry] [stop] [target]`

Manually add a signal to the feed.

```bash
python3 -c "
import json, pathlib, os, sys
from datetime import datetime, timezone

if len(sys.argv) < 6:
    print('Usage: /signals add <symbol> <long|short> <entry> <stop> <target>')
    exit()

symbol = sys.argv[1].upper()
direction = sys.argv[2].upper()
entry = float(sys.argv[3])
stop = float(sys.argv[4])
target = float(sys.argv[5])

# Calculate R:R
risk = abs(entry - stop)
reward = abs(target - entry)
rr = round(reward / risk, 2) if risk > 0 else 0

signal = {
    'symbol': symbol,
    'direction': direction,
    'entry': entry,
    'stop': stop,
    'target': target,
    'rr': f'1:{rr}',
    'status': 'active',
    'source': 'manual',
    'timestamp': datetime.now(timezone.utc).isoformat(),
    'confidence': 'MED'
}

signals_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/signals.json'))
signals_path.parent.mkdir(parents=True, exist_ok=True)
data = json.loads(signals_path.read_text()) if signals_path.exists() else {'signals': []}
data['signals'].insert(0, signal)
tmp = signals_path.with_suffix('.tmp')
tmp.write_text(json.dumps(data, indent=2))
os.replace(tmp, signals_path)

print(f'Signal added: {symbol} {direction}')
print(f'  Entry: {entry} | Stop: {stop} | Target: {target}')
print(f'  R:R: 1:{rr}')
" <symbol> <direction> <entry> <stop> <target>
```

## On `/signals clear [symbol]`

Remove a signal from active feed. Mark as expired.

```bash
python3 -c "
import json, pathlib, os, sys
from datetime import datetime, timezone

symbol = sys.argv[1].upper() if len(sys.argv) > 1 else ''
if not symbol:
    print('Usage: /signals clear <symbol>')
    exit()

signals_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/signals.json'))
if not signals_path.exists():
    print('No signals file.')
    exit()

data = json.loads(signals_path.read_text())
cleared = 0
for s in data.get('signals', []):
    if s.get('symbol') == symbol and s.get('status') == 'active':
        s['status'] = 'expired'
        cleared += 1

tmp = signals_path.with_suffix('.tmp')
tmp.write_text(json.dumps(data, indent=2))
os.replace(tmp, signals_path)
print(f'Cleared {cleared} active signal(s) for {symbol}.')
" <symbol>
```

## TradingView Webhook Integration

Webhook receiver configured via n8n. Incoming payload format expected:
```json
{
  "symbol": "BTCUSDT",
  "direction": "LONG",
  "entry": 67420,
  "stop": 65800,
  "target": 71200,
  "confidence": "HIGH",
  "signal_type": "break-and-retest",
  "timeframe": "4h"
}
```

n8n workflow writes to `~/.openclaw/trader/signals.json` and sends Telegram push.
Webhook URL stored in `~/.openclaw/trader/config.json` under key `n8n_webhook`.

## Rules

- Wrap all `float(sys.argv[N])` in try/except ValueError — print the usage string on failure, never expose a Python traceback.
- R:R minimum for signal acceptance: 1:1.5. Below that: `R:R too low — not worth tracking.`
- Paper first. Every signal reply includes `[PAPER ONLY]` until user enables live mode.
- Never post entry/stop/target on a signal with < 1:1.5 R:R.
- Confidence tiers: HIGH = 3+ confluent signals, MED = 2 signals, LOW = 1 signal + thesis.
- Auto-expire signals older than 72 hours with no status update.
- Signal history kept forever. Never delete — audit trail.
