---
name: trader-polymarket
description: Polymarket integration — prediction market trading, arbitrage detection, mention analysis, counter-AI fading.
user-invocable: true
disable-model-invocation: false
triggers:
  - /poly
  - /polymarket
  - /pm-trade
---

# trader-polymarket

Polymarket prediction market engine. Odds are probabilities. Probabilities are tradeable. Find where the market is wrong, that's the edge.

## On `/poly markets [category]`

List active markets filtered by category.

```bash
python3 -c "
import json, sys, urllib.request

category = sys.argv[1].lower() if len(sys.argv) > 1 else 'all'
valid = ['all', 'crypto', 'politics', 'sports', 'mentions', 'entertainment', 'science']
if category not in valid:
    print(f'Categories: {\", \".join(valid)}')
    exit()

url = 'https://clob.polymarket.com/markets'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=15).read())

markets = data if isinstance(data, list) else []
if category != 'all':
    markets = [m for m in markets if category in [t.lower() for t in m.get('tags', [])]]

# Sort by volume descending
markets.sort(key=lambda x: x.get('volume', 0), reverse=True)
for m in markets[:15]:
    print(json.dumps({
        'question': m.get('question', ''),
        'id': m.get('condition_id', ''),
        'volume': m.get('volume', 0),
        'end_date': m.get('end_date_iso', '')
    }))
" <category>
```

Output format:

```
📊 POLYMARKET: crypto (15 markets)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Will BTC hit $100K by June? — Vol: $2.4M — YES: $0.62
2. ETH ETF approval by Q3? — Vol: $890K — YES: $0.38
...
```

## On `/poly odds [market-id]`

Current odds + price history for a specific market.

```bash
python3 -c "
import json, sys, urllib.request

market_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not market_id:
    print('Usage: /poly odds <market-id>')
    exit()

url = f'https://clob.polymarket.com/markets/{market_id}'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())
print(json.dumps(data, default=str))
" <market-id>
```

Output:

```
📊 ODDS: Will X happen?
━━━━━━━━━━━━━━━━━━━━━━
YES: $0.62 (+0.04 24h)
NO:  $0.38 (-0.04 24h)
Volume: $2.4M
24h change: YES ↑ 6.9%
7d trend: steady climb from $0.48
Closes: 2026-06-30
```

## On `/poly arbitrage`

Find markets where YES + NO < $1.00 — risk-free edge.

```bash
python3 -c "
import json, urllib.request
from datetime import datetime

url = 'https://clob.polymarket.com/markets'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=15).read())

arbs = []
if isinstance(data, list):
    for m in data:
        tokens = m.get('tokens', [])
        if len(tokens) >= 2:
            yes_price = float(tokens[0].get('price', 1))
            no_price = float(tokens[1].get('price', 1))
            total = yes_price + no_price
            if total < 0.98:  # At least 2% gap
                arbs.append({
                    'question': m.get('question', ''),
                    'yes': yes_price,
                    'no': no_price,
                    'gap': round(1.0 - total, 4),
                    'volume': m.get('volume', 0)
                })

arbs.sort(key=lambda x: x['gap'], reverse=True)
print(json.dumps({'arbitrage_opportunities': arbs[:10], 'total_found': len(arbs), 'ts': datetime.utcnow().isoformat()}))
"
```

Output:

```
🎯 ARBITRAGE FOUND: 3 markets
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
1. Will X happen?
   YES: $0.42 + NO: $0.55 = $0.97
   Gap: $0.03 (3% risk-free)
   Volume: $12K
   ⚠️ Check liquidity before entry

2. ...
```

If none found: `No arb opportunities right now. Market is efficient — check back in a few hours.`

## On `/poly late [market-id]`

Late entry analysis — momentum in the last 3-4 minutes before resolution. For markets resolving soon.

```bash
python3 -c "
import json, sys, urllib.request

market_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not market_id:
    print('Usage: /poly late <market-id>')
    exit()

url = f'https://clob.polymarket.com/markets/{market_id}'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())

print(json.dumps({
    'market': data.get('question', ''),
    'end_date': data.get('end_date_iso', ''),
    'current_odds': data.get('tokens', []),
    'analysis': 'late_entry'
}))
" <market-id>
```

Analyze:
- Last 30 min price trajectory — which side is accumulating?
- Volume spike in final hour vs daily average
- Smart money pattern: large orders appearing late
- Resolution time proximity — is the outcome already known by insiders?

Output:

```
⏱️ LATE ENTRY: Will X happen?
Resolves: 18 minutes
━━━━━━━━━━━━━━━━━━━━━━
YES momentum: +$0.08 in last 30min (strong)
Volume spike: 3.2× daily avg
Large orders: 4 buys > $500 on YES side
Signal: INSIDERS ACCUMULATING YES
Risk: HIGH (late entry, thin time)
```

## On `/poly counter-ai [market-id]`

Detect if AI bots are clustered on one side. Calculate fade probability.

```bash
python3 -c "
import json, sys, urllib.request

market_id = sys.argv[1] if len(sys.argv) > 1 else ''
if not market_id:
    print('Usage: /poly counter-ai <market-id>')
    exit()

url = f'https://clob.polymarket.com/markets/{market_id}'
req = urllib.request.Request(url, headers={'User-Agent': 'moonman/1.0'})
data = json.loads(urllib.request.urlopen(req, timeout=10).read())

print(json.dumps({
    'market': data.get('question', ''),
    'tokens': data.get('tokens', []),
    'volume': data.get('volume', 0),
    'analysis': 'counter_ai'
}))
" <market-id>
```

AI bot detection signals:
- Uniform order sizes (bots tend to use round numbers or fixed sizing)
- Rapid-fire orders at regular intervals
- One-sided accumulation without price-responsive adjustments
- Orders placed exactly at market open / on scheduled events

Output:

```
🤖 COUNTER-AI: Will X happen?
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Bot confidence: 78% clustered on YES
Signals: uniform $50 orders, 12-second intervals, no pullback buying
Fade probability: 62% (bots wrong when >70% clustered)
Thesis: If bots are wrong, NO at $0.35 is a 1:1.85 payout
⚠️ Counter-AI is contrarian — size small, this is a thesis trade
```

## On `/poly mention [person] [context]`

Build or update speech pattern profile for mention market trading.

```bash
python3 -c "
import json, sys, os, pathlib, tempfile

args = sys.argv[1:]
if not args:
    print('Usage: /poly mention <person> [context]')
    exit()

person = args[0]
context = ' '.join(args[1:]) if len(args) > 1 else ''

profile_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/profiles'))
profile_dir.mkdir(parents=True, exist_ok=True)
profile_path = profile_dir / f'{person.lower().replace(\" \", \"-\")}.json'

if profile_path.exists():
    profile = json.loads(profile_path.read_text())
else:
    profile = {
        'person': person,
        'speeches_analyzed': 0,
        'word_frequencies': {},
        'favorite_phrases': [],
        'context_patterns': [],
        'created': __import__('datetime').datetime.utcnow().isoformat()
    }

if context:
    profile['context_patterns'].append({
        'context': context,
        'added': __import__('datetime').datetime.utcnow().isoformat()
    })

# Atomic write
tmp = profile_path.with_suffix('.tmp')
tmp.write_text(json.dumps(profile, indent=2))
tmp.replace(profile_path)

print(json.dumps({'person': person, 'speeches_analyzed': profile['speeches_analyzed'], 'patterns': len(profile['context_patterns'])}))
" <person> <context>
```

Profile building process:
1. Analyze transcripts/clips of past speeches for word frequency
2. Identify pet phrases, verbal tics, topic fixations
3. Cross-reference with upcoming event context (topic, audience, format)
4. Calculate probability of specific words/phrases being said

Output:

```
🎤 MENTION PROFILE: Trump
━━━━━━━━━━━━━━━━━━━━━━━
Speeches analyzed: 14
Top words: "tremendous" (89%), "beautiful" (76%), "China" (71%)
Context: rally → "fake news" probability 94%
Context: press conference → "China" probability 82%
Active Polymarket mention markets: 3
Highest edge: "Will Trump say 'Bitcoin'?" — YES at $0.28, model says 45%
```

## On `/poly paper [market-id] [side] [amount]`

Place a paper trade on a market. No real money.

```bash
python3 -c "
import json, sys, os, pathlib, tempfile
from datetime import datetime

args = sys.argv[1:]
if len(args) < 3:
    print('Usage: /poly paper <market-id> <yes|no> <amount>')
    exit()

market_id = args[0]
side = args[1].upper()
amount = float(args[2])

if side not in ('YES', 'NO'):
    print('Side must be YES or NO')
    exit()

if amount <= 0 or amount > 10000:
    print('Amount must be $0.01-$10,000')
    exit()

trades_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/paper-trades'))
trades_dir.mkdir(parents=True, exist_ok=True)
trades_file = trades_dir / 'trades.json'

trades = json.loads(trades_file.read_text()) if trades_file.exists() else []
trade = {
    'id': len(trades) + 1,
    'market_id': market_id,
    'side': side,
    'amount': amount,
    'entry_time': datetime.utcnow().isoformat(),
    'status': 'open'
}
trades.append(trade)

# Atomic write
tmp = trades_file.with_suffix('.tmp')
tmp.write_text(json.dumps(trades, indent=2))
tmp.replace(trades_file)

print(json.dumps(trade))
" <market-id> <side> <amount>
```

Output:

```
📝 PAPER TRADE #7
Market: Will X happen?
Side: YES @ $0.62
Size: $100
Max profit: $61.29 (if resolves YES)
Max loss: $100 (if resolves NO)
Status: OPEN
```

## Rules

- Paper trades only. No real money integration unless explicitly configured.
- All paper trades logged to `~/.openclaw/trader/paper-trades/trades.json`.
- Mention profiles stored in `~/.openclaw/trader/profiles/{person}.json`.
- Atomic writes everywhere: temp file + replace.
- Arbitrage threshold: only flag when YES + NO gap > 2% (account for fees).
- Counter-AI is a thesis trade — always note the contrarian risk.
- Late entry = high risk. Always flag time remaining and liquidity.
- Polymarket CLOB API: public, no auth needed for reads.
- On-chain data for trade history requires RPC endpoint (configured in `~/.openclaw/trader/config.json`).
- Never recommend position sizes > 5% of paper portfolio on any single market.
- Edge or no edge. That's the only question.
