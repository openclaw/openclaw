#!/usr/bin/env python3
"""
wallet-check.py
Hourly wallet tracker for Moonman cron job.
Reads monitored wallet addresses from ~/.openclaw/trader/wallets/watchlist.json
Checks for new on-chain activity in last 1 hour via Polymarket CLOB API.
Outputs ACTIVITY or QUIET. Writes state to ~/.openclaw/trader/wallets/activity.json

watchlist.json format:
[
  {"alias": "whale_01", "address": "0x...", "chain": "polygon"},
  {"alias": "sharp_02", "address": "0x...", "chain": "polygon"}
]
"""
import json
import pathlib
import urllib.request
from datetime import datetime, timezone, timedelta

WALLET_DIR = pathlib.Path.home() / ".openclaw" / "trader" / "wallets"
WALLET_DIR.mkdir(parents=True, exist_ok=True)
WATCHLIST = WALLET_DIR / "watchlist.json"
ACTIVITY_FILE = WALLET_DIR / "activity.json"

ACTIVITY = []

def load_watchlist():
    if not WATCHLIST.exists():
        # No watchlist yet — create empty template and exit quietly
        WATCHLIST.write_text(json.dumps([
            {"alias": "example_wallet", "address": "0xYOUR_WALLET_HERE", "chain": "polygon"}
        ], indent=2))
        return []
    wallets = json.loads(WATCHLIST.read_text())
    # Filter out placeholder entries
    return [w for w in wallets if not w["address"].startswith("0xYOUR")]

def check_polymarket_wallet(address):
    """
    Fetch recent trades for a wallet via Polymarket CLOB API.
    Returns list of trades in last 1 hour.
    """
    cutoff = datetime.now(timezone.utc) - timedelta(hours=1)
    url = f"https://clob.polymarket.com/trades?maker_address={address}&limit=20"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "bodhi1-moonman/1.0"})
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.loads(r.read())
        trades = data.get("data", [])
        recent = []
        for t in trades:
            ts_str = t.get("matched_time", "")
            try:
                ts = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                if ts > cutoff:
                    recent.append({
                        "time": ts_str,
                        "side": t.get("side", "?"),
                        "size": t.get("size", "?"),
                        "price": t.get("price", "?"),
                        "market": t.get("market", "?")[:60]
                    })
            except Exception:
                pass
        return recent
    except Exception:
        return []

def main():
    wallets = load_watchlist()
    if not wallets:
        print("QUIET")
        return

    for w in wallets:
        trades = check_polymarket_wallet(w["address"])
        if trades:
            ACTIVITY.append({
                "alias": w["alias"],
                "address": w["address"][:10] + "...",
                "trades": trades[:3]  # cap at 3 most recent
            })

    # Write state
    state = {
        "ts": datetime.utcnow().isoformat(),
        "wallets_checked": len(wallets),
        "activity": ACTIVITY
    }
    tmp = ACTIVITY_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(ACTIVITY_FILE)

    if ACTIVITY:
        print("ACTIVITY")
        for a in ACTIVITY:
            print(f"Wallet: {a['alias']} ({a['address']})")
            for t in a["trades"]:
                print(f"  {t['side'].upper()} {t['size']} @ {t['price']} — {t['market']}")
    else:
        print("QUIET")

if __name__ == "__main__":
    main()
