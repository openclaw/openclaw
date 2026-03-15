---
name: trader-dashboard
description: Portfolio summary, P&L tracker, paper trade ledger, open/closed position management.
user-invocable: true
disable-model-invocation: false
triggers:
  - /dashboard
  - /pnl
  - /portfolio
---

# trader-dashboard

Portfolio command center. P&L tracking, open positions, trade ledger, performance metrics.

State file: `~/.openclaw/trader/risk-state.json`
Paper mode by default. Numbers first, always.

## On `/dashboard` or `/pnl`

Portfolio snapshot. Open positions, realized P&L, equity curve summary.

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, timezone

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
if not state_path.exists():
    print('No portfolio state. Use /dashboard init to set starting capital.')
    exit()

state = json.loads(state_path.read_text())
capital = state.get('capital', 1000)
closed_pnl = state.get('closed_pnl', 0)
open_positions = [p for p in state.get('positions', []) if p.get('status') == 'open']
mode = '[PAPER]' if not state.get('live_mode') else '[LIVE]'

open_pnl = sum(p.get('unrealized_pnl', 0) for p in open_positions)
equity = capital + closed_pnl + open_pnl
total_return = ((equity - capital) / capital * 100) if capital > 0 else 0

print(f'{mode} Portfolio snapshot:')
print(f'  Starting capital: \${capital:,.2f}')
print(f'  Current equity: \${equity:,.2f}')
print(f'  Realized P&L: \${closed_pnl:+,.2f}')
print(f'  Unrealized P&L: \${open_pnl:+,.2f}')
print(f'  Total return: {total_return:+.1f}%')
print(f'  Open positions: {len(open_positions)}')
print()
if open_positions:
    print('Open:')
    for p in open_positions:
        sym = p.get('symbol', '?')
        direction = p.get('direction', '?')
        entry = p.get('entry', 0)
        current = p.get('current_price', entry)
        upnl = p.get('unrealized_pnl', 0)
        print(f'  {sym} {direction} @ {entry} | now {current} | {upnl:+.2f}')
"
```

## On `/dashboard init [capital]`

Initialize portfolio with starting capital (paper).

```bash
python3 -c "
import json, pathlib, os, sys
from datetime import datetime, timezone

capital = float(sys.argv[1]) if len(sys.argv) > 1 else 1000.0

state = {
    'capital': capital,
    'peak_capital': capital,
    'closed_pnl': 0,
    'live_mode': False,
    'positions': [],
    'max_drawdown': 0,
    'initialized_at': datetime.now(timezone.utc).isoformat()
}

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
state_path.parent.mkdir(parents=True, exist_ok=True)
tmp = state_path.with_suffix('.tmp')
tmp.write_text(json.dumps(state, indent=2))
os.replace(tmp, state_path)
print(f'Portfolio initialized. Starting capital: \${capital:,.2f} [PAPER]')
print('Paper mode active. Real money: off.')
" <capital>
```

## On `/dashboard open [symbol] [direction] [entry] [stop] [target] [units]`

Open a new paper position.

```bash
python3 -c "
import json, pathlib, os, sys
from datetime import datetime, timezone

if len(sys.argv) < 7:
    print('Usage: /dashboard open <symbol> <long|short> <entry> <stop> <target> <units>')
    exit()

symbol = sys.argv[1].upper()
direction = sys.argv[2].upper()
entry = float(sys.argv[3])
stop = float(sys.argv[4])
target = float(sys.argv[5])
units = float(sys.argv[6])

risk_per_unit = abs(entry - stop)
dollar_risk = risk_per_unit * units
reward = abs(target - entry) * units
rr = round(reward / dollar_risk, 2) if dollar_risk > 0 else 0
position_value = entry * units

position = {
    'id': datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S'),
    'symbol': symbol,
    'direction': direction,
    'entry': entry,
    'stop': stop,
    'target': target,
    'units': units,
    'position_value': position_value,
    'dollar_risk': dollar_risk,
    'rr': f'1:{rr}',
    'current_price': entry,
    'unrealized_pnl': 0,
    'status': 'open',
    'opened_at': datetime.now(timezone.utc).isoformat(),
    'closed_at': None,
    'realized_r': None
}

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
if not state_path.exists():
    print('Run /dashboard init first.')
    exit()

state = json.loads(state_path.read_text())
state.setdefault('positions', []).append(position)
tmp = state_path.with_suffix('.tmp')
tmp.write_text(json.dumps(state, indent=2))
os.replace(tmp, state_path)

print(f'[PAPER] Opened: {symbol} {direction}')
print(f'  Entry: {entry} | Stop: {stop} | Target: {target}')
print(f'  Units: {units} | Position: \${position_value:,.2f}')
print(f'  Risk: \${dollar_risk:,.2f} | R:R: 1:{rr}')
" <symbol> <direction> <entry> <stop> <target> <units>
```

## On `/dashboard close [position_id] [exit_price]`

Close a position and record realized P&L in R-multiples.

```bash
python3 -c "
import json, pathlib, os, sys
from datetime import datetime, timezone

if len(sys.argv) < 3:
    print('Usage: /dashboard close <position_id> <exit_price>')
    exit()

pos_id = sys.argv[1]
exit_price = float(sys.argv[2])

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
state = json.loads(state_path.read_text())
found = None
for p in state.get('positions', []):
    if p.get('id') == pos_id and p.get('status') == 'open':
        found = p
        break

if not found:
    print(f'Position {pos_id} not found or already closed.')
    exit()

entry = found['entry']
stop = found['stop']
units = found['units']
direction = found['direction']
risk_per_unit = abs(entry - stop)

if direction == 'LONG':
    pnl = (exit_price - entry) * units
else:
    pnl = (entry - exit_price) * units

realized_r = pnl / (risk_per_unit * units) if risk_per_unit > 0 else 0

found['status'] = 'win' if pnl > 0 else ('loss' if pnl < 0 else 'breakeven')
found['exit_price'] = exit_price
found['unrealized_pnl'] = 0
found['realized_pnl'] = pnl
found['realized_r'] = round(realized_r, 2)
found['closed_at'] = datetime.now(timezone.utc).isoformat()

state['closed_pnl'] = state.get('closed_pnl', 0) + pnl
# Update peak capital
current_equity = state['capital'] + state['closed_pnl']
if current_equity > state.get('peak_capital', state['capital']):
    state['peak_capital'] = current_equity
# Update max drawdown
drawdown = state['peak_capital'] - current_equity
if drawdown > state.get('max_drawdown', 0):
    state['max_drawdown'] = drawdown

tmp = state_path.with_suffix('.tmp')
tmp.write_text(json.dumps(state, indent=2))
os.replace(tmp, state_path)

outcome = '✓ WIN' if pnl > 0 else ('✗ LOSS' if pnl < 0 else '— BREAK EVEN')
print(f'{outcome}: {found[\"symbol\"]} {direction}')
print(f'  Entry: {entry} → Exit: {exit_price}')
print(f'  P&L: \${pnl:+,.2f} ({realized_r:+.2f}R)')
" <position_id> <exit_price>
```

## On `/dashboard eod`

End-of-day summary. Today's trades, running equity, open positions status.

Show:
1. Today's closed trades (W/L count, total R)
2. Open positions (unrealized P&L at current prices)
3. Running equity vs. starting capital
4. Notable setup for tomorrow (from active signals if any)

Format: concise. Numbers first. Max 15 lines.

## On `/dashboard leaderboard`

All-time best trades by R-multiple. Top 10 wins and top 10 losses.

Learning tool: what setups worked, what failed.

```bash
python3 -c "
import json, pathlib, os

state_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
if not state_path.exists():
    print('No trade history.')
    exit()

state = json.loads(state_path.read_text())
closed = [p for p in state.get('positions', []) if p.get('status') in ['win', 'loss', 'breakeven']]
closed.sort(key=lambda x: x.get('realized_r', 0), reverse=True)

print(f'All-time: {len(closed)} closed trades')
print()
print('Best wins:')
for p in closed[:5]:
    print(f'  {p[\"symbol\"]} {p[\"direction\"]} | {p[\"realized_r\"]:+.2f}R | {(p.get(\"closed_at\") or \"\")[:10]}')
print()
print('Worst losses:')
for p in reversed(closed[-5:]):
    print(f'  {p[\"symbol\"]} {p[\"direction\"]} | {p[\"realized_r\"]:+.2f}R | {(p.get(\"closed_at\") or \"\")[:10]}')
"
```

## Rules

- Wrap all `float(sys.argv[N])` in try/except ValueError — print the usage string on failure, never expose a Python traceback.
- Wrap all `json.loads(state_path.read_text())` in try/except JSONDecodeError — print `Portfolio state corrupted. Backup at ~/.openclaw/trader/risk-state.json.bak`
- Paper mode is default. `[PAPER]` prefix on every trade output until live_mode enabled.
- Never auto-close positions. User confirms every close.
- P&L tracked in both dollar and R-multiples. R is the unit that matters.
- All timestamps UTC.
- State file uses atomic writes: temp file + os.replace().
- If state file corrupted: `Portfolio state corrupted. Backup at ~/.openclaw/trader/risk-state.json.bak`
- Every closed trade is permanent record. Never delete history.
