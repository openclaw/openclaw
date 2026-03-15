---
name: trader-wallet
description: Wallet analysis and edge extraction — understand what profitable traders are doing and why.
user-invocable: true
disable-model-invocation: false
triggers:
  - /wallet
  - /analyze
---

# trader-wallet

Wallet analysis for edge extraction. This is NOT copy-trading. The goal is understanding methodology. "What edge are they exploiting?" not "What are they buying?"

**OPUS ONLY** — wallet analysis requires complex pattern extraction. If current model is not Opus, warn and suggest `/model opus` first.

## On `/wallet add [address]`

Add a wallet to the monitoring list.

```bash
python3 -c "
import json, sys, os, pathlib, tempfile
from datetime import datetime

address = sys.argv[1] if len(sys.argv) > 1 else ''
if not address:
    print('Usage: /wallet add <address>')
    exit()

if len(address) < 20:
    print('Invalid address — too short')
    exit()

wallet_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/wallets'))
wallet_dir.mkdir(parents=True, exist_ok=True)

# Load monitoring list
monitor_file = wallet_dir / 'monitor-list.json'
monitors = json.loads(monitor_file.read_text()) if monitor_file.exists() else []

# Check for duplicate
if any(w['address'] == address for w in monitors):
    print(json.dumps({'error': 'already_monitored', 'address': address}))
    exit()

short = address[:6] + '...' + address[-4:]
entry = {
    'address': address,
    'short': short,
    'added': datetime.utcnow().isoformat(),
    'label': '',
    'last_checked': None
}
monitors.append(entry)

# Atomic write
tmp = monitor_file.with_suffix('.tmp')
tmp.write_text(json.dumps(monitors, indent=2))
tmp.replace(monitor_file)

print(json.dumps({'added': short, 'total_monitored': len(monitors)}))
" <address>
```

Output:

```
✅ Wallet added: 0x7a3f...8b2c
Monitoring: 5 wallets total
Run /wallet analyze <address> for full breakdown
```

## On `/wallet analyze [address]`

Full analysis of a wallet's trading history and patterns. **OPUS ONLY.**

```bash
python3 -c "
import json, sys, os, pathlib
from datetime import datetime

address = sys.argv[1] if len(sys.argv) > 1 else ''
if not address:
    print('Usage: /wallet analyze <address>')
    exit()

# Check current model
cfg_path = pathlib.Path(os.path.expanduser('~/.openclaw/openclaw.json'))
if cfg_path.exists():
    cfg = json.loads(cfg_path.read_text())
    model = cfg.get('agents', {}).get('defaults', {}).get('model', '')
    if 'opus' not in model.lower():
        print(json.dumps({'warning': 'opus_recommended', 'current_model': model}))

wallet_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/wallets'))
wallet_dir.mkdir(parents=True, exist_ok=True)
short = address[:6] + '...' + address[-4:]
wallet_file = wallet_dir / f'{address[:8].lower()}-{address[-4:].lower()}.json'

# Load existing analysis or create new
if wallet_file.exists():
    data = json.loads(wallet_file.read_text())
    data['last_analyzed'] = datetime.utcnow().isoformat()
else:
    data = {
        'address': address,
        'short': short,
        'first_analyzed': datetime.utcnow().isoformat(),
        'last_analyzed': datetime.utcnow().isoformat(),
        'trades': [],
        'metrics': {},
        'edge_hypothesis': ''
    }

print(json.dumps(data, default=str))
" <address>
```

Fetch on-chain trade history (Polymarket subgraph or blockchain explorer) and compute:

- Total trades and timespan
- Win rate (resolved trades)
- Average return per trade
- Max drawdown
- Preferred markets (categories, topics)
- Timing patterns (time of day, day of week, how early/late in market lifecycle)
- Position sizing patterns (fixed, Kelly, scaled)
- Hold duration distribution

Output:

```
🔍 WALLET ANALYSIS: 0x7a3f...8b2c
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Period: 2025-06 to 2026-03 (9 months)
Total trades: 142
Win rate: 68% (97W / 45L)
Avg return: +$89/trade
Max drawdown: -$1,240 (Feb cluster)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
PATTERNS:
• Markets: 72% politics, 18% crypto, 10% sports
• Timing: enters 2-4 days before resolution (late entry style)
• Sizing: $200-500 range, scales up on >70% confidence
• Hold: avg 3.2 days, never holds >7 days
• Win streak: max 12 (suspicious — check for info edge)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

Save results:

```bash
python3 -c "
import json, sys, os, pathlib, tempfile

result = json.loads(sys.argv[1])
address = result['address']
wallet_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/wallets'))
wallet_dir.mkdir(parents=True, exist_ok=True)

short_name = f'{address[:8].lower()}-{address[-4:].lower()}'
wallet_file = wallet_dir / f'{short_name}.json'

tmp = wallet_file.with_suffix('.tmp')
tmp.write_text(json.dumps(result, indent=2))
tmp.replace(wallet_file)

print(f'Saved: {short_name}.json')
" '<result_json>'
```

## On `/wallet edge [address]`

Extract the hypothesized edge — what strategy is this wallet exploiting? **OPUS ONLY.**

```bash
python3 -c "
import json, sys, os, pathlib

address = sys.argv[1] if len(sys.argv) > 1 else ''
if not address:
    print('Usage: /wallet edge <address>')
    exit()

wallet_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/wallets'))
short_name = f'{address[:8].lower()}-{address[-4:].lower()}'
wallet_file = wallet_dir / f'{short_name}.json'

if not wallet_file.exists():
    print(f'No analysis found. Run /wallet analyze {address} first.')
    exit()

data = json.loads(wallet_file.read_text())
print(json.dumps(data, default=str))
" <address>
```

From the analysis data, hypothesize the edge:

- **Information edge**: consistently right on binary outcomes → may have insider info or superior research
- **Timing edge**: enters at specific lifecycle points → understands when odds are stale
- **Contrarian edge**: fades consensus → counter-AI or counter-crowd strategy
- **Arbitrage edge**: buys both sides across platforms → structural inefficiency hunter
- **Mention edge**: high win rate on mention markets → has speech pattern models

Output:

```
🧠 EDGE HYPOTHESIS: 0x7a3f...8b2c
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Primary edge: TIMING
Confidence: HIGH

Evidence:
• 84% of entries are 1-3 days before resolution
• Win rate jumps from 55% (early entry) to 78% (late entry)
• Avoids markets until information crystallizes
• Never enters >7 days before resolution

Secondary edge: CATEGORY FOCUS
• 72% politics — likely has domain expertise
• Win rate on politics: 74% vs 52% on other categories

Strategy label: "Late-entry domain specialist"
Replicable: YES — focus on politics, wait for late cycle
Risk: Information asymmetry — they may have sources we don't
```

## On `/wallet track`

Status of all monitored wallets — new trades, P&L changes.

```bash
python3 -c "
import json, os, pathlib
from datetime import datetime

wallet_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/wallets'))
monitor_file = wallet_dir / 'monitor-list.json'

if not monitor_file.exists():
    print('No wallets monitored. Use /wallet add <address> first.')
    exit()

monitors = json.loads(monitor_file.read_text())
status = []
for w in monitors:
    short_name = f\"{w['address'][:8].lower()}-{w['address'][-4:].lower()}\"
    wallet_file = wallet_dir / f'{short_name}.json'
    analysis = json.loads(wallet_file.read_text()) if wallet_file.exists() else None
    status.append({
        'short': w['short'],
        'label': w.get('label', ''),
        'last_checked': w.get('last_checked'),
        'has_analysis': analysis is not None,
        'trades': analysis.get('metrics', {}).get('total_trades', 0) if analysis else 0
    })

print(json.dumps(status))
"
```

Output:

```
📡 WALLET TRACKER
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
0x7a3f...8b2c  "late entry guy"   142 trades  68% WR  ⟳ 2h ago
0x9b2c...4f1a  "arb hunter"        89 trades  71% WR  ⟳ 6h ago
0x3d8e...a7c0  (no analysis)       — run /wallet analyze
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
New activity: 0x7a3f placed 2 new trades (YES on crypto markets)
```

## On `/wallet compare [addr1] [addr2]`

Compare two wallets' strategies side by side.

```bash
python3 -c "
import json, sys, os, pathlib

args = sys.argv[1:]
if len(args) < 2:
    print('Usage: /wallet compare <address1> <address2>')
    exit()

wallet_dir = pathlib.Path(os.path.expanduser('~/.openclaw/trader/wallets'))
results = {}
for addr in args[:2]:
    short_name = f'{addr[:8].lower()}-{addr[-4:].lower()}'
    wallet_file = wallet_dir / f'{short_name}.json'
    if wallet_file.exists():
        results[addr[:6] + '...' + addr[-4:]] = json.loads(wallet_file.read_text())
    else:
        results[addr[:6] + '...' + addr[-4:]] = None

print(json.dumps(results, default=str))
" <addr1> <addr2>
```

Output:

```
📊 COMPARE WALLETS
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Metric          0x7a3f       0x9b2c
Trades          142          89
Win rate        68%          71%
Avg return      +$89         +$124
Max DD          -$1,240      -$680
Edge type       Timing       Arbitrage
Categories      Politics     Cross-market
Hold time       3.2 days     0.4 days
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Different edges, both profitable.
0x9b2c has lower drawdown — more mechanical/systematic.
0x7a3f has higher volume — more discretionary.
```

## Rules

- **OPUS ONLY** for `/wallet analyze` and `/wallet edge`. These require complex pattern recognition.
- If model is not Opus: `⚠️ Wallet analysis needs Opus for pattern extraction. Current model: <model>. Switch with /model opus`
- This is NOT copy-trading. Never output "buy what this wallet buys." Always frame as methodology analysis.
- All wallet data saved to `~/.openclaw/trader/wallets/{address-short}.json`.
- Monitor list in `~/.openclaw/trader/wallets/monitor-list.json`.
- Atomic writes: temp file + replace. Always.
- Never expose full wallet addresses in casual replies — use short form (0x7a3f...8b2c).
- On-chain data fetched via RPC endpoint configured in `~/.openclaw/trader/config.json`.
- Flag suspicious patterns: >80% win rate over 50+ trades = possible insider info. Note it, don't ignore it.
- Max 20 wallets on monitor list. Beyond that, prioritize by edge quality.
- Edge or no edge. That's the only question.
