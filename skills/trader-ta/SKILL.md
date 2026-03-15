---
name: trader-ta
description: Technical analysis engine — trend, S/R, ATR, RSI, EMA, setups, and risk calculation.
user-invocable: true
disable-model-invocation: false
triggers:
  - /ta
  - /chart
  - /analysis
---

# trader-ta

Technical analysis engine. Price tells you everything if you know how to read it. Numbers first, opinions last. Every indicator confirms or denies — none stands alone.

## TA Knowledge Base

These rules are absolute. Every analysis follows them.

### TREND
- **Uptrend**: Higher highs + higher lows. Period.
- **Downtrend**: Lower lows + lower highs. Period.
- **Consolidation**: Neither pattern — range-bound.
- **Pullback low is the line in the sand.** If the most recent pullback low breaks, the trend is over. Until then, buy the dip.
- A single lower low does not kill an uptrend if the structure of higher lows is intact on the higher timeframe.

### SUPPORT / RESISTANCE
- **Resistance broken becomes support** (break-and-retest). This is the highest-probability entry.
- **Look left for levels.** S/R comes from price history, not from indicators.
- The more times a level is tested, the weaker it gets (each test absorbs liquidity).
- Round numbers act as psychological S/R ($50K, $100K, $1.00).

### ATR (Average True Range)
- 14-period ATR. This is the market's volatility fingerprint.
- **ALL stops must align to ATR.** A 10-pip stop on a 190-pip daily ATR instrument = guaranteed stop-out.
- Standard stop distance: **1.5x ATR** below entry (longs) or above entry (shorts).
- If ATR is expanding, the market is moving — wider stops, bigger targets.
- If ATR is contracting, the market is coiling — breakout incoming.

### RSI (Relative Strength Index)
- 14-period. Above 70 = overbought. Below 30 = oversold.
- **RSI divergence = reversal signal.** Price makes new high, RSI doesn't = bearish divergence.
- RSI is NOT a standalone signal. It confirms, it doesn't initiate.
- Hidden divergence (trend continuation) > regular divergence (reversal).

### EMA (Exponential Moving Average)
- Stack: 20 / 50 / 100 / 200.
- **Golden cross**: 50 EMA crosses above 200 EMA = bullish.
- **Death cross**: 50 EMA crosses below 200 EMA = bearish.
- Price above all EMAs = strong uptrend. Price below all = strong downtrend.
- 200 EMA is the line between bull and bear territory on any timeframe.

### RISK MANAGEMENT
- **Max 1-2% of account per trade.** Non-negotiable.
- **R:R minimum 1:2**, prefer 1:3+.
- Roll stop to breakeven after price moves 1:1 in your favor.
- Never add to a losing position.
- Correlation: if you're long BTC and ETH, that's not 2 trades — it's 1 trade with 2x size.

## On `/ta [symbol] [timeframe]`

Full TA report. Default timeframe: 4h.

```bash
python3 -c "
import json, sys, urllib.request

args = sys.argv[1:]
if not args:
    print('Usage: /ta <symbol> [timeframe]')
    print('Example: /ta BTC 4h')
    exit()

symbol = args[0].upper()
tf = args[1] if len(args) > 1 else '4h'
valid_tf = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']
if tf not in valid_tf:
    print(f'Timeframes: {\", \".join(valid_tf)}')
    exit()

# Fetch price data
coin_map = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana', 'AVAX': 'avalanche-2', 'DOGE': 'dogecoin', 'ADA': 'cardano', 'DOT': 'polkadot', 'LINK': 'chainlink', 'MATIC': 'polygon', 'UNI': 'uniswap'}
coin_id = coin_map.get(symbol, symbol.lower())

tf_days = {'1m': 1, '5m': 1, '15m': 2, '1h': 7, '4h': 30, '1d': 90, '1w': 365}
days = tf_days.get(tf, 30)

url = f'https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days={days}'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=15).read())

prices = [p[1] for p in data.get('prices', [])]
if not prices:
    print(f'No data for {symbol}')
    exit()

print(json.dumps({
    'symbol': symbol,
    'timeframe': tf,
    'current': prices[-1],
    'high': max(prices),
    'low': min(prices),
    'data_points': len(prices)
}))
" <symbol> <timeframe>
```

Compute indicators from price data using ta-lib:
- Trend structure (HH/HL or LL/LH)
- Key S/R levels (from swing points)
- ATR 14-period
- RSI 14-period
- EMA 20/50/100/200 positions relative to price
- Any active signals (divergence, cross, break-and-retest)

Output:

```
📊 TA: BTC/USD (4h)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Price: $67,420
Trend: UPTREND (HH/HL intact since $58K)
Line in sand: $64,200 (last pullback low)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
S/R:
  R1: $69,500 (tested 3×, weakening)
  R2: $72,000 (untested, strong)
  S1: $66,800 (break-retest confirmed ✅)
  S2: $64,200 (trend invalidation)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
ATR(14): $1,890 (expanding — momentum)
RSI(14): 62 (neutral, room to run)
EMA: Price > 20 > 50 > 100 > 200 (full stack bullish 🔥)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Signals: Break-and-retest of $66.8K confirmed
Bias: LONG above $64,200
```

## On `/ta trend [symbol]`

Trend identification only.

```bash
python3 -c "
import json, sys, urllib.request

symbol = sys.argv[1].upper() if len(sys.argv) > 1 else ''
if not symbol:
    print('Usage: /ta trend <symbol>')
    exit()

coin_map = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana'}
coin_id = coin_map.get(symbol, symbol.lower())

url = f'https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days=30'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())

prices = [p[1] for p in data.get('prices', [])]
print(json.dumps({'symbol': symbol, 'prices_count': len(prices), 'current': prices[-1] if prices else 0, 'period_high': max(prices) if prices else 0, 'period_low': min(prices) if prices else 0}))
" <symbol>
```

Apply trend rules from the knowledge base. Check multiple timeframes (4h + daily).

Output:

```
📈 TREND: BTC
4h: UPTREND — HH/HL since $58K, pullback low at $64,200
1d: UPTREND — HH/HL since $42K, pullback low at $58,000
Confluence: BULLISH (both timeframes aligned)
Line in sand (4h): $64,200
Line in sand (1d): $58,000
```

## On `/ta sr [symbol]`

Support and resistance levels with break-and-retest status.

```bash
python3 -c "
import json, sys, urllib.request

symbol = sys.argv[1].upper() if len(sys.argv) > 1 else ''
if not symbol:
    print('Usage: /ta sr <symbol>')
    exit()

coin_map = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana'}
coin_id = coin_map.get(symbol, symbol.lower())

url = f'https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days=90'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())

prices = [p[1] for p in data.get('prices', [])]
print(json.dumps({'symbol': symbol, 'data_points': len(prices), 'current': prices[-1] if prices else 0}))
" <symbol>
```

Identify swing highs/lows from price data. Check each level for:
- Number of tests (more tests = weaker level)
- Break-and-retest confirmation
- Proximity to current price

Output:

```
📊 S/R LEVELS: BTC
━━━━━━━━━━━━━━━━━━━━━
Current: $67,420

RESISTANCE:
  $69,500 — tested 3× (weakening) — 3.1% above
  $72,000 — untested (strong) — 6.8% above
  $75,000 — psychological (round number) — 11.2% above

SUPPORT:
  $66,800 — break-retest confirmed ✅ — 0.9% below
  $64,200 — pullback low (trend line) — 4.8% below
  $60,000 — psychological + 200 EMA zone — 11.0% below
━━━━━━━━━━━━━━━━━━━━━
Best entry zone: $66,800 retest (confirmed support)
```

## On `/ta atr [symbol] [timeframe]`

ATR value + recommended stop distance.

```bash
python3 -c "
import json, sys, urllib.request

args = sys.argv[1:]
if not args:
    print('Usage: /ta atr <symbol> [timeframe]')
    exit()

symbol = args[0].upper()
tf = args[1] if len(args) > 1 else '1d'

coin_map = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana'}
coin_id = coin_map.get(symbol, symbol.lower())

tf_days = {'1h': 7, '4h': 30, '1d': 90, '1w': 365}
days = tf_days.get(tf, 90)

url = f'https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days={days}'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())

prices = [p[1] for p in data.get('prices', [])]
print(json.dumps({'symbol': symbol, 'timeframe': tf, 'current': prices[-1] if prices else 0, 'data_points': len(prices)}))
" <symbol> <timeframe>
```

Calculate ATR(14) from price data. Report:

```
📏 ATR: BTC (daily)
━━━━━━━━━━━━━━━━━━
ATR(14): $1,890
Current price: $67,420

Stop distance:
  1.0× ATR: $1,890 (tight — higher stop-out risk)
  1.5× ATR: $2,835 (standard ✅)
  2.0× ATR: $3,780 (wide — for swing trades)

Long stop: $67,420 - $2,835 = $64,585
Short stop: $67,420 + $2,835 = $70,255

ATR trend: EXPANDING (momentum increasing)
```

## On `/ta setup [symbol]`

Check for active entry setups.

```bash
python3 -c "
import json, sys, urllib.request

symbol = sys.argv[1].upper() if len(sys.argv) > 1 else ''
if not symbol:
    print('Usage: /ta setup <symbol>')
    exit()

coin_map = {'BTC': 'bitcoin', 'ETH': 'ethereum', 'SOL': 'solana'}
coin_id = coin_map.get(symbol, symbol.lower())

url = f'https://api.coingecko.com/api/v3/coins/{coin_id}/market_chart?vs_currency=usd&days=30'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())

prices = [p[1] for p in data.get('prices', [])]
print(json.dumps({'symbol': symbol, 'current': prices[-1] if prices else 0, 'data_points': len(prices)}))
" <symbol>
```

Scan for these setups:
- **Break-and-retest**: resistance broken, price pulled back to test it as support, held
- **RSI divergence**: price new high/low, RSI disagrees
- **Pullback to MA**: price pulled back to 20 or 50 EMA in an uptrend, holding
- **EMA cross**: 20/50 cross with price confirmation
- **ATR squeeze**: ATR at 30-day low (coiling for breakout)

Output:

```
🎯 SETUPS: BTC
━━━━━━━━━━━━━━━━━━━━━

1. BREAK-AND-RETEST ✅ (active)
   Level: $66,800 (former resistance → support)
   Entry: $66,800-$67,000
   Stop: $64,585 (1.5× ATR below)
   Target: $72,000 (next resistance)
   R:R: 1:2.3
   Confidence: HIGH (3 confluences)

2. PULLBACK TO 20 EMA ✅ (forming)
   20 EMA: $66,200
   Price proximity: 1.8% above
   Wait for: touch + bounce candle
   Confidence: MED

No other active setups.
```

No setups = `No active setups on BTC. Patience. The market doesn't owe you a trade.`

## On `/ta risk [entry] [stop] [target] [account-size]`

Position size and risk calculator.

```bash
python3 -c "
import json, sys

args = sys.argv[1:]
if len(args) < 4:
    print('Usage: /ta risk <entry> <stop> <target> <account-size>')
    print('Example: /ta risk 67000 64500 72000 10000')
    exit()

entry = float(args[0])
stop = float(args[1])
target = float(args[2])
account = float(args[3])

risk_per_unit = abs(entry - stop)
reward_per_unit = abs(target - entry)
rr_ratio = reward_per_unit / risk_per_unit if risk_per_unit > 0 else 0

# Max 2% risk
max_risk_dollars = account * 0.02
position_size = max_risk_dollars / risk_per_unit if risk_per_unit > 0 else 0
position_value = position_size * entry

# 1% risk option
conservative_risk = account * 0.01
conservative_size = conservative_risk / risk_per_unit if risk_per_unit > 0 else 0

direction = 'LONG' if target > entry else 'SHORT'

result = {
    'direction': direction,
    'entry': entry,
    'stop': stop,
    'target': target,
    'account': account,
    'risk_per_unit': round(risk_per_unit, 2),
    'reward_per_unit': round(reward_per_unit, 2),
    'rr_ratio': round(rr_ratio, 2),
    'max_risk_2pct': round(max_risk_dollars, 2),
    'position_size_2pct': round(position_size, 6),
    'position_value_2pct': round(position_value, 2),
    'conservative_1pct': round(conservative_size, 6),
    'rr_acceptable': rr_ratio >= 2.0
}
print(json.dumps(result))
" <entry> <stop> <target> <account-size>
```

Output:

```
📐 RISK CALC
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Direction: LONG
Entry:   $67,000
Stop:    $64,500 (-$2,500 risk/unit)
Target:  $72,000 (+$5,000 reward/unit)
R:R:     1:2.0 ✅

Account: $10,000
━━━━━━━━━━━━━━━━━━━━━━━━━━━
2% risk ($200):
  Position: 0.08 BTC ($5,360)
  Max loss: $200
  Max profit: $400

1% risk ($100):
  Position: 0.04 BTC ($2,680)
  Max loss: $100
  Max profit: $200
━━━━━━━━━━━━━━━━━━━━━━━━━━━
Move stop to breakeven after +$2,500 (1:1 move)
```

If R:R < 2.0: `⚠️ R:R is 1:{ratio} — below 1:2 minimum. Adjust entry or target. Bad R:R = no edge.`

## Rules

- Every indicator is a tool, not a signal. No single indicator triggers a trade.
- Minimum 2 confluent signals for any trade suggestion. 3 for HIGH confidence.
- ATR governs stop distance. No exceptions. No "tight stops" on volatile instruments.
- Position sizing: max 2% risk per trade. Calculator enforces this.
- Trend > everything. Don't short an uptrend, don't long a downtrend. Unless you have 3+ reversal signals.
- Always state the invalidation level. Every thesis has a kill switch.
- Price data from CoinGecko (free tier) or TradingView webhooks via n8n.
- Uses ta-lib for indicator computation: ATR, RSI, EMA, Bollinger Bands.
- Timeframe hierarchy: weekly > daily > 4h > 1h. Higher timeframe wins conflicts.
- No prediction, only probability. "BTC looks bullish" = wrong. "BTC has 3 bullish confluences above $64.2K" = right.
- Edge or no edge. That's the only question.
