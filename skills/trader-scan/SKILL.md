---
name: trader-scan
description: Multi-market scanner — crypto, Polymarket, mentions, sports. Finds setups with edge.
user-invocable: true
disable-model-invocation: false
triggers:
  - /scan
  - /markets
---

# trader-scan

Multi-market scanner for trading setups. Scans crypto charts, Polymarket odds, mention markets, and sports lines for edge. Numbers first, always.

## On `/scan crypto [timeframe]`

Scan BTC, ETH, SOL, and top 10 alts by volume for active setups. Default timeframe: 4h.

```bash
python3 -c "
import json, sys, os, pathlib
from datetime import datetime

tf = sys.argv[1] if len(sys.argv) > 1 else '4h'
valid_tf = ['1m', '5m', '15m', '1h', '4h', '1d', '1w']
if tf not in valid_tf:
    print(f'Bad timeframe. Use: {', '.join(valid_tf)}')
    exit()

# Fetch price data from CoinGecko
import urllib.request
coins = ['bitcoin', 'ethereum', 'solana']
url = f'https://api.coingecko.com/api/v3/simple/price?ids={\",\".join(coins)}&vs_currencies=usd&include_24hr_change=true'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())
print(json.dumps({'timeframe': tf, 'prices': data, 'ts': datetime.utcnow().isoformat()}))
" <timeframe>
```

Scan for these setup types:
- **TBO cloud breakout**: Price closes above/below TBO cloud on given timeframe
- **TBT divergence**: Price makes new high/low but TBT oscillator doesn't confirm
- **S/R flip**: Former resistance broken and retested as support (or vice versa)
- **EMA stack**: 20 > 50 > 100 > 200 aligned (bullish) or inverted (bearish)

Format each hit as:

```
🎯 SETUP: BTC/USD
Timeframe: 4h
Direction: LONG
Entry: $67,420
Stop: $65,800 (1.5× ATR)
Target: $71,200
R:R: 1:2.3
Confidence: HIGH
Signal: Break-and-retest of $67K resistance → support
```

No hits = `No setups on {timeframe}. Markets are choppy — patience is edge.`

## On `/scan polymarket`

Scan Polymarket for edge opportunities:

```bash
python3 -c "
import json, urllib.request

url = 'https://clob.polymarket.com/markets'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=15).read())
print(json.dumps({'market_count': len(data) if isinstance(data, list) else 'unknown', 'ts': __import__('datetime').datetime.utcnow().isoformat()}))
"
```

Scan categories:
- **Arbitrage**: Both YES + NO prices sum to < $1.00 (risk-free edge)
- **High-edge**: Markets where odds diverge from base rate by >15%
- **Low-volume**: Markets with < $5K volume where informed money hasn't arrived
- **Closing soon**: Markets resolving within 48h with volatile odds

Format each opportunity:

```
📉 POLY: Will X happen?
YES: $0.42 / NO: $0.55
Gap: $0.03 (arb opportunity)
Volume: $3,200 (low — edge possible)
Closes: 2026-03-16 18:00 UTC
Edge type: ARBITRAGE
```

## On `/scan mention [person]`

Scan upcoming events (speeches, interviews, debates, press conferences) for a specific person. Identify Polymarket mention markets and calculate word/phrase probability.

```bash
python3 -c "
import json, sys, os, pathlib

person = ' '.join(sys.argv[1:]) if len(sys.argv) > 1 else ''
if not person:
    print('Usage: /scan mention <person name>')
    exit()

profile_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/profiles'))
profile_path = profile_dir / f'{person.lower().replace(\" \", \"-\")}.json'

if profile_path.exists():
    profile = json.loads(profile_path.read_text())
    print(json.dumps({'person': person, 'profile_exists': True, 'speeches_analyzed': profile.get('speeches_analyzed', 0)}))
else:
    print(json.dumps({'person': person, 'profile_exists': False, 'note': 'No profile yet. Use /poly mention to build one.'}))
" <person>
```

Output: List of upcoming events + any active Polymarket mention markets for that person, cross-referenced with speech pattern profile if one exists.

## On `/scan sports`

Scan obscure and low-volume sports markets for edge.

Target: non-mainstream leagues, niche props, markets with < $2K volume where bookmaker/market odds haven't converged.

```bash
python3 -c "
import json, urllib.request
from datetime import datetime

# Query Polymarket for sports-tagged markets
url = 'https://clob.polymarket.com/markets'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=15).read())

sports = []
if isinstance(data, list):
    for m in data:
        tags = m.get('tags', [])
        if any(t.lower() in ['sports', 'nfl', 'nba', 'mma', 'soccer', 'tennis', 'esports'] for t in tags):
            sports.append({'question': m.get('question', ''), 'volume': m.get('volume', 0)})

# Sort by volume ascending (low volume = potential edge)
sports.sort(key=lambda x: x.get('volume', 0))
print(json.dumps({'sports_markets': sports[:20], 'total': len(sports), 'ts': datetime.utcnow().isoformat()}))
"
```

Format:

```
🔥 SPORTS EDGE: [Market question]
Volume: $1,200 (thin — edge available)
Current odds: YES $0.35 / NO $0.65
Edge thesis: [why this is mispriced]
```

## Rules

- Every output includes R:R ratio or edge quantification. No vague calls.
- Confidence levels: HIGH (3+ confluent signals), MED (2 signals), LOW (1 signal + thesis).
- Paper first. Never suggest live trades without explicit user confirmation.
- No scan result = say so. `No edge found. That IS the information.`
- All timestamps in UTC.
- Rate limit API calls: max 1 scan per 60 seconds per source.
- Never expose API keys or wallet addresses in replies.
- CoinGecko: free tier, no auth needed. Polymarket: public CLOB API.
- n8n webhook URL for TradingView alerts stored in `~/.openclaw/trader/config.json`.
- Edge or no edge. That's the only question.
