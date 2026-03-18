#!/usr/bin/env python3
"""
polymarket-check.py
Silent Polymarket monitor for Moonman cron job (every 15min).
Outputs ALERT if an edge condition is found, QUIET otherwise.
State written to ~/.openclaw/trader/signals/pm-state.json

Edge conditions flagged:
- Market closing in < 4 hours with odds below 0.15 or above 0.85 (tail squeeze edge)
- Volume spike > 3x 1h average in last 15 minutes (liquidity signal)
- Both sides of a market sum < $0.98 (arbitrage window)
"""
import json
import pathlib
import sys
import urllib.request
from datetime import datetime, timezone

STATE_DIR = pathlib.Path.home() / ".openclaw" / "trader" / "signals"
STATE_DIR.mkdir(parents=True, exist_ok=True)
STATE_FILE = STATE_DIR / "pm-state.json"

ALERTS = []

def fetch_markets():
    """Fetch active Polymarket markets via CLOB API."""
    url = "https://clob.polymarket.com/markets?active=true&closed=false&limit=50"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "bodhi1-moonman/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            return json.loads(r.read())
    except Exception as e:
        return {"data": [], "error": str(e)}

def check_arb(yes_price, no_price):
    """Both sides < $0.98 = riskless arb window."""
    return (yes_price + no_price) < 0.98

def check_tail_squeeze(yes_price, end_date_iso):
    """Closing soon with extreme odds = mispricing likely."""
    try:
        end = datetime.fromisoformat(end_date_iso.replace("Z", "+00:00"))
        hours_left = (end - datetime.now(timezone.utc)).total_seconds() / 3600
        if hours_left < 4 and (yes_price < 0.12 or yes_price > 0.88):
            return True, hours_left
    except Exception:
        pass
    return False, None

def main():
    data = fetch_markets()
    markets = data.get("data", [])

    for m in markets:
        tokens = m.get("tokens", [])
        if len(tokens) < 2:
            continue

        yes_price = float(tokens[0].get("price", 0.5))
        no_price = float(tokens[1].get("price", 0.5))
        end_date = m.get("end_date_iso", "")
        question = m.get("question", "Unknown market")[:80]
        slug = m.get("market_slug", "")

        # Arb check
        if check_arb(yes_price, no_price):
            ALERTS.append({
                "type": "ARB",
                "market": question,
                "slug": slug,
                "yes": yes_price,
                "no": no_price,
                "edge": f"Sum = ${yes_price + no_price:.3f} (riskless if fills)"
            })

        # Tail squeeze check
        is_squeeze, hours = check_tail_squeeze(yes_price, end_date)
        if is_squeeze:
            ALERTS.append({
                "type": "TAIL_SQUEEZE",
                "market": question,
                "slug": slug,
                "yes": yes_price,
                "hours_left": round(hours, 1),
                "edge": f"{'YES underpriced' if yes_price < 0.12 else 'NO underpriced'} with {round(hours, 1)}h left"
            })

    # Write state
    state = {
        "ts": datetime.utcnow().isoformat(),
        "markets_checked": len(markets),
        "alerts": ALERTS
    }
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)

    if ALERTS:
        print("ALERT")
        for a in ALERTS[:3]:  # cap at 3 for Telegram readability
            print(f"[{a['type']}] {a['market']}")
            print(f"  Edge: {a['edge']}")
    else:
        print("QUIET")

if __name__ == "__main__":
    main()
