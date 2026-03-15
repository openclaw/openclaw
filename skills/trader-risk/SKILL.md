---
name: trader-risk
description: Position sizing, portfolio exposure, Kelly criterion, drawdown tracking, risk management rules.
user-invocable: true
disable-model-invocation: false
triggers:
  - /risk
  - /size
  - /kelly
---

# trader-risk

Risk management is the strategy. Position sizing, exposure limits, drawdown tracking.

Risk state: `~/.openclaw/trader/risk-state.json`
Default capital (paper): $1,000 (set at initialization).

## On `/risk size [capital] [entry] [stop] [risk_pct]`

Position size calculator. How many units to buy given your risk parameters.

```bash
python3 -c "
import sys

if len(sys.argv) < 4:
    print('Usage: /risk size <capital> <entry> <stop> [risk_pct]')
    print('Example: /risk size 1000 67420 65800 1')
    exit()

capital = float(sys.argv[1])
entry = float(sys.argv[2])
stop = float(sys.argv[3])
risk_pct = float(sys.argv[4]) if len(sys.argv) > 4 else 1.0  # Default: 1% per trade

risk_per_unit = abs(entry - stop)
if risk_per_unit == 0:
    print('Error: entry and stop cannot be the same.')
    exit()

dollar_risk = capital * (risk_pct / 100)
units = dollar_risk / risk_per_unit
position_value = units * entry
position_pct = (position_value / capital) * 100

print(f'Capital: \${capital:,.2f}')
print(f'Risk per trade: {risk_pct}% = \${dollar_risk:,.2f}')
print(f'Risk per unit: \${risk_per_unit:,.2f}')
print(f'Units: {units:.4f}')
print(f'Position size: \${position_value:,.2f} ({position_pct:.1f}% of capital)')
print()
print(f'Entry: \${entry:,.2f}')
print(f'Stop: \${stop:,.2f}')
print(f'Max loss: \${dollar_risk:,.2f}')
" <capital> <entry> <stop> <risk_pct>
```

## On `/risk kelly [win_rate] [avg_win] [avg_loss]`

Kelly criterion — optimal bet size given your historical edge.

```bash
python3 -c "
import sys

if len(sys.argv) < 4:
    print('Usage: /risk kelly <win_rate_%> <avg_win_R> <avg_loss_R>')
    print('Example: /risk kelly 55 1.8 1 (55% win rate, avg win 1.8R, avg loss 1R)')
    exit()

win_rate = float(sys.argv[1]) / 100
avg_win = float(sys.argv[2])
avg_loss = float(sys.argv[3])

# Full Kelly: f = (p*b - q) / b where b = win/loss ratio, p = win rate, q = 1-p
b = avg_win / avg_loss
q = 1 - win_rate
full_kelly = (win_rate * b - q) / b

# Half Kelly (recommended for volatile markets)
half_kelly = full_kelly / 2
quarter_kelly = full_kelly / 4

print(f'Win rate: {win_rate*100:.1f}%')
print(f'Avg win: {avg_win}R | Avg loss: {avg_loss}R')
print(f'Edge: {(win_rate*avg_win - q*avg_loss):.3f}R per trade')
print()
if full_kelly <= 0:
    print('No edge. Kelly = 0. Do not trade this setup.')
else:
    print(f'Full Kelly: {full_kelly*100:.1f}% of capital per trade')
    print(f'Half Kelly (recommended): {half_kelly*100:.1f}%')
    print(f'Quarter Kelly (conservative): {quarter_kelly*100:.1f}%')
    print()
    print('Note: Full Kelly maximizes growth but maximizes volatility.')
    print('Half Kelly used by most professional traders.')
" <win_rate> <avg_win> <avg_loss>
```

## On `/risk exposure`

Current portfolio exposure. What % of capital is at risk right now.

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, timezone

risk_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
if not risk_path.exists():
    print('No risk state. No open positions tracked.')
    exit()

state = json.loads(risk_path.read_text())
capital = state.get('capital', 1000)
positions = state.get('positions', [])
open_pos = [p for p in positions if p.get('status') == 'open']

total_risk = sum(p.get('dollar_risk', 0) for p in open_pos)
total_exposure = sum(p.get('position_value', 0) for p in open_pos)
exposure_pct = (total_exposure / capital * 100) if capital > 0 else 0
risk_pct = (total_risk / capital * 100) if capital > 0 else 0

print(f'Capital: \${capital:,.2f}')
print(f'Open positions: {len(open_pos)}')
print(f'Total exposure: \${total_exposure:,.2f} ({exposure_pct:.1f}%)')
print(f'Total risk: \${total_risk:,.2f} ({risk_pct:.1f}%)')
print()
if open_pos:
    print('Positions:')
    for p in open_pos:
        sym = p.get('symbol', '?')
        direction = p.get('direction', '?')
        risk = p.get('dollar_risk', 0)
        print(f'  {sym} {direction} — \${risk:.2f} risk')
"
```

## On `/risk drawdown`

Current and max drawdown from peak capital.

```bash
python3 -c "
import json, pathlib, os

risk_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
if not risk_path.exists():
    print('No risk state tracked yet.')
    exit()

state = json.loads(risk_path.read_text())
capital = state.get('capital', 1000)
peak = state.get('peak_capital', capital)
closed_pnl = state.get('closed_pnl', 0)
current_equity = capital + closed_pnl

drawdown = peak - current_equity
dd_pct = (drawdown / peak * 100) if peak > 0 else 0
max_dd = state.get('max_drawdown', drawdown)
max_dd_pct = (max_dd / peak * 100) if peak > 0 else 0

print(f'Peak capital: \${peak:,.2f}')
print(f'Current equity: \${current_equity:,.2f}')
print(f'Current drawdown: \${drawdown:,.2f} ({dd_pct:.1f}%)')
print(f'Max drawdown (all time): \${max_dd:,.2f} ({max_dd_pct:.1f}%)')
print()
if dd_pct > 10:
    print('⚠️ Drawdown > 10%. Consider reducing position size.')
if dd_pct > 20:
    print('🛑 Drawdown > 20%. Stop trading. Review system.')
"
```

## On `/risk weekly`

Weekly edge audit. Win rate, realized R:R, what worked, what didn't.

```bash
python3 -c "
import json, pathlib, os
from datetime import datetime, timedelta, timezone

risk_path = pathlib.Path(os.path.expanduser('~/.openclaw/trader/risk-state.json'))
if not risk_path.exists():
    print('No trade history. Start trading (paper) to generate data.')
    exit()

state = json.loads(risk_path.read_text())
week_ago = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

closed = [p for p in state.get('positions', [])
          if p.get('status') in ['win', 'loss', 'breakeven']
          and p.get('closed_at', '') >= week_ago]

if not closed:
    print('No closed trades this week.')
    exit()

wins = [p for p in closed if p.get('status') == 'win']
losses = [p for p in closed if p.get('status') == 'loss']
total = len(closed)
win_rate = (len(wins) / total * 100) if total > 0 else 0

avg_win_r = sum(p.get('realized_r', 0) for p in wins) / len(wins) if wins else 0
avg_loss_r = sum(abs(p.get('realized_r', 0)) for p in losses) / len(losses) if losses else 0
total_r = sum(p.get('realized_r', 0) for p in closed)

print(f'Week summary ({total} trades):')
print(f'  Win rate: {win_rate:.0f}% ({len(wins)}W / {len(losses)}L)')
print(f'  Avg win: {avg_win_r:.2f}R | Avg loss: {avg_loss_r:.2f}R')
print(f'  Total: {total_r:+.2f}R')
print()
if total_r > 0:
    print(f'Profitable week. Edge is working.')
else:
    print(f'Losing week. Review signal quality before next week.')
"
```

## Rules

- Wrap all `float(sys.argv[N])` in try/except ValueError — print the usage string on failure, never expose a Python traceback.
- Default risk per trade: 1% of capital. Never suggest >2% without explicit user request.
- Max portfolio exposure: 6% total risk at any one time (3 trades at 2% each, max).
- Drawdown circuit breaker: >20% drawdown = stop trading until reviewed.
- Kelly criterion: always show Half Kelly as the recommended value. Full Kelly is dangerous.
- Paper mode enforced by default. All P&L is paper until `live_mode: true` set in risk-state.json.
- Risk is the only moat. Protect capital first. Edge is secondary.
