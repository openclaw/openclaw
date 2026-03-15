---
name: trader-backtest
description: Backtesting engine — validate strategies with historical data before risking capital.
user-invocable: true
disable-model-invocation: false
triggers:
  - /backtest
  - /test
---

# trader-backtest

Backtesting engine for strategy validation. Every strategy is a hypothesis. Backtest is the experiment. No backtest, no trade.

## On `/backtest [strategy] [symbol] [period]`

Run historical backtest on a defined strategy.

```bash
python3 -c "
import json, sys, os, pathlib
from datetime import datetime

args = sys.argv[1:]
if len(args) < 2:
    print('Usage: /backtest <strategy> <symbol> [period]')
    print('Example: /backtest ema-cross BTC 90d')
    exit()

strategy = args[0]
symbol = args[1].upper()
period = args[2] if len(args) > 2 else '90d'

# Validate strategy exists
strat_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/strategies'))
strat_file = strat_dir / f'{strategy}.json'

if not strat_file.exists():
    available = [f.stem for f in strat_dir.glob('*.json')] if strat_dir.exists() else []
    print(json.dumps({'error': 'strategy_not_found', 'strategy': strategy, 'available': available}))
    exit()

strat_config = json.loads(strat_file.read_text())

# Fetch historical price data
import urllib.request
coin_map = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana'}
coin_id = coin_map.get(symbol, symbol.lower())

days = int(period.replace('d', '').replace('w', '')) * (7 if 'w' in period else 1)
url = f'https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days={days}'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=15).read())

prices = [p[1] for p in data.get('prices', [])]
print(json.dumps({
    'strategy': strategy,
    'symbol': symbol,
    'period': period,
    'data_points': len(prices),
    'price_range': [min(prices), max(prices)] if prices else [],
    'config': strat_config
}))
" <strategy> <symbol> <period>
```

After fetching data, compute backtest metrics using the strategy rules from the JSON config. Apply ta-lib indicators as needed.

Output format:

```
📊 BACKTEST: ema-cross on BTC (90d)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Total trades:    23
Win rate:        61% (14W / 9L)
Expectancy:      +$142/trade
Max drawdown:    -8.3%
Sharpe ratio:    1.42
Profit factor:   2.1
Best trade:      +$890 (Mar 2)
Worst trade:     -$420 (Feb 18)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Verdict: EDGE EXISTS — positive expectancy over 23 trades
```

Save results:

```bash
python3 -c "
import json, os, pathlib, tempfile
from datetime import datetime

result = json.loads(sys.argv[1])
out_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/backtests'))
out_dir.mkdir(parents=True, exist_ok=True)

filename = f'{result[\"strategy\"]}-{datetime.utcnow().strftime(\"%Y%m%d\")}.json'
out_path = out_dir / filename

# Atomic write
tmp = out_path.with_suffix('.tmp')
tmp.write_text(json.dumps(result, indent=2))
tmp.replace(out_path)
print(f'Saved: {filename}')
" '<result_json>'
```

## On `/backtest compare [strat1] [strat2]`

Compare two strategies on the same data.

```bash
python3 -c "
import json, sys, os, pathlib

args = sys.argv[1:]
if len(args) < 2:
    print('Usage: /backtest compare <strategy1> <strategy2>')
    exit()

bt_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/backtests'))
results = {}
for strat in args[:2]:
    files = sorted(bt_dir.glob(f'{strat}-*.json'), reverse=True)
    if files:
        results[strat] = json.loads(files[0].read_text())
    else:
        results[strat] = None

print(json.dumps(results))
" <strat1> <strat2>
```

Output format — side-by-side comparison:

```
📊 COMPARE: ema-cross vs tbo-breakout
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Metric          ema-cross    tbo-breakout
Win rate        61%          54%
Expectancy      +$142        +$210
Max drawdown    -8.3%        -12.1%
Sharpe          1.42         1.18
Profit factor   2.1          1.8
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Winner: ema-cross (higher Sharpe, lower drawdown)
But: tbo-breakout has better expectancy per trade — depends on your risk tolerance.
```

## On `/backtest optimize [strategy]`

Suggest parameter tweaks based on sensitivity analysis.

```bash
python3 -c "
import json, sys, os, pathlib

strategy = sys.argv[1] if len(sys.argv) > 1 else ''
if not strategy:
    print('Usage: /backtest optimize <strategy>')
    exit()

strat_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/strategies'))
strat_file = strat_dir / f'{strategy}.json'

if not strat_file.exists():
    print(f'Strategy \"{strategy}\" not found.')
    exit()

config = json.loads(strat_file.read_text())
print(json.dumps({'strategy': strategy, 'current_params': config, 'action': 'optimize'}))
" <strategy>
```

Run the strategy with parameter variations (e.g., EMA 18/20/22 instead of fixed 20). Report which parameter set produces best Sharpe ratio without overfitting.

Output:

```
🔧 OPTIMIZE: ema-cross
Current: EMA 20/50, RSI 14
━━━━━━━━━━━━━━━━━━━━━━━━
Tested 27 parameter combinations
Best Sharpe: EMA 21/55, RSI 12 → Sharpe 1.58 (+11%)
⚠️ Warning: Only marginal improvement. Original params are robust.
Overfitting risk: LOW (improvement consistent across 3 sub-periods)
```

## On `/backtest report`

Full report on all strategies with rolling 30-trade performance.

```bash
python3 -c "
import json, os, pathlib

bt_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/backtests'))
if not bt_dir.exists():
    print('No backtests found. Run /backtest <strategy> <symbol> first.')
    exit()

reports = {}
for f in bt_dir.glob('*.json'):
    if f.suffix == '.json' and not f.name.endswith('.tmp'):
        data = json.loads(f.read_text())
        strat = data.get('strategy', f.stem)
        if strat not in reports:
            reports[strat] = []
        reports[strat].append({'file': f.name, 'data': data})

print(json.dumps(reports, default=str))
"
```

Output — summary table of all strategies:

```
📊 STRATEGY REPORT (rolling 30-trade)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Strategy       WR%    Exp     DD      PF     Status
ema-cross      61%    +$142   -8.3%   2.1    🟢 ACTIVE
tbo-breakout   54%    +$210   -12.1%  1.8    🟢 ACTIVE
rsi-div        48%    +$85    -15.2%  1.3    🟡 REVIEW
mean-revert    39%    -$42    -22.1%  0.8    🔴 STOPPED
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🟢 = positive expectancy, 🟡 = declining, 🔴 = negative expectancy
```

## Strategy File Format

Strategy definitions live in `~/.openclaw/trader/strategies/*.json`:

```json
{
  "name": "ema-cross",
  "description": "EMA 20/50 crossover with RSI filter",
  "entry": {
    "type": "ema_cross",
    "fast": 20,
    "slow": 50,
    "rsi_filter": true,
    "rsi_period": 14,
    "rsi_threshold": 50
  },
  "exit": {
    "stop_atr_multiplier": 1.5,
    "target_rr": 2.0,
    "trail_after_rr": 1.0
  },
  "risk": {
    "max_risk_pct": 2.0,
    "max_positions": 3
  }
}
```

## Rules

- All backtest results saved to `~/.openclaw/trader/backtests/{strategy}-{date}.json`.
- Atomic writes: temp file + replace. Always.
- Minimum 30 trades for statistical significance. Fewer than 30 = warn: `⚠️ Only N trades — not enough data for confidence.`
- Never claim a strategy "works" without positive expectancy AND Sharpe > 1.0.
- Overfitting warning: if optimized params improve Sharpe > 30% over default, flag it.
- Uses pandas, numpy, ta-lib for indicator computation.
- Price data from CoinGecko (free tier, no auth). Higher resolution from TradingView webhooks via n8n.
- Backtest ≠ live performance. Always note: `Past results are not predictive. Paper trade first.`
- Edge or no edge. That's the only question.
